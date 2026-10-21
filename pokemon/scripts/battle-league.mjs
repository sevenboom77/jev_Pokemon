import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { ROOT } from './battle-env.mjs';
import { wholeMatchPrompt } from '../packages/battle-arena/runner.mjs';
import { auditLeagueBattle, leagueResults, digest } from './battle-league-audit.mjs';
import { spreadModelPairs } from '../packages/battle-arena/scheduler.mjs';

const [command, directoryArg] = process.argv.slice(2);
if (!['init', 'run'].includes(command) || !directoryArg) throw new Error('Usage: battle-league.mjs init|run evidence/league-directory');
const directory = resolve(ROOT, directoryArg), file = join(directory, 'manifest.json');
const origin = 'http://127.0.0.1:8795';
const controlFile = join(directory, 'control.json');
const atomic = (path, value) => { writeFileSync(path + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); renameSync(path + '.tmp', path); };
let manifest;
if (command === 'init') {
  if (existsSync(file)) throw new Error('Manifest already exists; resume without creating another paid schedule.');
  mkdirSync(directory, { recursive: true });
  const plan = JSON.parse(readFileSync(join(ROOT, 'examples/league-two-mode-plan-20261004.json'), 'utf8'));
  const sourceFiles = ['packages/battle-arena/runner.mjs', 'packages/battle-arena/match.mjs', 'packages/battle-arena/strategy.mjs', 'packages/battle-arena/server.mjs', 'packages/battle-arena/request-pool.mjs', 'packages/battle-arena/request-ledger.mjs', 'packages/battle-arena/deepseek-transport.mjs', 'packages/battle-arena/scheduler.mjs', 'packages/agh-battle-plugin/index.mjs', 'scripts/battle-env.mjs', 'scripts/battle-league.mjs', 'scripts/battle-league-audit.mjs'];
  const models = plan.models.map(m => ({ id: m.id, displayName: m.displayName, route: m.route, requestModel: m.requestModel, api: m.api, channelAlias: m.channelAlias, reasoning: m.observedSettings.reasoning, contextWindow: 128000, maxTokens: 8192 }));
  const protocol = { id: 'with-jev-fixed-3v3-pilot-v2', mode: 'with-jev', jev: true, jevModel: 'jev-1.13.0',
    fixture: plan.fixtures[0], maxTurns: 40, timeoutMs: 7200000, outputCap: 8192, contextWindow: 128000,
    taskMode: 'agh-long-task-v1', userTasksPerSeat: 1, turnCap: 'engine-draw-and-normal-task-finalization',
    selection: 'first-complete-valid-two-leg-pair', maxPairAttempts: 2,
    prompt: { A: wholeMatchPrompt({ id: 'MATCH_ID', jevEnabled: true }, 'A'), B: wholeMatchPrompt({ id: 'MATCH_ID', jevEnabled: true }, 'B') }, models };
  const gate = ['agnes-vs-deepseek', 'glm-vs-kimi', 'mimo-vs-minimax', 'qwen-vs-gemini', 'gpt-vs-opus'];
  const pairs = plan.blocks.map(b => ({ blockId: b.blockId, gate: gate.includes(b.blockId),
    games: b.games.filter(g => g.jev).map(g => ({ plannedId: g.plannedId, models: g.models })), attempts: [] }));
  if (pairs.length !== 45 || pairs.some(p => p.games.length !== 2) || pairs.filter(p => p.gate).length !== 5) throw new Error('Invalid 90-game plan.');
  manifest = { schema: 'pokemon.league-run.v1', runId: 'jev-' + randomUUID().slice(0, 8), createdAt: new Date().toISOString(),
    status: 'initialized', authorizedScope: '90 with-Jev games only; no without-Jev games', targetGames: 90,
    models, protocol, protocolDigest: digest(protocol), pairs, gatePassed: false, peakRunning: 0,
    sourceHashes: Object.fromEntries(sourceFiles.map(p => [p, createHash('sha256').update(readFileSync(join(ROOT, p))).digest('hex')])),
    priceSheet: 'examples/league-price-sheet-20261004.json', actualCharge: null, events: [], waves: [] };
  atomic(file, manifest); atomic(join(directory, 'protocol.json'), protocol);
  console.log(JSON.stringify({ initialized: file, games: 90, gateGames: 10, protocolDigest: manifest.protocolDigest }));
  process.exit(0);
}
manifest = JSON.parse(readFileSync(file, 'utf8'));
const lock = join(directory, 'monitor.lock');
if (existsSync(lock)) {
  const pid = Number(readFileSync(lock, 'utf8'));
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch {}
  if (alive) throw new Error('Another monitor owns this run.');
  unlinkSync(lock);
}
writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
const save = () => {
  manifest.updatedAt = new Date().toISOString(); atomic(file, manifest);
  const results = leagueResults(manifest); atomic(join(directory, 'results.json'), results);
  const csv = ['model,games,wins,draws,losses,opponents,score,rank', ...results.standings.map(m => [m.displayName,m.games,m.wins,m.draws,m.losses,m.opponents,m.score,m.rank].join(','))].join('\n') + '\n';
  writeFileSync(join(directory, 'standings.csv'), csv);
};
const get = async path => { const response = await fetch(origin + path, { signal: AbortSignal.timeout(15000) }); if (!response.ok) throw new Error('HTTP ' + response.status); return response.json(); };
const post = async (path, body) => {
  const config = await get('/api/config');
  const response = await fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-battle-token': config.adminToken }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error ?? 'HTTP ' + response.status); return value;
};
let previousLog = 0;
try {
  const config = await get('/api/config');
  if (!config.ready) throw new Error('Battle service not ready.');
  for (const model of manifest.models) {
    const observed = config.modelCatalog.find(m => m.route === model.route);
    if (!observed || observed.model !== model.requestModel || observed.maxTokens !== 8192 || observed.contextWindow !== 128000 || observed.api !== model.api) throw new Error('Model/budget changed: ' + model.displayName);
  }
  const initial = await get('/api/schedule');
  const ownIds = new Set(manifest.pairs.flatMap(p => p.attempts.flatMap(a => a.games.map(g => g.matchId))));
  if (initial.jobs.some(j => ['running','queued'].includes(j.state) && !ownIds.has(j.id))) throw new Error('Unrelated active jobs; do not mix schedules.');
  manifest.status = 'running'; manifest.startedAt ??= new Date().toISOString(); save();
  for (;;) {
    const schedule = await get('/api/schedule'), jobs = new Map(schedule.jobs.map(j => [j.id,j]));
    manifest.peakRunning = Math.max(manifest.peakRunning, schedule.running);
    for (const pair of manifest.pairs) for (const attempt of pair.attempts) for (const game of attempt.games) {
      if (game.result) continue;
      const job = jobs.get(game.matchId), path = join(ROOT, 'runs', game.matchId, 'battle.json');
      if (!job && !existsSync(path)) continue;
      game.state = job?.state ?? 'reconcile';
      if (job && ['running','queued'].includes(job.state)) continue;
      const battle = JSON.parse(readFileSync(path, 'utf8'));
      if (!job && !battle.autonomousTaskVerified && !['finished','aborted'].includes(battle.status)) throw new Error('Unsettled durable job requires recovery: ' + game.matchId);
      game.result = auditLeagueBattle(ROOT, game, manifest);
      game.state = game.result.valid ? 'verified' : 'failed';
    }
    const results = leagueResults(manifest); manifest.verifiedGames = results.validSelectedGames;
    save();
    if (Date.now() - previousLog >= 30000) {
      const live = schedule.jobs.filter(j => j.state === 'running').map(j => {
        const p = join(ROOT,'runs',j.id,'battle.json'); const b = existsSync(p) ? JSON.parse(readFileSync(p,'utf8')) : {};
        return { id:j.id,turn:b.turn,models:Object.values(j.models).map(m=>m.displayName),jevCalls:b.traces?.filter(t=>t.type==='jev').length ?? 0 };
      });
      console.log(JSON.stringify({ at:new Date().toISOString(), verified:manifest.verifiedGames,total:90,running:schedule.running,queued:schedule.queued,preparing:schedule.preparing,live })); previousLog = Date.now();
    }
    if (manifest.verifiedGames === 90) {
      manifest.status = 'complete'; manifest.finishedAt = new Date().toISOString(); save();
      console.log(JSON.stringify({ complete:true,verified:90,results:join(directory,'results.json'),peakRunning:manifest.peakRunning })); break;
    }
    const control = existsSync(controlFile) ? JSON.parse(readFileSync(controlFile, 'utf8')) : {};
    manifest.admissionsPaused = control.admissionsPaused === true;
    if (!manifest.admissionsPaused && !schedule.running && !schedule.queued && !schedule.preparing) {
      const complete = pair => pair.attempts.some(a => a.games.every(g => g.result?.valid));
      const candidates = manifest.pairs.filter(p => !complete(p) && (manifest.gatePassed || p.gate)
        && (!control.repairGateBlockIds?.length || control.repairGateBlockIds.includes(p.blockId)));
      const exhausted = candidates.filter(p => p.attempts.length >= manifest.protocol.maxPairAttempts + (manifest.repairRetryAllowanceByPair?.[p.blockId] ?? 0));
      if (exhausted.length) { manifest.status='needs-repair'; manifest.exhaustedPairs=exhausted.map(p=>p.blockId);save();throw new Error('Repeated pair failure: inspect original traces before further admissions.'); }
      if (!candidates.length) {
        if (!manifest.gatePassed) { manifest.gatePassed=true; save(); continue; }
        await new Promise(done=>setTimeout(done,5000));continue;
      }
      const concurrency = manifest.gatePassed ? (control.concurrency ?? 16) : 8;
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('League concurrency must be an integer from 1 to 32.');
      await post('/api/concurrency',{concurrency});
      const games=[];
      for (const pair of spreadModelPairs(candidates, concurrency / 2)) {
        const index=pair.attempts.length;
        const attempt={ index,createdAt:new Date().toISOString(),games:pair.games.map(g=>({...g,matchId:'battle-'+manifest.runId+'-'+digest(g.plannedId).slice(0,8)+'-a'+index,state:'admitting'})) };
        pair.attempts.push(attempt); games.push(...attempt.games.map(g=>({ ...g,blockId:pair.blockId,index })));
      }
      manifest.waves.push({at:new Date().toISOString(),concurrency,gameIds:games.map(g=>g.matchId)});save();
      const pairs=games.map(g=>({ A:manifest.models.find(m=>m.id===g.models.A).route,B:manifest.models.find(m=>m.id===g.models.B).route,
        league:{runId:manifest.runId,matchId:g.matchId,plannedId:g.plannedId,blockId:g.blockId,attempt:g.index,protocolDigest:manifest.protocolDigest,fixtureDigest:manifest.protocol.fixture.digest,maxTurns:manifest.protocol.maxTurns,timeoutMs:manifest.protocol.timeoutMs} }));
      const accepted=await post('/api/batch',{league:true,jev:true,suite:'evaluation',pairs});
      if (JSON.stringify(accepted.ids)!==JSON.stringify(games.map(g=>g.matchId)))throw new Error('Admission identity mismatch.');
      console.log(JSON.stringify({admitted:games.length,concurrency,gate:!manifest.gatePassed,runId:manifest.runId}));
    }
    await new Promise(done=>setTimeout(done,5000));
  }
} catch (error) {
  manifest.status = manifest.status === 'needs-repair' ? manifest.status : 'monitor-needs-attention';
  manifest.monitorError=error.message; save(); console.error(error.message); process.exitCode=1;
} finally { unlinkSync(lock); }
