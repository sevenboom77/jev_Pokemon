import test from 'node:test';
import assert from 'node:assert/strict';
import { BattleMatch } from '../packages/battle-arena/match.mjs';

async function choose(match, seat, predicate = () => true) {
  const o = match.observe(seat);
  const candidate = o.candidates.find(predicate);
  assert.ok(candidate);
  return match.act(seat, { decisionId: o.decisionId, candidateId: candidate.id, explanation: 'contract test' });
}
async function startMoves(match) { await choose(match, 'A'); await choose(match, 'B'); }

test('player observation excludes opponent private moves, stats and unsubmitted choices', async () => {
  const m = await new BattleMatch().start();
  try {
    await startMoves(m);
    const before = m.observe('A');
    assert.ok(before.own.pokemon[0].stats);
    assert.equal(before.opponent.active.species, 'Blastoise');
    assert.deepEqual(before.opponent.active.movesSeen, []);
    assert.equal(JSON.stringify(before.opponent).includes('Surf'), false);
    assert.equal(JSON.stringify(before.opponent).includes('stats'), false);
    await choose(m, 'B', c => c.move === 'Surf');
    assert.deepEqual(m.observe('A').opponent, before.opponent);
    assert.equal(m.observe('A').publicHistory.some(line => line.startsWith('|request|')), false);
  } finally { await m.close(); }
});

test('both players commit before actual damage and public move events appear', async () => {
  const m = await new BattleMatch().start();
  try {
    await startMoves(m);
    const movesBefore = m.publicLog.filter(line => line.startsWith('|move|')).length;
    await choose(m, 'A', c => c.move === 'Thunderbolt');
    assert.equal(m.publicLog.filter(line => line.startsWith('|move|')).length, movesBefore);
    await choose(m, 'B', c => c.move === 'Surf');
    assert.ok(m.publicLog.some(line => line.startsWith('|-damage|')));
    assert.ok(m.publicLog.some(line => line.startsWith('|-supereffective|')));
    assert.ok(m.turn >= 2);
  } finally { await m.close(); }
});

test('a publicly revealed move remains known after switching out and back in', async () => {
  const m = await new BattleMatch().start();
  try {
    await startMoves(m);
    await choose(m, 'A', c => c.move === 'Quick Attack'); await choose(m, 'B', c => c.move === 'Protect');
    assert.deepEqual(m.observe('B').opponent.active.movesSeen, ['Quick Attack']);
    await choose(m, 'A', c => c.species === 'Charizard'); await choose(m, 'B', c => c.move === 'Protect');
    await choose(m, 'A', c => c.species === 'Pikachu'); await choose(m, 'B', c => c.move === 'Protect');
    assert.deepEqual(m.observe('B').opponent.active.movesSeen, ['Quick Attack']);
    assert.equal(JSON.stringify(m.observe('B').opponent).includes('Grass Knot'), false);
  } finally { await m.close(); }
});

test('invalid and wrong-seat candidates fail without advancing the game', async () => {
  const m = await new BattleMatch().start();
  try {
    const a = m.observe('A'), b = m.observe('B');
    await assert.rejects(m.act('A', { decisionId: a.decisionId, candidateId: b.candidates[0].id }), { code: 'E_INVALID_ACTION' });
    await assert.rejects(m.act('B', { decisionId: a.decisionId, candidateId: a.candidates[0].id }), { code: 'E_STALE_DECISION' });
    assert.equal(m.decisions.length, 0);
  } finally { await m.close(); }
});

test('same submission is idempotent and conflicting retry is rejected', async () => {
  const m = await new BattleMatch().start();
  try {
    const a = m.observe('A');
    const input = { decisionId: a.decisionId, candidateId: a.candidates[0].id };
    await m.act('A', input); await m.act('A', input);
    assert.equal(m.decisions.length, 1);
    await assert.rejects(m.act('A', { ...input, candidateId: a.candidates[1].id }), { code: 'E_DUPLICATE_CONFLICT' });
  } finally { await m.close(); }
});

test('knockout creates a forced switch, then engine declares a natural winner', async () => {
  const m = await new BattleMatch({ playerNames: { A: 'Gemini · A', B: 'GPT · B' }, teams: {
    A: [{ species: 'Mewtwo', level: 100, moves: ['Psychic'] }],
    B: [{ species: 'Machop', level: 1, moves: ['Tackle'] }, { species: 'Magikarp', level: 1, moves: ['Splash'] }],
  } }).start();
  try {
    await startMoves(m);
    await choose(m, 'A'); await choose(m, 'B');
    assert.equal(m.observe('B').phase, 'forcedSwitch');
    assert.ok(m.observe('B').candidates.every(c => c.kind === 'switch'));
    assert.ok(m.observe('B').candidates.every(c => c.switchReason === 'faintReplacement' && c.spendsTurn === false));
    await choose(m, 'B');
    await choose(m, 'A'); await choose(m, 'B');
    assert.equal(m.finished, true); assert.equal(m.winner, 'A');
    assert.equal(m.status, 'finished');
    assert.equal(m.publicLog.at(-1), '|win|Gemini · A');
    assert.equal(m.publicLog.filter(line => line.startsWith('|faint|')).length, 2);
  } finally { await m.close(); }
});

test('a submitted player waits for the opponent, then receives only its own next decision', async () => {
  const m = await new BattleMatch().start();
  try {
    const previous = m.observe('A');
    await choose(m, 'A');
    let released = false;
    const waiting = m.wait('A', previous.decisionId, { timeoutMs: 1000 }).then(value => { released = true; return value; });
    await m.settle();
    assert.equal(released, false);
    await choose(m, 'B');
    const next = await waiting;
    assert.equal(next.waitStatus, 'ready');
    assert.equal(next.needsDecision, true);
    assert.notEqual(next.decisionId, previous.decisionId);
    assert.equal(next.turn, 1);
    assert.equal(next.opponent.active.species, 'Blastoise');
    assert.equal(next.candidates.find(c => c.move === 'Thunderbolt').typeMultiplier, 2);
    assert.equal(JSON.stringify(next.opponent).includes('stats'), false);
    assert.equal(m.listenerCount('change'), 0);
  } finally { await m.close(); }
});

test('pause preserves the current decision and blocks submission until resumed', async () => {
  const m = await new BattleMatch().start();
  try {
    const o = m.observe('A');
    m.paused = true; m.emit('change');
    assert.equal(m.observe('A').needsDecision, false);
    await assert.rejects(choose(m, 'A'), { code: 'E_PAUSED' });
    const expired = await m.wait('A', undefined, { timeoutMs: 5 });
    assert.equal(expired.waitStatus, 'timeout');
    assert.equal(expired.paused, true);
    const waiting = m.wait('A', undefined, { timeoutMs: 1000 });
    m.paused = false; m.emit('change');
    assert.equal((await waiting).decisionId, o.decisionId);
    assert.equal(m.decisions.length, 0);
    assert.equal(m.listenerCount('change'), 0);
  } finally { await m.close(); }
});

test('wait wakes on terminal failure and releases listeners on cancellation', async () => {
  const m = await new BattleMatch().start();
  try {
    const o = m.observe('A');
    const cancellation = new AbortController();
    const waiting = m.wait('A', o.decisionId, { timeoutMs: 1000, signal: cancellation.signal });
    cancellation.abort();
    await assert.rejects(waiting, { code: 'E_WAIT_CANCELLED' });
    assert.equal(m.listenerCount('change'), 0);
    const terminal = m.wait('A', o.decisionId, { timeoutMs: 1000 });
    m.abort('test cancellation');
    const ended = await terminal;
    assert.equal(ended.waitStatus, 'ended');
    assert.equal(ended.finished, true);
    assert.equal(ended.winner, null);
    assert.equal(m.listenerCount('change'), 0);
  } finally { await m.close(); }
});

test('Jev-enabled matches reject an unreviewed choice without charging or advancing', async () => {
  const m = await new BattleMatch({ jev: true }).start();
  try {
    assert.equal(m.observe('A').jev.required, true);
    await assert.rejects(choose(m, 'A'), { code: 'E_JEV_REQUIRED' });
    assert.equal(m.decisions.length, 0);
  } finally { await m.close(); }
});

test('voluntary switch-back remains legal, costs a turn and exposes only own recent choices', async () => {
  const m = await new BattleMatch().start();
  try {
    await startMoves(m);
    const before = m.observe('A');
    assert.ok(before.candidates.filter(c => c.kind === 'switch').every(c => c.switchReason === 'voluntary' && c.spendsTurn));
    await choose(m, 'A', c => c.species === 'Charizard');
    await choose(m, 'B', c => c.move === 'Protect');
    const next = m.observe('A');
    const back = next.candidates.find(c => c.species === 'Pikachu');
    assert.equal(back.immediateSwitchBack, true);
    assert.equal(next.recentOwnActions.at(-1).fromSpecies, 'Pikachu');
    assert.equal(next.recentOwnActions.at(-1).toSpecies, 'Charizard');
    assert.ok(next.recentOwnActions.every(d => d.seat === 'A'));
    assert.equal(m.observe('B').recentOwnActions.some(d => d.seat === 'A'), false);
    await choose(m, 'A', c => c.id === back.id);
    await choose(m, 'B', c => c.move === 'Protect');
    assert.equal(m.turn, before.turn + 2);
    assert.equal(m.decisions.filter(d => d.seat === 'A' && d.switchReason === 'voluntary').length, 2);
  } finally { await m.close(); }
});

test('Volt Switch replacement is distinct from a voluntary switch and spends no extra turn', async () => {
  const m = await new BattleMatch().start();
  try {
    await startMoves(m);
    await choose(m, 'A', c => c.move === 'Volt Switch');
    await choose(m, 'B', c => c.move === 'Aura Sphere');
    const pivot = m.observe('A');
    assert.equal(pivot.phase, 'forcedSwitch');
    assert.ok(pivot.candidates.length > 0);
    assert.ok(pivot.candidates.every(c => c.switchReason === 'pivot' && c.spendsTurn === false));
    assert.equal(pivot.turn, 1);
    await choose(m, 'A', c => c.species === 'Charizard');
    assert.equal(m.turn, 2);
    assert.equal(m.decisions.at(-1).switchReason, 'pivot');
    assert.equal(m.decisions.at(-1).fromSpecies, 'Pikachu');
  } finally { await m.close(); }
});
