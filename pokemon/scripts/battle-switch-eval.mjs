import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { ROOT } from './battle-env.mjs';
import { DECISION_POLICY } from '../packages/battle-arena/strategy.mjs';

const output = join(ROOT, 'evidence/switch-policy-eval-20261003.json');
if (existsSync(output)) throw new Error('Evaluation exists; preserve it instead of repeating games.');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const schedule = [{ A: 'battle-gemini', B: 'battle-gpt' }, { A: 'battle-gpt', B: 'battle-gemini' }];
const sourceHashes = Object.fromEntries(['strategy.mjs', 'match.mjs', 'runner.mjs'].map(f => {
  const file = join(ROOT, 'packages/battle-arena', f); return [file, hash(file)];
}));
const manifest = { startedAt: new Date().toISOString(), status: 'running', decisionPolicy: DECISION_POLICY,
  schedule, seed: [10, 3, 20, 26], jevEnabled: true, sourceHashes,
  scope: 'Exactly two Gemini/GPT games with seats exchanged; fixed teams and seed; same shared player/Jev policy, one native AGH task per seat, no retries or external next-turn prompts.',
  matches: [],
};
const save = () => writeFileSync(output, JSON.stringify(manifest, null, 2) + '\n');
save();
let config;
for (let attempt = 0; attempt < 60; attempt++) {
  config = await fetch('http://127.0.0.1:8795/api/config').then(r => r.json());
  if (config.ready) break;
  await new Promise(done => setTimeout(done, 1000));
}
assert(config.ready, 'Players are not ready.');
for (const [index, models] of schedule.entries()) {
  for (const [file, expected] of Object.entries(sourceHashes)) assert.equal(hash(file), expected, 'Policy changed during evaluation.');
  const response = await fetch('http://127.0.0.1:8795/api/start', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-battle-token': config.adminToken },
    body: JSON.stringify({ models, jev: true }),
  });
  const result = await response.json();
  assert(response.ok, 'Start failed: ' + result.error);
  assert.match(result.id, /^battle-[a-zA-Z0-9-]+$/);
  const id = result.id;
  manifest.active = { index: index + 1, id, models }; save();
  console.log(JSON.stringify({ started: index + 1, id, models, decisionPolicy: DECISION_POLICY }));
  const deadline = Date.now() + 21 * 60 * 1000;
  let battle;
  while (Date.now() < deadline) {
    const file = join(ROOT, 'runs', id, 'battle.json');
    if (existsSync(file)) {
      battle = JSON.parse(readFileSync(file, 'utf8'));
      assert.equal(battle.decisionPolicy, DECISION_POLICY);
      assert.deepEqual(battle.seed, manifest.seed); assert.equal(battle.jevEnabled, true);
      assert.equal(battle.models.A.route, models.A); assert.equal(battle.models.B.route, models.B);
      if (typeof battle.autonomousTaskVerified === 'boolean') break;
    }
    await new Promise(done => setTimeout(done, 2000));
  }
  assert.equal(typeof battle?.autonomousTaskVerified, 'boolean', 'Terminal AGH histories missing.');
  const { status, winner, turn, elapsedMs, autonomousTaskVerified, sessions, counts, historyChecks, error } = battle;
  manifest.matches.push({ id, models: battle.models, status, winner, turn, elapsedMs, autonomousTaskVerified, sessions, counts, historyChecks, error,
    actions: battle.decisions.length, jevCalls: battle.traces.filter(t => t.type === 'jev').length,
    voluntarySwitches: battle.decisions.filter(d => d.switchReason === 'voluntary').length,
    immediateSwitchBacks: battle.decisions.filter(d => d.immediateSwitchBack).length,
  });
  save(); console.log(JSON.stringify({ completed: index + 1, id, status, winner, autonomousTaskVerified }));
}
manifest.status = 'complete'; manifest.completedAt = new Date().toISOString(); delete manifest.active; save();
