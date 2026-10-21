import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const eventsAt = path => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function auditLeagueBattle(root, game, manifest) {
  const directory = join(root, 'runs', game.matchId), battle = read(join(directory, 'battle.json'));
  const providerAttempts = eventsAt(join(directory, 'provider-attempts.jsonl'));
  const violations = [], seats = {}, usage = [];
  if (battle.status !== 'finished' || !battle.autonomousTaskVerified) violations.push('incomplete-AGH-task');
  const protocol = battle.league?.protocolDigest === manifest.protocolDigest ? manifest.protocol
    : manifest.protocolHistory?.find(p=>p.digest === battle.league?.protocolDigest)?.protocol;
  if (!battle.jevEnabled || !protocol) violations.push('protocol-mismatch');
  if (JSON.stringify(battle.seed) !== JSON.stringify((protocol ?? manifest.protocol).fixture.seed)) violations.push('seed-mismatch');
  if (battle.executionBudget?.maxTurns !== (protocol ?? manifest.protocol).maxTurns || battle.executionBudget?.timeoutMs !== (protocol ?? manifest.protocol).timeoutMs) violations.push('execution-budget-mismatch');
  for (const seat of ['A', 'B']) {
    const expected = manifest.models.find(m => m.id === game.models[seat]);
    const events = eventsAt(join(directory, `agh-${seat.toLowerCase()}.jsonl`));
    const toolCalls = events.filter(e => e.type === 'tool/call'), ledger = events.filter(e => e.type === 'cost/ledger');
    const jev = battle.traces.filter(t => t.type === 'jev' && t.seat === seat);
    const terminal = events.filter(e => e.type === 'turn/end').at(-1)?.data;
    seats[seat] = { modelId: expected.id, displayName: expected.displayName, requestModel: battle.models[seat].model,
      responseModels: [...new Set([...ledger.map(e => e.data.response?.model), ...providerAttempts.filter(p => p.kind === 'main-model' && p.seat === seat).map(p => p.reportedModel)].filter(Boolean))], sessionId: battle.sessions[seat],
      sessionUrl: `http://127.0.0.1:${seat === 'A' ? 4181 : 4182}/?session=${encodeURIComponent(battle.sessions[seat])}`,
      events: events.length, userTasks: events.filter(e => e.type === 'user/message' && e.data.kind !== 'runtime_context').length,
      taskStarts: events.filter(e => e.type === 'turn/start').length, terminalReason: terminal?.reason,
      terminalError: terminal?.error ?? null, sequenceContinuous: events.length > 0 && events.every((e, i) => e.seq === i + 1),
      startedAt: events.find(e => e.type === 'turn/start')?.ts, endedAt: events.filter(e => e.type === 'turn/end').at(-1)?.ts,
      toolCalls: toolCalls.length, jevCalls: jev.length,
      ledgerCalls: ledger.length, interruptedLedgerCalls: ledger.filter(e => e.data.interrupted).length,
      mainTokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, missingTokenFields: {} };
    const info = seats[seat];
    if (info.requestModel !== expected.requestModel || battle.models[seat].route !== expected.route || battle.models[seat].maxTokens !== 8192) violations.push(seat + '-model-or-budget-mismatch');
    const mainAttempts = providerAttempts.filter(p => p.kind === 'main-model' && p.seat === seat && p.status === 200);
    if (expected.api === 'openai-completions' && (!mainAttempts.length || mainAttempts.some(p => !Number.isInteger(p.wireMaxTokens) || p.wireMaxTokens < 1 || p.wireMaxTokens > 8192))) violations.push(seat + '-wire-output-cap-not-enforced');
    if (mainAttempts.some(p => typeof p.wireMaxTokens === 'number' && p.wireMaxTokens > 8192)) violations.push(seat + '-wire-output-cap-exceeded');
    if (ledger.some(e => e.data.tokens?.output > 8192)) violations.push(seat + '-response-output-cap-exceeded');
    if (info.userTasks !== 1 || info.taskStarts !== 1 || info.terminalReason !== 'completed' || !info.sequenceContinuous || !info.jevCalls) violations.push(seat + '-history-or-Jev-invalid');
    for (const event of ledger) {
      usage.push({ matchId: battle.id, seat, modelId: expected.id, eventId: event.id, seq: event.seq, at: event.ts, ...event.data, actualCharge: null });
      for (const key of Object.keys(info.mainTokens)) {
        const value = event.data.tokens?.[key];
        if (typeof value === 'number') info.mainTokens[key] += value;
        else info.missingTokenFields[key] = (info.missingTokenFields[key] ?? 0) + 1;
      }
    }
    for (const trace of jev) usage.push({ matchId: battle.id, seat, modelId: 'jev', purpose: 'jev', at: trace.at, decisionId: trace.decisionId, usage: trace.usage, actualCharge: null });
  }
  writeFileSync(join(directory, 'usage-ledger.jsonl'), usage.map(e => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
  const files = ['battle.json', 'agh-a.jsonl', 'agh-b.jsonl', 'usage-ledger.jsonl', 'provider-attempts.jsonl'].filter(f => existsSync(join(directory, f)));
  const jevTraces = battle.traces.filter(t => t.type === 'jev');
  const jevReceipts = new Set(providerAttempts.filter(p => p.kind === 'jev' && p.status === 200)
    .map(p => p.seat + ':' + p.decisionId));
  if (jevTraces.some(t => t.offline !== false || t.model !== 'jev-1.13.0' || !jevReceipts.has(t.seat + ':' + t.decisionId))) {
    violations.push('real-Jev-receipt-missing-or-model-mismatch');
  }
  const jevTokens = { input: 0, output: 0, missingInput: 0, missingOutput: 0 };
  for (const trace of jevTraces) for (const [key, field, missing] of [['input','input_tokens','missingInput'],['output','output_tokens','missingOutput']]) {
    if (typeof trace.usage?.[field] === 'number') jevTokens[key] += trace.usage[field];
    else jevTokens[missing]++;
  }
  return { valid: violations.length === 0, violations, matchId: battle.id, protocolDigest: battle.league?.protocolDigest, winner: battle.winner,
    winnerModelId: battle.winner ? game.models[battle.winner] : null, turn: battle.turn,
    playedTurns: battle.settlementReason === 'turn-limit-draw' ? 40 : battle.turn,
    settlementReason: battle.settlementReason, status: battle.status, error: battle.error,
    elapsedMs: battle.elapsedMs, seats, jevCalls: jevTraces.length, jevTokens,
    requestAttempts: { total: providerAttempts.length, rateLimited: providerAttempts.filter(p => p.status === 429).length,
      interrupted: providerAttempts.filter(p => p.status === null).length, usageMissing: providerAttempts.filter(p => p.usageMissing).length },
    replayUrl: `http://127.0.0.1:8795/?match=${battle.id}&replay=1`,
    artifacts: Object.fromEntries(files.map(f => [f, { path: join(directory, f), sha256: createHash('sha256').update(readFileSync(join(directory, f))).digest('hex') }])) };
}

export function summarizeLeagueUsage(games) {
  const models = {}, jev = { calls: 0, input: 0, output: 0, missingInput: 0, missingOutput: 0 };
  const attempts = { total: 0, rateLimited: 0, interrupted: 0, usageMissing: 0 };
  for (const game of games) {
    const result = game.result;
    if (!result) continue;
    for (const info of Object.values(result.seats ?? {})) {
      const model = models[info.modelId] ??= { displayName: info.displayName, games: 0, ledgerCalls: 0, interruptedLedgerCalls: 0,
        input: 0, cacheRead: 0, cacheWrite: 0, output: 0, missingTokenFields: {} };
      model.games++; model.ledgerCalls += info.ledgerCalls ?? 0; model.interruptedLedgerCalls += info.interruptedLedgerCalls ?? 0;
      for (const key of ['input','cacheRead','cacheWrite','output']) model[key] += info.mainTokens[key];
      for (const [key, count] of Object.entries(info.missingTokenFields)) model.missingTokenFields[key] = (model.missingTokenFields[key] ?? 0) + count;
    }
    jev.calls += result.jevCalls ?? 0;
    for (const key of ['input','output','missingInput','missingOutput']) jev[key] += result.jevTokens?.[key] ?? (key.startsWith('missing') ? result.jevCalls ?? 0 : 0);
    for (const key of Object.keys(attempts)) attempts[key] += result.requestAttempts?.[key] ?? 0;
  }
  const main = Object.fromEntries(['input','cacheRead','cacheWrite','output'].map(key => [key, Object.values(models).reduce((sum,m)=>sum+m[key],0)]));
  return { gamesWithTerminalEvidence: games.filter(g=>g.result).length, models, main, jev, requestAttempts: attempts,
    totalReportedTokens: Object.values(main).reduce((a,b)=>a+b,0) + jev.input + jev.output, actualCharge: null,
    coverage: 'AGH inference and compaction ledgers plus successful Jev traces. Missing usage, interrupted requests and provider retries remain in raw attempt files; recorded zero is not proof of zero charge.' };
}

export function leagueResults(manifest) {
  const selected = manifest.pairs.flatMap(pair => {
    const attempt = pair.attempts.find(a => a.games.length === 2 && a.games.every(g => g.result?.valid));
    return attempt ? attempt.games : [];
  });
  const standings = manifest.models.map(model => {
    const games = selected.filter(g => Object.values(g.models).includes(model.id));
    const points = games.reduce((sum, g) => sum + (g.result.winnerModelId === model.id ? 1 : g.result.winnerModelId === null ? .5 : 0), 0);
    const opponents = new Set(games.map(g => Object.values(g.models).find(id => id !== model.id)));
    return { modelId: model.id, displayName: model.displayName, games: games.length,
      wins: games.filter(g => g.result.winnerModelId === model.id).length,
      draws: games.filter(g => g.result.winnerModelId === null).length,
      losses: games.filter(g => g.result.winnerModelId !== null && g.result.winnerModelId !== model.id).length,
      opponents: opponents.size, score: games.length ? points / games.length * 100 : null,
      rank: null, completeCoverage: games.length === 18 && opponents.size === 9 };
  });
  if (selected.length === 90) {
    standings.sort((a, b) => b.score - a.score);
    standings.forEach((m, i) => { m.rank = i && m.score === standings[i - 1].score ? standings[i - 1].rank : i + 1; });
  }
  return { mode: 'with-jev', expectedGames: 90, validSelectedGames: selected.length,
    status: selected.length === 90 ? 'complete' : 'in-progress-no-full-ranking', standings,
    selectedGames: selected, allAttempts: manifest.pairs.flatMap(p => p.attempts), actualCharge: null,
    usage: { selectedGames: summarizeLeagueUsage(selected), allAttempts: summarizeLeagueUsage(manifest.pairs.flatMap(p=>p.attempts.flatMap(a=>a.games))) },
    identityCaveat: 'Gateway response identifiers are retained. Gemini High-to-n mapping is unresolved; this ranks requested configurations, not independently authenticated weights.' };
}
