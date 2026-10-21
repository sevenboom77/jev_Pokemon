import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BattleMatch, BattleError, CONCURRENCY_TEAMS } from './match.mjs';
import { runPlayers, prepareMatchSessions } from './runner.mjs';
import { startDeepSeekTransport } from './deepseek-transport.mjs';
import { preparePlayers, settlePlayerResources, ROOT, cli, PLAYER_WEB_PORTS } from '../../scripts/battle-env.mjs';
import { selectBattleModels } from './model-selection.mjs';
import { BattleScheduler } from './scheduler.mjs';
import { modelRequests, jevRequests } from './request-pool.mjs';
import { requestObserver } from './request-ledger.mjs';
import { installResponseDiagnostics } from './response-diagnostics-repair-20261004.mjs';

if (!process.env.TYPESAFE_API_KEY && existsSync(join(ROOT, '.env.local'))) process.loadEnvFile(join(ROOT, '.env.local'));
const port = Number(process.env.BATTLE_PORT ?? 8795);
const origin = 'http://127.0.0.1:' + port;
const adminToken = randomUUID();
installResponseDiagnostics(modelRequests, { root: ROOT });
const transport = await startDeepSeekTransport({ root: ROOT, port: port + 1 });
process.env.BATTLE_DEEPSEEK_BASE_URL = transport.url;
const matches = new Map();
let players = null, current = null;
const schedulerSettings = join(ROOT, '.runtime/battle-scheduler.json');
const savedConcurrency = existsSync(schedulerSettings) ? JSON.parse(readFileSync(schedulerSettings, 'utf8')).concurrency : 8;
const scheduler = new BattleScheduler({ concurrency: Number(process.env.BATTLE_CONCURRENCY ?? savedConcurrency), maxQueued: Number(process.env.BATTLE_MAX_QUEUED ?? 128), settlePreparation: settlePlayerResources });
const closedMatches = new Set();
async function closeMatch(match) {
  if (closedMatches.has(match.id)) return;
  closedMatches.add(match.id); await match.close();
}
const send = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
async function body(req) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 128 * 1024) throw new BattleError('E_BODY', 'Request too large'); chunks.push(chunk); }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}
function save(match) {
  const dir = join(ROOT, 'runs', match.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'battle.json'), JSON.stringify(match.finalResult ?? { ...match.snapshot(), models: match.models ?? players?.models }, null, 2) + '\n');
}

function admit(models, jev, suite = 'evaluation', league = null) {
  if (league && matches.has(league.matchId)) return league.matchId;
  const playerNames = Object.fromEntries(['A', 'B'].map(seat => [seat, (models[seat].label ?? models[seat].model) + ' · ' + seat]));
  const match = new BattleMatch({ jev, playerNames, suite, league, ...(league ? { id: league.matchId } : {}), ...(suite === 'concurrency-smoke' ? { teams: CONCURRENCY_TEAMS } : {}) });
  match.requestObserver = context => requestObserver(ROOT, { ...context, matchId: match.id });
  match.models = models; match.status = 'queued'; match.executionMode = 'agh-long-task-v1';
  matches.set(match.id, match); current = match;
  match.on('change', () => save(match)); save(match);
  scheduler.enqueue({ id: match.id, models, prepare: () => prepareMatchSessions(match, models), onCancel: reason => match.abort(reason), run: async () => {
    try { await match.start(); const result = await runPlayers(match, models, suite === 'concurrency-smoke' ? { maxTurns: 4, timeoutMs: 8 * 60 * 1000 } : league ? { maxTurns: league.maxTurns, timeoutMs: league.timeoutMs } : {}); match.finalResult = result; return result; }
    catch (error) {
      match.abort(error.message);
      const result = { ...match.snapshot(), models, autonomousTaskVerified: false };
      writeFileSync(join(ROOT, 'runs', match.id, 'battle.json'), JSON.stringify(result, null, 2) + '\n');
      return result;
    } finally { await closeMatch(match); }
  } });
  return match.id;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, origin);
    if (req.method === 'POST' && url.pathname.startsWith('/player/')) {
      const seat = Object.keys(players?.tokens ?? {}).find(s => req.headers.authorization === 'Bearer ' + players.tokens[s]);
      if (!seat) return send(res, 401, { error: 'E_AUTH', message: 'Unknown player binding' });
      const input = await body(req);
      const match = matches.get(input.matchId);
      if (!match) return send(res, 404, { error: 'E_MATCH', message: 'Match not found' });
      const action = url.pathname.slice(8);
      let result;
      if (action === 'observe') result = match.observe(seat);
      else if (action === 'act') result = await match.act(seat, input);
      else if (action === 'evaluate') result = await match.evaluate(seat, input.decisionId);
      else if (action === 'feedback') result = match.feedback(seat, input.decisionId);
      else if (action === 'wait') {
        const cancellation = new AbortController();
        const disconnected = () => { if (!res.writableEnded) cancellation.abort(); };
        res.once('close', disconnected);
        try { result = await match.wait(seat, input.decisionId, { signal: cancellation.signal }); }
        finally { res.off('close', disconnected); }
      }
      else return send(res, 404, { error: 'E_PATH' });
      return send(res, 200, result);
    }
    if (req.method === 'GET' && url.pathname === '/api/config') {
      if (req.headers.origin && req.headers.origin !== origin) return send(res, 403, { error: 'E_ORIGIN' });
      return send(res, 200, { ready: !!players, playerWebPorts: PLAYER_WEB_PORTS, models: players?.models, modelCatalog: players?.catalog, concurrency: scheduler.concurrency, adminToken });
    }
    if (req.method === 'GET' && url.pathname === '/api/schedule') return send(res, 200, scheduler.snapshot());
    if (req.method === 'GET' && url.pathname === '/api/load') return send(res, 200, { models: modelRequests.snapshot(), jev: jevRequests.snapshot() });
    if (req.method === 'GET' && url.pathname === '/api/matches') {
      const saved = readdirSync(join(ROOT, 'runs')).filter(id => /^battle-[a-zA-Z0-9-]+$/.test(id) && existsSync(join(ROOT, 'runs', id, 'battle.json')));
      return send(res, 200, { current: current?.id ?? null, matches: [...new Set([...saved, ...matches.keys()])] });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/match/')) {
      const id = url.pathname.slice(11);
      if (!/^battle-[a-zA-Z0-9-]+$/.test(id)) return send(res, 400, { error: 'E_ID' });
      const match = matches.get(id);
      if (match) return send(res, 200, match.finalResult ?? { ...match.snapshot(), models: match.models ?? players?.models });
      const file = join(ROOT, 'runs', id, 'battle.json');
      if (!existsSync(file)) return send(res, 404, { error: 'E_MATCH' });
      return send(res, 200, { ...JSON.parse(readFileSync(file, 'utf8')), recorded: true });
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      if ((req.headers.origin && req.headers.origin !== origin) || req.headers['x-battle-token'] !== adminToken) return send(res, 403, { error: 'E_AUTH' });
      const input = await body(req);
      if (url.pathname === '/api/concurrency') {
        if (!Number.isInteger(input.concurrency) || input.concurrency < 1 || input.concurrency > 32) return send(res, 400, { error: 'E_CONCURRENCY', message: 'Concurrency must be 1–32.' });
        const state = scheduler.setConcurrency(input.concurrency);
        writeFileSync(schedulerSettings, JSON.stringify({ concurrency: state.concurrency }) + '\n', { mode: 0o600 });
        return send(res, 200, state);
      }
      if (url.pathname === '/api/start' || url.pathname === '/api/batch') {
        if (!players) return send(res, 503, { error: 'E_PREPARING' });
        const jev = input.jev !== false;
        const suite = input.suite ?? 'evaluation';
        if (!['evaluation', 'concurrency-smoke'].includes(suite)) return send(res, 400, { error: 'E_SUITE' });
        if (jev && !process.env.TYPESAFE_API_KEY) return send(res, 400, { error: 'E_JEV_KEY' });
        const pairs = url.pathname === '/api/start' ? [input.models ?? {}] : input.pairs;
        if (!Array.isArray(pairs) || !pairs.length || pairs.length > (input.league ? 90 : 64) || pairs.some(pair => !pair || typeof pair !== 'object' || Array.isArray(pair))) return send(res, 400, { error: 'E_BATCH', message: 'Provide a bounded batch of model pairs.' });
        // Validate the entire batch before starting any paid task.
        let selections;
        try { selections = pairs.map(pair => selectBattleModels(players.catalog, players.models, pair)); }
        catch (error) { return send(res, 400, { error: 'E_MODEL', message: error.message }); }
        if (input.league) {
          if (!jev || suite !== 'evaluation' || pairs.some(pair => !/^battle-[a-zA-Z0-9-]+$/.test(pair.league?.matchId ?? '') || pair.league.maxTurns !== 40 || ![2400000,7200000].includes(pair.league.timeoutMs) || !/^[a-f0-9]{64}$/.test(pair.league.protocolDigest ?? ''))) return send(res, 400, { error: 'E_LEAGUE_PROTOCOL' });
          if (selections.some(models => Object.values(models).some(model => model.maxTokens !== 8192 || model.contextWindow !== 128000))) return send(res, 409, { error: 'E_LEAGUE_BUDGET' });
          for (const pair of pairs) {
            const existing = matches.get(pair.league.matchId);
            if (existing && JSON.stringify(existing.league) !== JSON.stringify(pair.league)) return send(res, 409, { error: 'E_LEAGUE_ID_CONFLICT' });
            if (!existing && existsSync(join(ROOT, 'runs', pair.league.matchId, 'battle.json'))) return send(res, 409, { error: 'E_LEAGUE_RECOVERY_REQUIRED' });
          }
        }
        if (!scheduler.canAccept(selections.length)) return send(res, 409, { error: 'E_QUEUE_FULL' });
        const ids = selections.map((models, index) => admit(models, jev, suite, input.league ? pairs[index].league : null));
        return send(res, 202, url.pathname === '/api/start' ? { id: ids[0] } : { ids, concurrency: scheduler.concurrency });
      }
      const target = matches.get(input.matchId ?? current?.id);
      if (url.pathname === '/api/pause' && target && !target.finished) {
        target.paused = input.paused === true; target.emit('change');
        return send(res, 200, { id: target.id, paused: target.paused });
      }
      return send(res, 404, { error: 'E_PATH' });
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'E_METHOD' });
    const allowed = {
      '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/model-names.js': 'model-names.js',
      '/dist/showdown.js': 'dist/showdown.js', '/dist/battle.css': 'dist/battle.css', '/dist/battle-log.css': 'dist/battle-log.css',
      '/dist/jquery-2.2.4.min.js': 'dist/jquery-2.2.4.min.js', '/dist/html-sanitizer-minified.js': 'dist/html-sanitizer-minified.js',
      '/dist/provenance.json': 'dist/provenance.json',
    };
    if (!allowed[url.pathname]) return send(res, 404, { error: 'E_PATH' });
    const file = join(ROOT, 'packages/battle-web', allowed[url.pathname]);
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
    res.writeHead(200, { 'content-type': (mime[extname(file)] ?? 'text/plain') + '; charset=utf-8' });
    res.end(readFileSync(file));
  } catch (error) { send(res, error instanceof BattleError ? 409 : 500, { error: error.code ?? 'E_INTERNAL', message: error.message }); }
});

await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
console.log('Pokemon battle stage: ' + origin);
try { players = await preparePlayers(origin); console.log('Both real AGH players are ready.'); }
catch (error) { console.error('Player setup failed: ' + error.message); await new Promise(resolve => server.close(resolve)); await transport.close(); process.exitCode = 1; }
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  scheduler.stop();
  for (const match of matches.values()) match.abort('Server stopped');
  await scheduler.idle();
  for (const match of matches.values()) await closeMatch(match);
  for (const seat of ['A', 'B']) await cli(seat, ['daemon', 'stop']).catch(() => {});
  await transport.close();
  server.close(() => process.exit(0));
});
