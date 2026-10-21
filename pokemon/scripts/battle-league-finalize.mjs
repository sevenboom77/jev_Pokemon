import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ROOT } from './battle-env.mjs';
import { auditLeagueBattle, leagueResults } from './battle-league-audit.mjs';

const directory = resolve(ROOT, process.argv[2] ?? 'evidence/league-jev-20261004');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const csv = rows => rows.map(row => row.map(value => '"' + String(value ?? '').replaceAll('"', '""') + '"').join(',')).join('\n') + '\n';
const manifestPath = join(directory, 'manifest.json');
const manifest = read(manifestPath);
if (manifest.status !== 'complete' || manifest.verifiedGames !== 90) throw new Error('The 90-game league is not complete; no final archive can be issued.');
const lock = join(directory, 'monitor.lock');
if (existsSync(lock)) {
  let alive = false;
  try { process.kill(Number(readFileSync(lock, 'utf8')), 0); alive = true; } catch {}
  if (alive) throw new Error('Wait for the league monitor to finish before finalizing evidence.');
}
for (const pair of manifest.pairs) for (const attempt of pair.attempts) for (const game of attempt.games) {
  if (!game.result) throw new Error('Unsettled attempt: ' + game.matchId);
  game.result = auditLeagueBattle(ROOT, game, manifest);
  game.state = game.result.valid ? 'verified' : 'failed';
}
const results = leagueResults(manifest);
if (results.validSelectedGames !== 90 || results.standings.some(m => !m.completeCoverage)) throw new Error('Final evidence audit did not confirm 90 valid games and balanced opponent coverage.');
if (manifest.monitorError) {
  manifest.events.push({ at: new Date().toISOString(), type: 'historical-monitor-error', message: manifest.monitorError });
  delete manifest.monitorError;
}
delete manifest.exhaustedPairs;
manifest.finalAuditedAt = new Date().toISOString();
json(manifestPath, manifest);
json(join(directory, 'results.json'), results);
json(join(directory, 'usage-summary.json'), results.usage);
writeFileSync(join(directory, 'standings.csv'), csv([
  ['model', 'games', 'wins', 'draws', 'losses', 'opponents', 'score', 'rank'],
  ...results.standings.map(m => [m.displayName, m.games, m.wins, m.draws, m.losses, m.opponents, m.score, m.rank]),
]));
const selected = new Set(results.selectedGames.map(g => g.matchId));
const all = manifest.pairs.flatMap(p => p.attempts.flatMap(a => a.games.map(g => ({ ...g, blockId: p.blockId, attempt: a.index }))));
// Provider retries may report tokens that never reach AGH's completed ledger.
// Keep these as original fields; prompt/cache fields can overlap and must not
// be added to the AGH ledger or interpreted as an actual bill.
const providerUsage = { actualCharge: null, note: 'Raw upstream usage fields, including failed requests and retries. Fields may overlap; these are a separate view of the same calls, not extra tokens to add to AGH totals.', scopes: {} };
const numericFields = (value, prefix = '') => Object.entries(value ?? {}).flatMap(([key, item]) => {
  const name = prefix ? prefix + '.' + key : key;
  return typeof item === 'number' && Number.isFinite(item) ? [[name, item]] : item && typeof item === 'object' ? numericFields(item, name) : [];
});
for (const [scope, games] of [['selectedGames', all.filter(g => selected.has(g.matchId))], ['allAttempts', all]]) {
  const models = providerUsage.scopes[scope] = {};
  for (const game of games) {
    const path = join(ROOT, 'runs', game.matchId, 'provider-attempts.jsonl');
    if (!existsSync(path)) continue;
    for (const receipt of readFileSync(path, 'utf8').split('\n').filter(Boolean).map(JSON.parse)) {
      const name = receipt.kind === 'jev' ? 'Jev-1.13.0' : game.result.seats[receipt.seat]?.displayName ?? receipt.model;
      const model = models[name] ??= { attempts: 0, withUsage: 0, withUsageRecoveredFromRaw: 0, missingUsage: 0, retries: 0, errors: 0, rawFields: {} };
      model.attempts++; model.retries += receipt.attempt > 0 ? 1 : 0;
      model.errors += receipt.status == null || receipt.status >= 400 || receipt.providerError ? 1 : 0;
      const usage = receipt.usage ?? (receipt.rawResponseSummary?.finalUsageObserved ? receipt.rawResponseSummary.usage : null);
      if (usage) {
        model.withUsage++; if (!receipt.usage) model.withUsageRecoveredFromRaw++;
        for (const [field, value] of numericFields(usage)) model.rawFields[field] = (model.rawFields[field] ?? 0) + value;
      }
      else model.missingUsage++;
    }
  }
}
json(join(directory, 'provider-usage.json'), providerUsage);
writeFileSync(join(directory, 'provider-usage-fields.csv'), csv([
  ['scope', 'model', 'originalField', 'reportedTotal', 'attempts', 'retries', 'errors', 'missingUsage'],
  ...Object.entries(providerUsage.scopes).flatMap(([scope, models]) => Object.entries(models).flatMap(([name, model]) =>
    Object.entries(model.rawFields).map(([field, value]) => [scope, name, field, value, model.attempts, model.retries, model.errors, model.missingUsage]))),
]));
const index = all.map(game => {
  const r = game.result;
  return { matchId: game.matchId, blockId: game.blockId, attempt: game.attempt, selected: selected.has(game.matchId),
    valid: r.valid, violations: r.violations, protocolDigest: r.protocolDigest, models: game.models,
    winnerModelId: r.winnerModelId, playedTurns: r.playedTurns, elapsedMs: r.elapsedMs, replayUrl: r.replayUrl,
    seats: Object.fromEntries(Object.entries(r.seats).map(([seat, info]) => [seat, {
      displayName: info.displayName, requestModel: info.requestModel, responseModels: info.responseModels,
      sessionId: info.sessionId, sessionUrl: info.sessionUrl, userTasks: info.userTasks,
      taskStarts: info.taskStarts, terminalReason: info.terminalReason, sequenceContinuous: info.sequenceContinuous,
      trajectoryPath: `runs/${game.matchId}/agh-${seat.toLowerCase()}.jsonl`,
    }])), artifacts: r.artifacts };
});
json(join(directory, 'trajectory-index.json'), index);
writeFileSync(join(directory, 'trajectory-index.csv'), csv([
  ['matchId', 'pair', 'attempt', 'selected', 'valid', 'modelA', 'modelB', 'winner', 'turns', 'seconds', 'sessionA', 'sessionB', 'replay', 'violations'],
  ...index.map(g => [g.matchId, g.blockId, g.attempt, g.selected, g.valid, g.seats.A.displayName, g.seats.B.displayName,
    g.winnerModelId, g.playedTurns, g.elapsedMs / 1000, g.seats.A.sessionUrl, g.seats.B.sessionUrl, g.replayUrl, g.violations.join(';')]),
]));
const tokenRows = [['scope', 'model', 'seatGames', 'ledgerCalls', 'input', 'cacheRead', 'cacheWrite', 'output', 'missingUsage', 'actualCharge']];
for (const [scope, usage] of Object.entries(results.usage)) {
  for (const model of Object.values(usage.models)) tokenRows.push([scope, model.displayName, model.games, model.ledgerCalls,
    model.input, model.cacheRead, model.cacheWrite, model.output, JSON.stringify(model.missingTokenFields), 'unknown']);
  tokenRows.push([scope, 'Jev-1.13.0', '', usage.jev.calls, usage.jev.input, '', '', usage.jev.output,
    JSON.stringify({ input: usage.jev.missingInput, output: usage.jev.missingOutput }), 'unknown']);
}
writeFileSync(join(directory, 'tokens-by-model.csv'), csv(tokenRows));
copyFileSync(join(ROOT, manifest.priceSheet), join(directory, 'price-sheet.json'));
const sourceDirectory = join(directory, 'source');
mkdirSync(sourceDirectory, { recursive: true });
const sourceFiles = [...new Set([...Object.keys(manifest.sourceHashes), ...Object.keys(manifest.runtimeRepairSourceHashes ?? {}),
  'scripts/battle-league-finalize.mjs', 'scripts/battle-history.mjs', 'scripts/battle-extra-models.mjs',
  'scripts/battle-resources.ts', 'scripts/battle-session.ts', 'scripts/agh-env.mjs',
  'packages/jev-client/index.mjs', 'packages/battle-web/model-names.js', 'package.json',
  'tests/battle-transport.test.mjs', 'tests/battle-scheduler.test.mjs', 'tests/battle-request-pool.test.mjs',
  'scripts/battle-runtime-recovery.mjs', 'scripts/battle-runtime-recovery.test.mjs',
  'packages/battle-arena/network.mjs', 'tests/battle-network.test.mjs', 'package-lock.json',
  'tests/battle-response-diagnostics.test.mjs',
  'scripts/battle-daemon-recovery.mjs', 'scripts/battle-daemon-diagnostics.mjs', 'tests/battle-daemon-recovery.test.mjs',
  ...readdirSync(join(ROOT, 'packages/battle-arena')).filter(name => /-repair-20261004\.mjs$/.test(name)).map(name => 'packages/battle-arena/' + name),
])];
for (const file of sourceFiles) {
  const target = join(sourceDirectory, file); mkdirSync(resolve(target, '..'), { recursive: true });
  copyFileSync(join(ROOT, file), target);
}
json(join(directory, 'runtime-environment.json'), { node: process.version,
  battleRuntime: Object.fromEntries(['agnes.mjs', 'worker.mjs', 'daemon.mjs'].map(name => [name, hash(join(ROOT, '.runtime/battle-agh-runtime', name))])),
  piAi: read(join(ROOT, '../agnes-harness/packages/ai/node_modules/@earendil-works/pi-ai/package.json')).version,
  pokemonShowdown: read(join(ROOT, 'node_modules/pokemon-showdown/package.json')).version,
  runtimeChanges: 'Chronological repairs, limits and bundle changes are preserved in manifest.json, runtime-repairs.jsonl and runtime-recovery-patch.json.' });
const names = ['manifest.json', 'protocol.json', 'protocol-v2.json', 'results.json', 'standings.csv', 'usage-summary.json',
  'trajectory-index.json', 'trajectory-index.csv', 'tokens-by-model.csv', 'price-sheet.json',
  'provider-usage.json', 'provider-usage-fields.csv',
  'runtime-repairs.jsonl', 'runtime-recovery-patch.json', 'runtime-request-timeout-patch.json', 'runtime-environment.json',
  'repair-plan.json', 'transport-diagnostic-errors.jsonl', 'transport-sdk-check.txt'];
names.push('blocked-quota.json', 'provider-quota-check.json', 'automation-handoff.json', 'usage-checkpoint.json');
names.push('provider-key-rotation-20261004.json', 'resume-preflight-20261004.json', 'gateway-auth-enablement-20261004.json');
names.push('retry-20261004-a4-plan.json', 'retry-20261004-a4-runtime.json', 'retry-20261004-a4-checkpoint.json');
names.push('remainder-repair-20261005.json', 'remainder-preflight-20261005.json', 'remainder-runtime-20261005.json');
names.push('recovered-histories-20261005.json');
names.push('remainder-existing-results-audit-20261005.json', 'remainder-daemon-repair-20261005.json', 'remainder-a6-preflight-20261005.json', 'remainder-a6-runtime-20261005.json');
names.push('remainder-a6-gate-20261005.json', 'remainder-sleep-diagnostic-20261005.json');
names.push('remainder-credential-precheck-20261005.json');
names.push('remainder-a6-parallel-20261005.json');
names.push('qwen-budget-probe.json', 'qwen-budget-continuation-proof.json', 'agnes-dns-proof.json', 'dns-resolutions.jsonl');
const diagnostics = join(ROOT, '.runtime/battle-provider-replay/transport-errors.jsonl');
if (existsSync(diagnostics)) {
  const records = readFileSync(diagnostics, 'utf8').split('\n').filter(Boolean).filter(line => JSON.parse(line).at >= manifest.createdAt);
  writeFileSync(join(directory, 'transport-diagnostic-errors.jsonl'), records.join('\n') + (records.length ? '\n' : ''), { mode: 0o600 });
}
const dnsRecords = join(ROOT, '.runtime/battle-provider-replay/dns-resolutions.jsonl');
if (existsSync(dnsRecords)) copyFileSync(dnsRecords, join(directory, 'dns-resolutions.jsonl'));
const files = names.filter(name => existsSync(join(directory, name))).map(name => join(directory, name));
for (const file of sourceFiles) files.push(join(sourceDirectory, file));
const runFiles = ['battle.json', 'agh-a.jsonl', 'agh-b.jsonl', 'usage-ledger.jsonl', 'provider-attempts.jsonl',
  'agh-a-invocation.json', 'agh-b-invocation.json'];
for (const game of all) for (const name of runFiles) {
  const file = join(ROOT, 'runs', game.matchId, name);
  if (existsSync(file)) files.push(file);
}
for (const game of all) for (const name of readdirSync(join(ROOT, 'runs', game.matchId))) {
  if (/^malformed-native-[ab]-[0-9a-f]{12}\.sse$/.test(name)) files.push(join(ROOT, 'runs', game.matchId, name));
}
const completed = results.selectedGames;
const meanTurns = completed.reduce((sum, g) => sum + g.result.playedTurns, 0) / completed.length;
const readme = [
  '# 带 Jev 宝可梦联赛', '',
  `已核验 ${completed.length} 场有效对局、180 份完整 AGH 会话轨迹。10 个模型，45 组配对，每组换边两场。`, '',
  '每方只有一次整局用户任务，模型自行观察、调用真实 Jev、决策和等待下一回合。40 回合未分胜负由引擎结算平局，双方仍须正常完成任务。技术失败不算模型败局。', '',
  `并发峰值 ${manifest.peakRunning} 场。所有 ${all.length} 场实际尝试均保留，包含未选入榜单的预检、失败和补跑。平均有效对局 ${meanTurns.toFixed(2)} 回合。`, '',
  'protocol.json 保留初始 40 分钟整局时限；protocol-v2.json 把后续尝试的时限放宽至 2 小时。提示、模型、Jev、固定队伍和种子、40 回合上限均不变。每场所用协议摘要可在索引和原始 battle.json 中查到。', '',
  'trajectory-index.csv / .json 列出每场双方模型、会话入口、回放入口和是否计分。runs 中的 agh-a.jsonl、agh-b.jsonl 是原始有序事件，battle.json 含引擎状态、行动和 Jev 评估。失败会话按实际状态保留。', '',
  'usage-summary.json 和 tokens-by-model.csv 分别汇总榜单选中对局及全部尝试；usage-ledger.jsonl 保留逐调用记录，provider-attempts.jsonl 保留网关重试。缺失用量和中断不能视为零费用。price-sheet.json 为官方参考价，实际渠道账单尚未知。', '',
  'provider-usage.json 和 provider-usage-fields.csv 另按模型汇总网关原样报告的用量字段，包含失败请求及重试。它们与 AGH 用量是同一批调用的不同视图，输入和缓存字段也可能重叠，不能直接相加当作账单。', '',
  '异常原生响应的原文在开始启用诊断记录后保存为 malformed-native-*.sse；早期异常没有原文时按缺失标记，不作还原。只有原始终止帧确实报告的用量才纳入异常响应的用量汇总。', '',
  '模型请求名和网关回执名均有保留。Gemini-3.8-Flash-High 的回执标识为 gemini-3.8-flash-n，这一映射尚未独立证实；榜单比较的是本次请求配置。', '',
  '本次只执行带 Jev 组，未启动不带 Jev 组。归档使用文件白名单，未包含模型密钥或 AGH 凭据目录。', '',
].join('\n');
writeFileSync(join(directory, 'README.md'), readme);
files.push(join(directory, 'README.md'));
const hashes = Object.fromEntries(files.map(file => [relative(ROOT, file), hash(file)]));
json(join(directory, 'artifact-hashes.json'), hashes); files.push(join(directory, 'artifact-hashes.json'));
const list = join(directory, 'archive-files.txt');
writeFileSync(list, files.map(file => relative(ROOT, file)).join('\n') + '\n', { mode: 0o600 });
const secrets = new Set();
const credentialValues = object => {
  for (const [key, value] of Object.entries(object ?? {})) {
    if (typeof value === 'string' && /^(key|value|apiKey|api_key|token|password|secret)$/i.test(key) && value.length >= 16 && !/^https?:/.test(value)) secrets.add(value);
    else if (value && typeof value === 'object') credentialValues(value);
  }
};
const inspectCredentialDirectory = path => {
  if (!existsSync(path)) return;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) inspectCredentialDirectory(file);
    else if (entry.isFile()) { try { credentialValues(read(file)); } catch {} }
  }
};
for (const path of ['.runtime/model-credentials', '.runtime/credential-backups', '.runtime/battle-agh-a/secrets', '.runtime/battle-agh-b/secrets']) inspectCredentialDirectory(join(ROOT, path));
for (const seat of ['a', 'b']) {
  const path = join(ROOT, '.runtime/battle-agh-' + seat, 'battle-binding.json');
  if (existsSync(path)) credentialValues(read(path));
}
if (existsSync(join(ROOT, '.env.local'))) for (const line of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) {
  const match = /^(?:export\s+)?[A-Z_]*(?:KEY|TOKEN|SECRET)\s*=\s*(.+)$/.exec(line);
  if (match) { const value = match[1].replace(/^['"]|['"]$/g, ''); if (value.length >= 16) secrets.add(value); }
}
for (const file of files) {
  const bytes = readFileSync(file);
  if ([...secrets].some(secret => bytes.includes(Buffer.from(secret)))) throw new Error('Credential value found in archive artifact: ' + relative(ROOT, file));
}
const archive = join(directory, 'trajectories.tar.gz');
const tar = spawnSync('tar', ['-czf', archive, '-C', ROOT, '-T', list], {
  encoding: 'utf8', env: { ...process.env, COPYFILE_DISABLE: '1' },
});
if (tar.status !== 0) throw new Error(tar.stderr || 'Archive failed.');
json(join(directory, 'archive.json'), { archive, sha256: hash(archive), files: files.length, validGames: 90, credentialValuesMatched: false,
  validSeatTrajectories: 180, allAttemptGames: all.length, createdAt: new Date().toISOString() });
console.log(JSON.stringify({ complete: true, validGames: 90, attempts: all.length, meanTurns,
  tokens: results.usage.allAttempts.totalReportedTokens, archive, sha256: hash(archive) }));
