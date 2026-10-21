import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { ROOT } from './battle-env.mjs';

const read = file => JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
const hash = file => createHash('sha256').update(readFileSync(file.startsWith('/') ? file : join(ROOT, file))).digest('hex');
const pilots = ['evidence/model-mini-series-20261003.json', 'evidence/model-mini-series-repair-20261003.json'].map(read);
assert(pilots.every(p => p.status === 'complete'), 'All bounded attempts must terminate before reporting.');
const attempts = pilots.flatMap(p => p.matches).map(saved => {
  const battle = read('runs/' + saved.id + '/battle.json');
  const seats = {};
  for (const seat of ['A', 'B']) {
    const events = readFileSync(join(ROOT, 'runs', battle.id, 'agh-' + seat.toLowerCase() + '.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const ledger = events.filter(e => e.type === 'cost/ledger' && e.data.purpose === 'inference').map(e => e.data);
    const tools = events.filter(e => e.type === 'tool/call').map(e => e.data.name);
    seats[seat] = {
      sessionId: battle.sessions[seat], model: battle.models[seat].model, api: battle.models[seat].api,
      userTasks: events.filter(e => e.type === 'user/message' && e.data.kind !== 'runtime_context').length,
      taskStarts: events.filter(e => e.type === 'turn/start').length,
      terminalReason: events.filter(e => e.type === 'turn/end').at(-1)?.data.reason,
      terminalError: events.filter(e => e.type === 'turn/end').at(-1)?.data.error ?? null,
      compactions: events.filter(e => e.type === 'assistant/message' && e.surfaceOp?.op === 'replace').length,
      blankAssistantTextBlocks: events.filter(e => e.type === 'assistant/message').flatMap(e => e.data.content).filter(b => b.type === 'text' && b.text.trim().length === 0).length,
      toolCounts: Object.fromEntries([...new Set(tools)].map(tool => [tool, tools.filter(t => t === tool).length])),
      responseModels: [...new Set(ledger.map(e => e.response?.model).filter(Boolean))],
      observedInferenceHttp200: ledger.filter(e => e.response?.status === 200).length,
      observedInferenceHttpFailures: ledger.filter(e => e.response?.status >= 400).length,
      acceptedActions: battle.decisions.filter(d => d.seat === seat).length,
      jevCalls: battle.traces.filter(t => t.type === 'jev' && t.seat === seat).length,
    };
    assert.equal(seats[seat].userTasks, 1); assert.equal(seats[seat].taskStarts, 1); assert.equal(battle.counts[seat], 1);
  }
  const engineTerminal = battle.publicLog.filter(line => line.startsWith('|win|') || line === '|tie|').at(-1) ?? null;
  const verified = battle.status === 'finished' && Object.values(seats).every(s => s.terminalReason === 'completed');
  assert.equal(battle.autonomousTaskVerified, verified);
  assert.equal(battle.jevEnabled, true); assert.deepEqual(battle.seed, [10, 3, 20, 26]);
  if (verified) assert.equal(engineTerminal, battle.winner ? '|win|' + battle.playerNames[battle.winner] : '|tie|');
  else assert.equal(engineTerminal, null);
  return { id: battle.id, status: battle.status, winner: battle.winner, winningModel: battle.winner ? battle.models[battle.winner].model : null,
    engineTerminal, models: battle.models, seats, turns: battle.turn, acceptedActions: battle.decisions.length,
    jevCalls: battle.traces.filter(t => t.type === 'jev').length, elapsedMs: battle.elapsedMs,
    autonomousTaskVerified: verified, error: battle.error,
    artifactHashes: Object.fromEntries(['battle.json', 'agh-a.jsonl', 'agh-b.jsonl'].map(file => [file, hash('runs/' + battle.id + '/' + file)])),
  };
});
const historicalPreservation = {};
for (const evidence of ['evidence/long-task-before-20261003.json', 'evidence/battle-e2e-20261003.json']) {
  const ref = read(evidence);
  for (const [file, expected] of Object.entries(ref.hashes ?? ref.artifactHashes)) {
    if (!file.startsWith('runs/') && !file.startsWith('/')) continue;
    historicalPreservation[file] = hash(file) === expected; assert(historicalPreservation[file], 'Historical record changed: ' + file);
  }
}
const report = { at: new Date().toISOString(), attempted: attempts.length,
  naturallyFinished: attempts.filter(a => a.autonomousTaskVerified).length,
  technicalAborts: attempts.filter(a => a.status === 'aborted').length,
  seed: [10, 3, 20, 26], jevEnabled: true, teams: read('runs/' + attempts[0].id + '/battle.json').teams,
  scope: 'One completed reciprocal Gemini/GPT pairing and one incomplete Opus/DeepSeek pairing. Three original integration failures and one subsequent Opus rate-limit abort are retained; this is not a ranking or win-rate estimate.',
  models: read('evidence/model-probes-20261003.json').reports,
  opusChat: read('evidence/model-opus-chat-probe-20261003.json'), localTests: { passed: 18, failed: 0 },
  sourceHashes: Object.fromEntries(['scripts/battle-env.mjs', 'packages/battle-arena/model-selection.mjs',
    'packages/battle-arena/server.mjs', 'packages/battle-arena/runner.mjs', 'packages/battle-arena/match.mjs',
    'packages/battle-arena/deepseek-transport.mjs', 'packages/agh-battle-plugin/index.mjs', 'packages/battle-web/app.js'].map(file => [file, hash(file)])),
  ...(existsSync(join(ROOT, 'evidence/model-battle-render-20261003.json')) ? { rendering: read('evidence/model-battle-render-20261003.json') } : {}),
  attempts, historicalPreservation,
  pricing: 'Catalog zero prices are placeholders; actual monetary cost is not established.',
};
writeFileSync(join(ROOT, 'evidence/model-battles-20261003.json'), JSON.stringify(report, null, 2) + '\n');
let markdown = '# 多模型换边试跑记录\n\n2026-10-03。共 ' + report.attempted + ' 次真实尝试，' + report.naturallyFinished + ' 局自然结束，' + report.technicalAborts + ' 次技术中止。双方均使用 Jev、固定座位队伍和固定种子；每方每局只收到一次整局 AGH 用户任务。\n\n';
markdown += '| A 方 | B 方 | 结果 | 回合 | 行动 / Jev | 耗时 | 回放 |\n| --- | --- | --- | ---: | ---: | ---: | --- |\n';
for (const a of attempts) markdown += `| ${a.models.A.label} | ${a.models.B.label} | ${a.winningModel ? a.models[a.winner].label + '（' + a.winner + '）获胜' : a.autonomousTaskVerified ? '平局' : '技术中止'} | ${a.turns} | ${a.acceptedActions} / ${a.jevCalls} | ${(a.elapsedMs / 60000).toFixed(1)} 分钟 | [${a.id}](http://127.0.0.1:8795/?match=${a.id}&replay=1) |\n`;
markdown += '\n所有自然结束的对局均由引擎判胜，并通过双方日志的单次用户输入、单次任务启动及正常完成核对。技术中止不计输赢，原始失败记录保留。\n\n';
markdown += '请求型号：Gemini `gemini-3.8-flash-high`（实际响应 `gemini-3.8-flash-n`）、GPT `gpt-5.6-terra-bingxing`、Opus `claude-opus-5-5-high`、DeepSeek `deepseek-flash`。这些名称来自用户网关，不作为官方版本或排名证明。Opus 的两次原生接口试跑在 AGH 自动压缩历史后中止；补跑双方统一使用同一型号的 Chat 接口。GPT 的空白块兼容问题已修复，补跑中三个真实空白文本块均正常继续。最后的 Opus 反向局收到两次上游 429 限流响应并中止，因此 Opus/DeepSeek 的成功换边对照尚未齐全。\n\n';
markdown += '## 完整 AGH 会话\n\n';
for (const a of attempts.filter(a => a.autonomousTaskVerified)) {
  markdown += `- ${a.id}：[A / ${a.models.A.label}](http://127.0.0.1:4181/?session=${encodeURIComponent(a.seats.A.sessionId)}) · [B / ${a.models.B.label}](http://127.0.0.1:4182/?session=${encodeURIComponent(a.seats.B.sessionId)})。\n`;
}
markdown += '\n两套队伍按座位固定，交换模型座位可观察队伍影响；少量固定种子对局不能估计稳定胜率。完整数值、响应型号、压缩次数、历史文件哈希和旧记录保留核对见同名 JSON。原始模型推理与凭据留在本机。\n';
writeFileSync(join(ROOT, 'evidence/model-battles-20261003.md'), markdown);
console.log(JSON.stringify({ attempted: report.attempted, naturallyFinished: report.naturallyFinished, technicalAborts: report.technicalAborts }));
