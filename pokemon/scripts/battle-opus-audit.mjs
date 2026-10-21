import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BattleMatch } from '../packages/battle-arena/match.mjs';

const root = process.cwd();
const directory = join(root, 'evidence/league-jev-20261004');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const manifest = read(join(directory, 'manifest.json'));
const results = read(join(directory, 'results.json'));
const games = results.selectedGames.filter(g => Object.values(g.models).includes('opus'));
const lines = path => readFileSync(path, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const withoutClock = log => log.filter(line => !line.startsWith('|t:|'));

async function replay(battle, change) {
  // This uses only the deterministic local simulator. No player tasks or Jev
  // calls are started, and none of the original trajectory files are modified.
  const match = new BattleMatch({ id: 'battle-offline-' + battle.id, teams: manifest.protocol.fixture.teams,
    seed: battle.seed, jev: false, playerNames: battle.playerNames });
  try {
    await match.start();
    for (const d of battle.decisions) {
      if (match.finished) break;
      const label = change?.(d) ?? d.label;
      const candidate = match.candidates(d.seat).find(c => c.label === label);
      if (!candidate) throw new Error(`Replay candidate missing: ${battle.id} ${d.seat} ${d.turn} ${label}`);
      await match.act(d.seat, { decisionId: match.requests[d.seat].id, candidateId: candidate.id, explanation: 'Local forensic replay' });
    }
    return { winner: match.winner, turn: match.turn, finished: match.finished,
      publicLog: [...match.publicLog], exactPublicReplay: JSON.stringify(withoutClock(match.publicLog)) === JSON.stringify(withoutClock(battle.publicLog)) };
  } finally { await match.close(); }
}

const byModel = manifest.models.map(model => {
  const selected = results.selectedGames.filter(g => Object.values(g.models).includes(model.id));
  let evaluated = 0, followed = 0, thinkingBlocks = 0, requestCalls = 0, requestsWithThinkingParameter = 0;
  let voluntarySwitches = 0, truncatedCalls = 0;
  const ownMoves = {};
  for (const g of selected) {
    const seat = Object.keys(g.models).find(s => g.models[s] === model.id);
    const dir = join(root, 'runs', g.matchId), b = read(join(dir, 'battle.json'));
    const evaluations = new Map(b.traces.filter(t => t.type === 'jev' && t.seat === seat).map(t => [t.decisionId, t]));
    for (const d of b.decisions.filter(d => d.seat === seat)) {
      if (evaluations.has(d.decisionId)) { evaluated++; followed += d.candidateId === evaluations.get(d.decisionId).selectedCandidateId ? 1 : 0; }
      if (d.switchReason === 'voluntary') voluntarySwitches++;
      if (d.kind === 'move') ownMoves[d.label] = (ownMoves[d.label] ?? 0) + 1;
    }
    for (const e of lines(join(dir, `agh-${seat.toLowerCase()}.jsonl`))) {
      if (e.type === 'assistant/message') thinkingBlocks += e.data.content.filter(c => c.type === 'thinking' || c.type === 'redacted_thinking').length;
    }
    for (const p of lines(join(dir, 'provider-attempts.jsonl')).filter(p => p.kind === 'main-model' && p.seat === seat)) {
      requestCalls++; requestsWithThinkingParameter += p.wireThinkingType != null ? 1 : 0;
      truncatedCalls += (p.rawStopReasons ?? []).some(reason => ['max_tokens', 'length'].includes(reason)) ? 1 : 0;
    }
  }
  return { model: model.displayName, selectedGames: selected.length, seats: Object.fromEntries(['A', 'B'].map(seat => [seat, {
    games: selected.filter(g => g.models[seat] === model.id).length,
    wins: selected.filter(g => g.models[seat] === model.id && g.result.winner === seat).length,
  }])), evaluated, followed, followRate: evaluated ? followed / evaluated : null,
  thinkingBlocks, requestCalls, requestsWithThinkingParameter, voluntarySwitches, truncatedCalls, ownMoves };
});
const baselines = [];
for (const game of games) {
  const battle = read(join(root, 'runs', game.matchId, 'battle.json'));
  const baseline = await replay(battle);
  baselines.push({ matchId: game.matchId, originalWinner: battle.winner,
    winner: baseline.winner, turn: baseline.turn, finished: baseline.finished, exactPublicReplay: baseline.exactPublicReplay });
}
const targetId = 'battle-jev-b7cf97b7-f30339e3-a2';
const target = read(join(root, 'runs', targetId, 'battle.json'));
const counterfactual = await replay(target, d => d.seat === 'B' && d.turn === 11 ? '使用 Earthquake' : d.label);
const report = { at: new Date().toISOString(), scope: 'Existing 70 selected with-Jev games; no new paid calls', paidCallsStarted: 0,
  models: byModel, overall: { selectedGames: results.selectedGames.length,
    winnerA: results.selectedGames.filter(g => g.result.winner === 'A').length,
    winnerB: results.selectedGames.filter(g => g.result.winner === 'B').length },
  opusReplayChecks: baselines, counterfactual: { matchId: targetId, seat: 'B', changedTurn: 11,
    originalAction: '使用 Extreme Speed', alternativeAction: '使用 Earthquake', originalWinner: target.winner,
    alternativeWinner: counterfactual.winner, finished: counterfactual.finished, publicLog: counterfactual.publicLog,
    boundary: 'One deterministic local action substitution with all prior recorded choices and seed unchanged; this is not a new model win or a general improvement estimate.' },
  thinkingEvidence: { officialSource: 'https://platform.claude.com/docs/en/build-with-claude/thinking',
    officialRule: 'Claude Opus 4.8 has thinking off when no thinking field is sent; adaptive enables thinking.',
    localBoundary: 'reasoning:true declares capability. Actual wire metadata and absence of thinking blocks establish the observed request configuration; gateway weights are not independently authenticated.' },
};
writeFileSync(join(directory, 'opus-audit-20261004.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ baselineGames: baselines.length, exactReplays: baselines.filter(b => b.exactPublicReplay).length,
  originalWinner: target.winner, alternativeWinner: counterfactual.winner, alternativeFinished: counterfactual.finished,
  opus: byModel.find(m => m.model === 'Claude-Opus-4.8'), report: join(directory, 'opus-audit-20261004.json') }));
