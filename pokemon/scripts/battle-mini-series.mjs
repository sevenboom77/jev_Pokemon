import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './battle-env.mjs';

// A bounded pilot: no retries, no rescue prompts, no ranking calculation.
const repair = process.argv[2] === '--repair';
const schedule = repair ? [
  { A: 'battle-gpt', B: 'battle-gemini' },
  { A: 'battle-opus', B: 'battle-deepseek' },
  { A: 'battle-deepseek', B: 'battle-opus' },
] : [
  { A: 'battle-gemini', B: 'battle-gpt' },
  { A: 'battle-gpt', B: 'battle-gemini' },
  { A: 'battle-opus', B: 'battle-deepseek' },
  { A: 'battle-deepseek', B: 'battle-opus' },
];
const firstMatch = repair ? null : process.argv[2];
const output = join(ROOT, 'evidence/model-mini-series' + (repair ? '-repair' : '') + '-20261003.json');
if (existsSync(output)) throw new Error('Pilot evidence already exists; do not overwrite or repeat it.');
const config = await fetch('http://127.0.0.1:8795/api/config').then(r => r.json());
if (!config.ready) throw new Error('Battle service is not ready.');
for (const pair of schedule) for (const route of Object.values(pair)) {
  if (!config.modelCatalog.some(model => model.route === route)) throw new Error('Unverified model: ' + route);
}
const manifest = {
  at: new Date().toISOString(), status: 'running', executionMode: 'agh-long-task-v1',
  schedule, jevEnabled: true, seed: [10, 3, 20, 26],
  scope: repair ? 'One GPT/Gemini side-swap retry plus reciprocal Opus/DeepSeek games with the verified Chat interface; no win-rate or ranking inference.' : 'Four fixed-team games with reciprocal model seats; no win-rate or ranking inference.',
  matches: [],
};
const save = () => writeFileSync(output, JSON.stringify(manifest, null, 2) + '\n');
save();
for (const [index, pair] of schedule.entries()) {
  let id = index === 0 ? firstMatch : null;
  if (!id) {
    const response = await fetch('http://127.0.0.1:8795/api/start', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-battle-token': config.adminToken },
      body: JSON.stringify({ jev: true, models: pair }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error('Pilot start failed: ' + result.error);
    id = result.id;
  }
  if (!/^battle-[a-zA-Z0-9-]+$/.test(id)) throw new Error('Invalid match ID.');
  manifest.active = { index: index + 1, id, models: pair }; save();
  console.log(JSON.stringify({ started: index + 1, id, models: pair }));
  const deadline = Date.now() + 21 * 60 * 1000;
  let battle;
  while (Date.now() < deadline) {
    const file = join(ROOT, 'runs', id, 'battle.json');
    if (existsSync(file)) {
      battle = JSON.parse(readFileSync(file, 'utf8'));
      if (battle.models.A.route !== pair.A || battle.models.B.route !== pair.B || !battle.jevEnabled
        || JSON.stringify(battle.seed) !== JSON.stringify(manifest.seed)) throw new Error('Pilot protocol mismatch.');
      if (typeof battle.autonomousTaskVerified === 'boolean') break;
    }
    await new Promise(done => setTimeout(done, 2000));
  }
  if (typeof battle?.autonomousTaskVerified !== 'boolean') throw new Error('Missing terminal AGH history evidence.');
  const { id: matchId, models, status, winner, error, turn: turns, elapsedMs, autonomousTaskVerified, counts, historyChecks, sessions } = battle;
  const result = { id: matchId, models, status, winner, error, turns, elapsedMs, autonomousTaskVerified, counts, historyChecks, sessions,
    acceptedActions: battle.decisions.length, jevCalls: battle.traces.filter(t => t.type === 'jev').length,
    engineTerminal: battle.publicLog.filter(line => line.startsWith('|win|') || line === '|tie|').at(-1) ?? null,
  };
  manifest.matches.push(result); save(); console.log(JSON.stringify({ completed: index + 1, id, status, winner, autonomousTaskVerified }));
}
manifest.status = 'complete'; delete manifest.active; manifest.completedAt = new Date().toISOString(); save();
