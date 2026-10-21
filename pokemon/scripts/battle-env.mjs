import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { capabilityHash, hashDirectory } from './agh-env.mjs';
import { loadExtraModels } from './battle-extra-models.mjs';
import { displayModelName, modelForDisplay } from '../packages/battle-web/model-names.js';

export const ROOT = resolve(import.meta.dirname, '..');
const battleRuntime = join(ROOT, '.runtime/battle-agh-runtime/agnes.mjs');
export const CLI = process.env.AGH_AGNES ?? (existsSync(battleRuntime) ? battleRuntime : join(ROOT, '..', 'agnes-harness/packages/cli/dist/local/agnes.mjs'));
export const PLUGIN = '@pokemon/agh-battle-plugin';
export const PLAYER_HOMES = Object.fromEntries(['A', 'B'].map(seat => [seat, join(ROOT, '.runtime/battle-agh-' + seat.toLowerCase())]));
export const PLAYER_WEB_PORTS = { A: Number(process.env.BATTLE_WEB_PORT_A ?? 4181), B: Number(process.env.BATTLE_WEB_PORT_B ?? 4182) };
export function privateJson(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
}
export function cli(seat, args, { cwd = ROOT, interactive = false, timeoutMs = 60000, signal } = {}) {
  const { TYPESAFE_API_KEY, ...environment } = process.env;
  const playerEnvironment = { ...environment, AGH_HOME: PLAYER_HOMES[seat], AGNES_WEB_ORIGIN: 'http://127.0.0.1:' + PLAYER_WEB_PORTS[seat] };
  return new Promise((resolveDone, reject) => {
    const argv = [CLI, ...args];
    const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
    const child = interactive
      ? spawn('/bin/bash', ['-c', "(sleep 2; printf '%s\\n' y; sleep 3) | /usr/bin/script -q /dev/null " + [process.execPath, ...argv].map(quote).join(' ')], { cwd, env: playerEnvironment, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(process.execPath, argv, { cwd, env: playerEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', part => { stdout += part; });
    child.stderr.on('data', part => { stderr += part; });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    const cancel = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      const matchId = cwd.split('/').at(-2);
      if (args.includes('-p') && args.includes('--resume') && /^battle-[a-zA-Z0-9-]+$/.test(matchId ?? '') && cwd.startsWith(join(ROOT,'.runtime/battle-workspaces') + '/')) {
        privateJson(join(ROOT,'runs',matchId,'agh-' + seat.toLowerCase() + '-invocation.json'), { at:new Date().toISOString(),exitCode:code,stdout,stderr });
      }
      if (code !== 0) {
        const error = new Error('AGH command failed: ' + args.slice(0, 3).join(' '));
        error.result = { stdout, stderr, exitCode: code };
        reject(error);
      }
      else resolveDone({ stdout, stderr });
    });
  });
}

// Create and name the durable AGH session before its one whole-match prompt starts.
// This makes the real session available to the official workbench during the game.
export async function createPlayerSession(seat, cwd, title, model) {
  if (!model?.route || !model?.model) throw new Error('Expected the admitted battle model');
  const { TYPESAFE_API_KEY, ...environment } = process.env;
  return new Promise((done, fail) => execFile(join(ROOT, '../agnes-harness/node_modules/.bin/tsx'),
    [join(ROOT, 'scripts/battle-session.ts'), PLAYER_HOMES[seat], cwd, title, model.route, model.model],
    { cwd: ROOT, env: environment, timeout: 60000 },
    (error, stdout) => error ? fail(new Error('Cannot create player ' + seat + ' session')) : done(JSON.parse(stdout).sessionId)));
}

export async function settlePlayerResources(jobs) {
  const { TYPESAFE_API_KEY, ...environment } = process.env;
  const results = await Promise.allSettled(['A', 'B'].map(seat => new Promise((done, fail) => execFile(
    join(ROOT, '../agnes-harness/node_modules/.bin/tsx'),
    [join(ROOT, 'scripts/battle-resources.ts'), PLAYER_HOMES[seat], ...jobs.map(job => join(ROOT, '.runtime/battle-workspaces', job.id, seat))],
    { cwd: ROOT, env: environment, timeout: 120000 },
    (error, stdout, stderr) => error ? fail(new Error('Cannot settle player ' + seat + ' resources: ' + String(stderr).slice(-2000))) : done(),
  ))));
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
}

export function modelConfigs() {
  const globalHome = process.env.BATTLE_MODEL_HOME ?? join(homedir(), '.agh');
  const saved = JSON.parse(readFileSync(join(globalHome, 'profiles/local-dev/configuration.json'), 'utf8'));
  const isAgnes = a => a.enabled !== false && a.model?.startsWith('agnes-');
  let account = saved.accounts.find(a => a.accountId === saved.defaultAccountId && isAgnes(a)) ?? saved.accounts.find(isAgnes);
  let credentialHome = globalHome;
  // An already provisioned player has its own account. Global UI account changes
  // do not replace that independent model or require enabling a global account.
  const playerProfile = join(PLAYER_HOMES.A, 'profiles/local-dev/profile.yaml');
  if (!account && existsSync(playerProfile)) {
    const route = JSON.parse(readFileSync(playerProfile, 'utf8')).provider?.routes?.find(r => r.route === 'battle-agnes');
    if (route?.models?.[0]?.id?.startsWith('agnes-')) {
      const original = join(ROOT, '.runtime/primary-model-upstreams.json');
      account = { model: route.models[0].id, baseUrl: existsSync(original) ? JSON.parse(readFileSync(original, 'utf8')).A : route.baseUrl, credentialRef: route.credentialRef };
      credentialHome = PLAYER_HOMES.A;
    }
  }
  if (!account) throw new Error('No saved Agnes model account');
  const ref = account.credentialRef.replace('secret://', '');
  const agnesKey = JSON.parse(readFileSync(join(credentialHome, 'secrets', ref), 'utf8')).value;
  const deepseekKey = JSON.parse(readFileSync(join(globalHome, 'secrets/claude-gateway/deepseek-flash'), 'utf8')).value;
  return {
    A: { route: 'battle-agnes', model: account.model, api: 'openai-completions', baseUrl: account.baseUrl, key: agnesKey, reasoning: false },
    B: { route: 'battle-deepseek', model: 'deepseek-flash', api: 'anthropic-messages', baseUrl: process.env.BATTLE_DEEPSEEK_BASE_URL, key: deepseekKey, reasoning: true },
  };
}

function profile(home, config, installed, preset = 'battle', catalog = [config]) {
  const routes = catalog.map(config => ({
    route: config.route, api: config.api, baseUrl: config.baseUrl, credentialRef: 'secret://battle/' + config.route,
    models: [{ id: config.model, name: displayModelName(config), route: config.route, api: config.api, baseUrl: config.baseUrl,
      reasoning: config.reasoning, input: ['text'], contextWindow: config.contextWindow ?? Number(process.env.BATTLE_CONTEXT_WINDOW ?? 128000), maxTokens: Number(process.env.BATTLE_OUTPUT_CAP ?? 8192),
      contract_id: null, toolCallFormats: ['native'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      thinkingReplay: config.reasoning ? 'native' : 'drop',
      ...((config.reasoning || config.compat) ? { compat: { ...(config.reasoning ? { allowEmptySignature: true } : {}), ...config.compat } } : {}),
    }],
  }));
  // JSON is also YAML. Only secret references are present here; keys stay in the private store.
  return {
    name: 'local-dev',
    packages: installed
      ? [{ id: '@agnes/code', source: 'builtin', enabled: false },
        ...['skill-helper', 'mcp-helper', 'plugin-helper'].map(name => ({ id: '@agnes/' + name, source: 'builtin', enabled: false })),
        { id: PLUGIN, source: 'file:./packages/agh-battle-plugin' }]
      : [],
    provider: { package: '@agnes/ai', adapters: ['@agnes/ai'], routes, catalog: { include: [] } },
    adapters: { secrets: { kind: 'file', path: join(home, 'secrets') } },
    computerUse: { enabled: false },
    ...(installed ? { policy: { capabilityCeiling: [], workspacePackages: 'deny' } } : {}),
    ...(installed ? { presets: { default: preset, allowed: [preset] } } : {}),
  };
}

async function stopPlayer(seat) {
  await cli(seat, ['daemon', 'stop']).catch(() => {});
  // Some macOS builds report a stale start identity. Only stop the process whose
  // command line explicitly names this isolated player's data directory.
  const home = PLAYER_HOMES[seat];
  const ownerFile = join(home, 'data/daemon/owner.json');
  if (!existsSync(ownerFile)) return;
  const { pid } = JSON.parse(readFileSync(ownerFile, 'utf8'));
  let command;
  try { command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }); } catch { return; }
  if (!command.includes('/daemon.mjs ') || !command.includes('--data-dir ' + join(home, 'data'))) return;
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 50; i++) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise(resolveDone => setTimeout(resolveDone, 100));
  }
  throw new Error('Isolated player daemon did not stop');
}

export async function preparePlayers(arenaUrl) {
  const configs = modelConfigs();
  privateJson(join(ROOT, '.runtime/primary-model-upstreams.json'), { A: configs.A.baseUrl });
  configs.A.label = displayModelName(configs.A); configs.B.label = displayModelName(configs.B);
  configs.A.baseUrl = process.env.BATTLE_DEEPSEEK_BASE_URL + '/v1';
  const catalog = [...Object.values(configs), ...loadExtraModels(ROOT).map(model => ({ ...model,
    baseUrl: process.env.BATTLE_DEEPSEEK_BASE_URL + (model.api === 'openai-completions' ? '/v1' : ''),
  }))];
  const tokens = {};
  const integrity = hashDirectory(join(ROOT, 'packages/agh-battle-plugin'));
  for (const seat of ['A', 'B']) {
    const home = PLAYER_HOMES[seat];
    mkdirSync(home, { recursive: true, mode: 0o700 }); chmodSync(home, 0o700);
    const bindingPath = join(home, 'battle-binding.json');
    tokens[seat] = existsSync(bindingPath) ? JSON.parse(readFileSync(bindingPath, 'utf8')).token : randomUUID();
    privateJson(bindingPath, { arenaUrl, seat, token: tokens[seat] });
    for (const model of catalog) privateJson(join(home, 'secrets/battle', model.route), { kind: 'api-key', provider: 'battle', value: model.key, version: 1 });
    const profilePath = join(home, 'profiles/local-dev/profile.yaml');
    const lockPath = join(home, 'profiles/local-dev/agnes-lock.json');
    let entry = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')).packages?.[PLUGIN] : null;
    if (entry?.treeIntegrity !== integrity) {
      await stopPlayer(seat);
      privateJson(profilePath, profile(home, configs[seat], false, 'battle', catalog));
      if (entry) {
        await cli(seat, ['package', 'disable', PLUGIN], { timeoutMs: 100000 });
        await cli(seat, ['package', 'remove', PLUGIN]);
      }
      await cli(seat, ['install', 'file:./packages/agh-battle-plugin'], { interactive: true });
      entry = JSON.parse(readFileSync(lockPath, 'utf8')).packages?.[PLUGIN];
      if (!entry) throw new Error('Battle plugin missing after install');
      await cli(seat, ['package', 'trust', PLUGIN, entry.integrity, capabilityHash(entry)]);
    }
    if (!entry?.state?.trusted) {
      await cli(seat, ['package', 'trust', PLUGIN, entry.integrity, capabilityHash(entry)]);
    }
    if (!entry?.state?.enabled) {
      await stopPlayer(seat);
      privateJson(profilePath, profile(home, configs[seat], true, 'base', catalog));
      await cli(seat, ['daemon', 'start', '--workspace', ROOT]);
      await cli(seat, ['package', 'enable', PLUGIN], { timeoutMs: 100000 });
    }
    await stopPlayer(seat);
    privateJson(profilePath, profile(home, configs[seat], true, 'battle', catalog));
    await cli(seat, ['daemon', 'start', '--workspace', ROOT]);
    let line;
    for (let attempt = 0; attempt < 25; attempt++) {
      const status = await cli(seat, ['package', 'status']);
      line = status.stdout.split('\n').find(line => line.startsWith(PLUGIN + '@'));
      if (line?.includes('actual=running')) break;
      await new Promise(resolveDone => setTimeout(resolveDone, 500));
    }
    if (!line?.includes('actual=running')) throw new Error('Battle plugin is not running: ' + line);
    const { TYPESAFE_API_KEY, ...environment } = process.env;
    await new Promise((done, fail) => execFile(join(ROOT, '../agnes-harness/node_modules/.bin/tsx'), [join(ROOT, 'scripts/battle-tools.ts'), home], { cwd: ROOT, env: environment, timeout: 60000 }, (error, stdout, stderr) => error ? fail(new Error('Cannot restrict player tools: ' + stderr)) : done(stdout)));
    console.log('Battle player ' + seat + ': ' + configs[seat].model + ' ready');
  }
  const publicModel = c => modelForDisplay({ route: c.route, model: c.model, label: c.label, api: c.api, baseUrl: c.baseUrl, contextWindow: c.contextWindow ?? Number(process.env.BATTLE_CONTEXT_WINDOW ?? 128000), maxTokens: Number(process.env.BATTLE_OUTPUT_CAP ?? 8192) });
  return { tokens, models: Object.fromEntries(Object.entries(configs).map(([seat, c]) => [seat, publicModel(c)])), catalog: catalog.map(publicModel) };
}
