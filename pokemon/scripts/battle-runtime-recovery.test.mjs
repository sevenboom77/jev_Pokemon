import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveredBattleCalls } from './battle-runtime-recovery.mjs';

const args = { matchId: 'battle-example', decisionId: 'decision-1', candidateId: 'choice-1', explanation: '攻击' };
const bad = { seq: 1, data: { name: 'battle_act', toolUseId: 'bad', args: { ...args, bookmark: 'turn-1' } } };
const good = { seq: 4, trusted: true, data: { name: 'battle_act', toolUseId: 'good', args } };
const rejected = { seq: 2, data: { toolUseId: 'bad', isError: true, code: 'TOOL_ARGS_INVALID' } };
const accepted = { seq: 5, data: { toolUseId: 'good', isError: false, structured: { accepted: true } } };
const valid = (_name, args) => !('bookmark' in args);
const trusted = call => call.trusted === true;
const filter = (calls, results) => recoveredBattleCalls(calls, results, valid, trusted);

test('successful admitted correction clears only the pending historical failure', () => {
  assert.deepEqual(filter([bad, good], [rejected, accepted]), [good]);
  assert.equal(bad.data.args.bookmark, 'turn-1');
});
test('unresolved, rejected and untrusted replacements still fail closed', () => {
  assert.deepEqual(filter([bad], [rejected]), [bad]);
  assert.deepEqual(filter([bad, good], [rejected, { ...accepted, data: { ...accepted.data, isError: true } }]), [bad, good]);
  assert.deepEqual(filter([bad, { ...good, trusted: false }], [rejected, accepted]).length, 2);
});
test('another match or decision cannot resolve an earlier malformed call', () => {
  for (const change of [{ matchId: 'battle-other' }, { decisionId: 'decision-2' }]) {
    const other = { ...good, data: { ...good.data, args: { ...args, ...change } } };
    assert.equal(filter([bad, other], [rejected, accepted]).length, 2);
  }
});
test('non-battle tools and dispatched failures are never masked', () => {
  assert.equal(filter([{ ...bad, data: { ...bad.data, name: 'shell' } }, good], [rejected, accepted]).length, 2);
  assert.equal(filter([bad, good], [{ ...rejected, data: { ...rejected.data, code: 'E_ARENA' } }, accepted]).length, 2);
});
