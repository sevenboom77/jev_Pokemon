import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ROOT, CLI } from './battle-env.mjs';
import { PLAYER_HOMES } from './battle-env.mjs';

const [inputFile, outputFile] = process.argv.slice(2);
if (!inputFile || !outputFile) throw new Error('Usage: node scripts/battle-evaluate-batch.mjs schedule.json evidence/result.json');
if (existsSync(outputFile)) throw new Error('Evidence exists; do not repeat paid games or overwrite results.');
const input = JSON.parse(readFileSync(inputFile, 'utf8'));
const origin = 'http://127.0.0.1:8795';
const config = await fetch(origin + '/api/config').then(r => r.json());
if (!config.ready) throw new Error('Players are not ready.');
const manifest = { startedAt: new Date().toISOString(), status: 'submitting', suite: input.suite ?? 'evaluation',
  purpose: input.purpose, pairs: input.pairs, jevEnabled: input.jev !== false,
  includeInModelScores: input.includeInModelScores ?? ((input.suite ?? 'evaluation') === 'evaluation'),
  aghRuntime: { cli: CLI, workerSha256: createHash('sha256').update(readFileSync(join(CLI, '..', 'worker.mjs'))).digest('hex') },
  contextWindow: config.modelCatalog[0].contextWindow, concurrency: config.concurrency, peakRunning: 0, peakAghTasks: 0,
  sourceHashes: Object.fromEntries(['packages/battle-arena/runner.mjs', 'packages/battle-arena/deepseek-transport.mjs', 'packages/battle-arena/match.mjs', 'packages/battle-arena/strategy.mjs', 'packages/agh-battle-plugin/index.mjs', 'packages/battle-arena/scheduler.mjs', 'packages/battle-arena/request-pool.mjs', 'scripts/battle-env.mjs', 'scripts/battle-resources.ts', 'scripts/battle-history.mjs', '../agnes-harness/packages/host/src/assemble.ts', '../agnes-harness/packages/resource-control-store/src/skill-journal.ts', '../agnes-harness/packages/core/src/reduce/reducer.ts', '../agnes-harness/packages/core/src/step/gate.ts'].map(file => [file, createHash('sha256').update(readFileSync(join(ROOT, file))).digest('hex')])),
  matches: [], ids: [],
};
const save = () => writeFileSync(outputFile, JSON.stringify(manifest, null, 2) + '\n');
save();
const response = await fetch(origin + '/api/batch', { method: 'POST', headers: { 'content-type': 'application/json', 'x-battle-token': config.adminToken }, body: JSON.stringify(input) });
const result = await response.json();
if (!response.ok) { manifest.status = 'rejected'; manifest.error = result.error; save(); throw new Error(result.message ?? result.error); }
manifest.ids = result.ids; manifest.status = 'running'; save();
console.log(JSON.stringify({ started: manifest.ids, suite: manifest.suite, concurrency: manifest.concurrency }));
const deadline = Date.now() + 45 * 60 * 1000;
let previous = '';
while (Date.now() < deadline) {
  const schedule = await fetch(origin + '/api/schedule').then(r => r.json());
  const own = schedule.jobs.filter(job => manifest.ids.includes(job.id));
  const live = own.filter(job => job.state === 'running');
  manifest.peakRunning = Math.max(manifest.peakRunning, live.length);
  let activeTasks = 0;
  const runningSessions = { A: [], B: [] };
  for (const job of live) {
    const file = join(ROOT, 'runs', job.id, 'battle.json');
    if (!existsSync(file)) continue;
    const b = JSON.parse(readFileSync(file, 'utf8'));
    for (const seat of ['A','B']) if (b.sessions[seat]) runningSessions[seat].push(b.sessions[seat]);
  }
  for (const seat of ['A','B']) {
    const db = new DatabaseSync(join(PLAYER_HOMES[seat], 'data/sessions.db'), { readOnly: true });
    try {
      for (const session of runningSessions[seat]) {
        const events = db.prepare("SELECT type FROM events WHERE session_key=? AND type IN ('turn/start','turn/end')").all(session);
        if (events.some(e=>e.type==='turn/start') && !events.some(e=>e.type==='turn/end')) activeTasks++;
      }
    } finally { db.close(); }
  }
  manifest.peakAghTasks = Math.max(manifest.peakAghTasks, activeTasks);
  const terminal = own.filter(job => ['completed', 'failed', 'cancelled'].includes(job.state));
  for (const job of terminal) {
    if (manifest.matches.some(m => m.id === job.id)) continue;
    const b = JSON.parse(readFileSync(join(ROOT, 'runs', job.id, 'battle.json'), 'utf8'));
    const compactions = {}, histories = {};
    for (const seat of ['A','B']) {
      const file = join(ROOT, 'runs', job.id, 'agh-' + seat.toLowerCase() + '.jsonl');
      const events = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
      compactions[seat] = events.filter(e => e.surfaceOp?.op === 'replace').length;
      histories[seat] = { events: events.length, userTasks: events.filter(e => e.type === 'user/message' && e.data?.kind !== 'runtime_context').length,
        taskStarts: events.filter(e => e.type === 'turn/start').length, terminal: events.filter(e => e.type === 'turn/end').at(-1)?.data?.reason,
        startedAt: events.find(e => e.type === 'turn/start')?.ts, endedAt: events.filter(e => e.type === 'turn/end').at(-1)?.ts,
      };
    }
    manifest.matches.push({ id: b.id, models: b.models, suite: b.suite, status: b.status, winner: b.winner, turn: b.turn,
      autonomousTaskVerified: b.autonomousTaskVerified, elapsedMs: b.elapsedMs, executionBudget: b.executionBudget, taskResults: b.taskResults, historyChecks: b.historyChecks,
      sessions: b.sessions, compactions, histories, actions: b.decisions.length, jevCalls: b.traces.filter(t => t.type === 'jev').length,
      voluntarySwitches: b.decisions.filter(d => d.switchReason === 'voluntary').length, immediateSwitchBacks: b.decisions.filter(d => d.immediateSwitchBack).length,
      error: b.error, page: origin + '/?match=' + b.id + '&replay=1',
    });
  }
  manifest.load = await fetch(origin + '/api/load').then(r => r.json());
  save();
  const progress = JSON.stringify({ running: live.length, complete: terminal.length, total: own.length, peakRunning: manifest.peakRunning, peakAghTasks: manifest.peakAghTasks, turns: live.map(j => {
    const b=JSON.parse(readFileSync(join(ROOT,'runs',j.id,'battle.json'),'utf8')); return [j.id,b.turn];
  }) });
  if (progress !== previous) { console.log(progress); previous = progress; }
  if (terminal.length === manifest.ids.length) {
    manifest.status = 'complete'; manifest.completedAt = new Date().toISOString();
    manifest.fullyVerified = manifest.matches.filter(m => m.autonomousTaskVerified).length;
    const peak = intervals => {
      const points = intervals.filter(([a,b])=>a&&b&&a<b).flatMap(([a,b])=>[[Date.parse(a),1],[Date.parse(b),-1]]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
      let running=0, maximum=0; for(const [,delta]of points) { running+=delta; maximum=Math.max(maximum,running); } return maximum;
    };
    manifest.peakAghTasks = peak(manifest.matches.flatMap(m=>['A','B'].map(s=>[m.histories[s].startedAt,m.histories[s].endedAt])));
    manifest.peakGamesWithBothTasksActive = peak(manifest.matches.map(m=>[
      [m.histories.A.startedAt,m.histories.B.startedAt].sort().at(-1),
      [m.histories.A.endedAt,m.histories.B.endedAt].sort().at(0),
    ]));
    save(); console.log(JSON.stringify({ complete: true, fullyVerified: manifest.fullyVerified, total: manifest.matches.length, peakRunning: manifest.peakRunning, peakAghTasks: manifest.peakAghTasks }));
    process.exit(0);
  }
  await new Promise(done => setTimeout(done, 2000));
}
manifest.status = 'monitor-deadline'; save(); throw new Error('Monitor deadline reached; preserve evidence and inspect running jobs.');
