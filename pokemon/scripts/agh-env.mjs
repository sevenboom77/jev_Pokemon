// scripts/agh-env.mjs
//
// Idempotently provision two isolated AGH_HOMEs for the Pokemon TCG arena:
//   .runtime/agh-a  -> route jev-bridge-a
//   .runtime/agh-b  -> route jev-bridge-b
// It writes profile.yaml + a file secret store, installs/trusts/enables
// @pokemon/agh-tcg-plugin through the real AGH daemon package manager, and prints
// the two absolute HOME paths and route names.
//
// Constraints baked in by the integration findings (see evidence/agh-seam-result.md):
//   * /Users/USER/.agh is never touched: every command sets AGH_HOME to a project path.
//   * agnes-harness is only read/executed, never modified.
//   * this AGH build (5da4073) only accepts builtin template names as `--profile`; the
//     per-home profile directory therefore has to be `local-dev`. Route names carry the
//     A/B identity.
//   * non-builtin plugin loading requires the daemon path; `--standalone` refuses with
//     E_EXT_LOAD because local boot passes no runtimePluginSnapshots.
//   * `agh install` confirms on a TTY, so install is driven through /usr/bin/script.

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const PROFILE = 'local-dev'
export const MODEL = 'jev-agent-bridge'
export const PLUGIN_ID = '@pokemon/agh-tcg-plugin'
export const PLUGIN_SOURCE = 'file:./packages/agh-tcg-plugin'
export const PROBE_PORT = Number(process.env.AGH_PROBE_PORT || 8791)
export function arenaUrl() {
  return (process.env.AGH_ARENA_URL || 'http://127.0.0.1:8788').replace(/\/+$/, '')
}

export function routeBaseUrl(route) {
  const override = route === 'jev-bridge-a' ? process.env.AGH_ROUTE_BASE_A : process.env.AGH_ROUTE_BASE_B
  if (override !== undefined && String(override).trim().length > 0) return String(override).trim().replace(/\/+$/, '')
  return arenaUrl() + (route === 'jev-bridge-a' ? '/seat-a/v1' : '/seat-b/v1')
}
export const HOMES = Object.freeze([
  Object.freeze({ label: 'a', home: join(PROJECT_ROOT, '.runtime', 'agh-a'), route: 'jev-bridge-a' }),
  Object.freeze({ label: 'b', home: join(PROJECT_ROOT, '.runtime', 'agh-b'), route: 'jev-bridge-b' }),
])
const AGH_AGNES =
  process.env.AGH_AGNES ||
  '/Users/USER/code/projects/deepseek-harness/agnes-harness/packages/cli/dist/local/agnes.mjs'
const PLUGIN_DIR = join(PROJECT_ROOT, 'packages', 'agh-tcg-plugin')
const SECRET_NS = 'pokemon'
const SECRET_NAME = 'local-probe'
const SECRET_REF = 'secret://' + SECRET_NS + '/' + SECRET_NAME

function log(...args) {
  console.log('[agh-env]', ...args)
}

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    cwd: opts.cwd ?? PROJECT_ROOT,
    env: opts.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

export function runAghAsync(home, args, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [AGH_AGNES, ...args], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, AGH_HOME: home, AGNES_PROFILE: PROFILE },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code, signal) => resolvePromise({ status: code, signal, stdout, stderr }))
  })
}

export function runAgh(home, args, opts = {}) {
  const result = run(process.execPath, [AGH_AGNES, ...args], {
    env: { ...process.env, AGH_HOME: home, AGNES_PROFILE: PROFILE },
  })
  if (result.status !== 0 && opts.allowFailure !== true) {
    throw new Error(
      'agh ' + args.join(' ') + ' failed (status=' + String(result.status) + ')\\n' + result.stdout + result.stderr,
    )
  }
  return result
}

function ensureDir(dir, mode = 0o700) {
  mkdirSync(dir, { recursive: true, mode })
  try {
    chmodSync(dir, mode)
  } catch {}
}

function writePrivateFile(file, value) {
  ensureDir(dirname(file), 0o700)
  writeFileSync(file, value, { mode: 0o600 })
  chmodSync(file, 0o600)
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
        .join(',') +
      '}'
    )
  }
  return JSON.stringify(value) ?? 'null'
}

export function capabilityHash(entry) {
  return createHash('sha256')
    .update(canonical({ contributions: entry.contributions ?? [], dependencies: entry.dependencies ?? {} }))
    .digest('hex')
}

export function hashDirectory(dir) {
  const root = realpathSync(dir)
  const files = []
  const walk = (current) => {
    for (const dirent of readdirSync(current, { withFileTypes: true })) {
      const file = join(current, dirent.name)
      const rel = relative(root, file).split(sep).join('/')
      const stat = lstatSync(file)
      if (stat.isSymbolicLink()) throw new Error('package tree contains a symbolic link: ' + rel)
      if (stat.isDirectory()) {
        walk(file)
        continue
      }
      if (stat.isFile() === false) throw new Error('package tree contains a special entry: ' + rel)
      files.push({ rel, file })
    }
  }
  walk(root)
  const outer = createHash('sha256')
  for (const { rel, file } of files.sort((left, right) => (left.rel < right.rel ? -1 : left.rel > right.rel ? 1 : 0))) {
    outer.update(createHash('sha256').update(rel).update('\0').update(readFileSync(file)).digest())
  }
  return 'sha256-' + outer.digest('hex')
}

export function profilePath(home) {
  return join(home, 'profiles', PROFILE, 'profile.yaml')
}

export function lockPath(home) {
  return join(home, 'profiles', PROFILE, 'agnes-lock.json')
}

function profileYaml(home, route, includePlugin) {
  const pluginLine = includePlugin
    ? 'packages:\n  - { id: "' + PLUGIN_ID + '", source: "' + PLUGIN_SOURCE + '" }\n'
    : ''
  const name = route === 'jev-bridge-a' ? 'Jev Agent Bridge A' : 'Jev Agent Bridge B'
  const baseUrl = routeBaseUrl(route)
  return (
    'name: ' + PROFILE + '\n' +
    pluginLine +
    'provider:\n' +
    '  package: "@agnes/ai"\n' +
    '  adapters: ["@agnes/ai"]\n' +
    '  routes:\n' +
    '    - route: ' + route + '\n' +
    '      api: openai-completions\n' +
    '      baseUrl: ' + baseUrl + '\n' +
    '      credentialRef: ' + SECRET_REF + '\n' +
    '      models:\n' +
    '        - id: ' + MODEL + '\n' +
    '          name: ' + name + '\n' +
    '          api: openai-completions\n' +
    '          route: ' + route + '\n' +
    '          baseUrl: ' + baseUrl + '\n' +
    '          reasoning: false\n' +
    '          input: [text]\n' +
    '          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }\n' +
    '          contextWindow: 128000\n' +
    '          maxTokens: 4096\n' +
    '          toolCallFormats: [native]\n' +
    '          thinkingReplay: drop\n' +
    '          contract_id: null\n' +
    'adapters:\n' +
    '  storage: sqlite\n' +
    '  fs: local\n' +
    '  exec: local\n' +
    '  platform: host\n' +
    '  secrets: { kind: file, path: "' + join(home, 'secrets') + '" }\n'
  )
}

export function writeProfile(home, route, includePlugin) {
  ensureDir(join(home, 'profiles', PROFILE), 0o700)
  writePrivateFile(profilePath(home), profileYaml(home, route, includePlugin))
}

export function readLock(home) {
  try {
    return JSON.parse(readFileSync(lockPath(home), 'utf8'))
  } catch {
    return null
  }
}

/**
 * On macOS the discovery record can disagree with the live process start id (the same
 * known issue drone-show hit). A live pid plus the unix socket is the honest signal that
 * a session can still be opened, so Supervisor startup trusts it instead of restarting.
 */
export function daemonAlive(home) {
  try {
    const owner = readOwner(home)
    if (owner === null) return false
    process.kill(owner.pid, 0)
    const socket = typeof owner.socketPath === 'string' ? owner.socketPath : join(home, 'data', 'daemon', 'agnesd.sock')
    return existsSync(socket)
  } catch {
    return false
  }
}

export function daemonRunning(home) {
  const result = runAgh(home, ['daemon', 'status', '--profile', PROFILE], { allowFailure: true })
  if (result.status !== 0) return false
  try {
    return JSON.parse(result.stdout).running === true
  } catch {
    return false
  }
}

/**
 * The daemon forks a worker that actually runs plugin tool code. Observed failure mode: the
 * daemon stays up while its worker disappears, and the next headless session hangs with no
 * request ever reaching the model. Supervisor checks this before every decision.
 */
export function workerAlive(home) {
  try {
    const owner = readOwner(home)
    if (owner === null) return false
    const result = spawnSync('ps', ['-eo', 'ppid,command'], { encoding: 'utf8' })
    const output = String(result.stdout ?? '')
    return output.split('\n').some((line) => {
      const trimmed = line.trim()
      if (trimmed === '') return false
      const space = trimmed.indexOf(' ')
      if (space === -1) return false
      const ppid = Number(trimmed.slice(0, space))
      const command = trimmed.slice(space + 1)
      return ppid === owner.pid && command.includes('worker.mjs')
    })
  } catch {
    return false
  }
}

/** Blocks until a real RPC against the daemon succeeds (worker up, socket answering). */
export function waitDaemonReady(home, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const probe = runAgh(home, ['sessions', '--json'], { allowFailure: true })
    if (probe.status === 0) {
      try {
        JSON.parse(probe.stdout)
        return true
      } catch {}
    }
    const until = Date.now() + 500
    while (Date.now() < until) {
      // bounded wait
    }
  }
  return false
}

/** Stops and starts the daemon for a home; returns true when it answers an RPC again. */
export function restartDaemon(home, timeoutMs = 30000) {
  stopDaemon(home)
  startDaemon(home)
  return waitDaemonReady(home, timeoutMs)
}

export function startDaemon(home) {
  // Idempotent: an already-running daemon is the normal case when the Supervisor
  // and the probe reuse the same isolated HOME (Lead integration fix).
  if (daemonRunning(home) || (daemonAlive(home) && workerAlive(home))) return
  if (daemonAlive(home)) stopDaemon(home)
  runAgh(home, ['daemon', 'start', '--profile', PROFILE, '--workspace', PROJECT_ROOT])
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (daemonRunning(home)) return
    const until = Date.now() + 250
    while (Date.now() < until) {
      // bounded busy wait keeps this dependency-free and synchronous
    }
  }
  throw new Error('daemon did not become ready for ' + home)
}

export function stopDaemon(home) {
  runAgh(home, ['daemon', 'stop', '--profile', PROFILE], { allowFailure: true })
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (daemonRunning(home) === false && daemonAlive(home) === false) return
    const until = Date.now() + 250
    while (Date.now() < until) {
      // bounded wait
    }
  }
  // The discovery record can be stale on macOS, so `daemon stop` may report success while the
  // real process keeps the socket. Kill the recorded pid so `agh install` can start a fresh
  // daemon of its own instead of failing with "child exited before readiness".
  const owner = readOwner(home)
  if (owner !== null) {
    try {
      process.kill(owner.pid, 'SIGTERM')
    } catch {}
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (daemonAlive(home) === false) return
      const until = Date.now() + 250
      while (Date.now() < until) {
        // bounded wait
      }
    }
    try {
      process.kill(owner.pid, 'SIGKILL')
    } catch {}
  }
  if (daemonAlive(home)) log('warning: daemon for ' + home + ' still looks alive after stop')
}

function readOwner(home) {
  try {
    const owner = JSON.parse(readFileSync(join(home, 'data', 'daemon', 'owner.json'), 'utf8'))
    return typeof owner?.pid === 'number' && owner.pid > 0 ? owner : null
  } catch {
    return null
  }
}

export function pluginState(home, sourceTreeIntegrity) {
  const lock = readLock(home)
  const entry = lock?.packages?.[PLUGIN_ID]
  if (entry === undefined) return { installed: false, reason: 'not-installed' }
  if (entry.treeIntegrity !== sourceTreeIntegrity) return { installed: false, reason: 'stale-tree', entry }
  if (entry.state?.trusted === null || entry.state?.trusted === undefined) return { installed: false, reason: 'untrusted', entry }
  if (entry.state?.enabled !== true) return { installed: false, reason: 'disabled', entry }
  return { installed: true, entry, lock }
}

function shellQuote(value) {
  return "'" + String(value).replaceAll("'", "'\\''") + "'"
}

function installPlugin(home) {
  const command =
    "(sleep 2; printf '%s\\n' y; sleep 5) | " +
    '/usr/bin/script -q /dev/null ' +
    shellQuote(process.execPath) + ' ' +
    shellQuote(AGH_AGNES) + ' install ' +
    shellQuote(PLUGIN_SOURCE) + ' --profile ' + shellQuote(PROFILE)
  return new Promise((resolvePromise, reject) => {
    const child = spawn('/bin/bash', ['-c', command], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, AGH_HOME: home, AGNES_PROFILE: PROFILE },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      resolvePromise({ code, stdout, stderr })
    })
  })
}

export function removePlugin(home) {
  const result = runAgh(home, ['package', 'remove', PLUGIN_ID, '--profile', PROFILE], { allowFailure: true })
  return result
}

export function trustPlugin(home, entry) {
  runAgh(home, [
    'package',
    'trust',
    PLUGIN_ID,
    entry.integrity,
    capabilityHash(entry),
    '--profile',
    PROFILE,
  ])
}

export function enablePlugin(home) {
  runAgh(home, ['package', 'enable', PLUGIN_ID, '--profile', PROFILE])
  const status = runAgh(home, ['package', 'status', '--profile', PROFILE])
  const line = status.stdout
    .split('\n')
    .find((candidate) => candidate.startsWith(PLUGIN_ID + '@'))
  if (line === undefined || line.includes('desired=enabled') === false || line.includes('actual=running') === false) {
    throw new Error('plugin did not reach enabled/running: ' + (line ?? '<no status line>'))
  }
}

function packageDir(home) {
  return join(home, 'data', 'profiles', PROFILE, 'packages', PLUGIN_ID.replaceAll('/', '__'))
}

export function quarantinePlugin(home) {
  const lock = readLock(home)
  if (lock?.packages?.[PLUGIN_ID] !== undefined) {
    delete lock.packages[PLUGIN_ID]
    writeFileSync(lockPath(home), JSON.stringify(lock, null, 2) + '\n')
  }
  rmSync(packageDir(home), { recursive: true, force: true })
}

function secretPath(home) {
  return join(home, 'secrets', SECRET_NS, SECRET_NAME)
}

export async function ensureHome(entry, sourceTreeIntegrity) {
  ensureDir(entry.home, 0o700)
  ensureDir(join(entry.home, 'profiles', PROFILE), 0o700)
  ensureDir(join(entry.home, 'secrets', SECRET_NS), 0o700)
  writePrivateFile(
    secretPath(entry.home),
    JSON.stringify({ kind: 'api-key', provider: SECRET_NS, value: 'agh-local-probe-key', version: 1 }),
  )

  const state = pluginState(entry.home, sourceTreeIntegrity)
  if (state.installed === false) {
    log('repairing ' + entry.home + ' (' + state.reason + ')')
    writeProfile(entry.home, entry.route, false)
    stopDaemon(entry.home)
    startDaemon(entry.home)
    quarantinePlugin(entry.home)
    const installed = await installPlugin(entry.home)
    const locked = readLock(entry.home)?.packages?.[PLUGIN_ID]
    if (locked === undefined) {
      throw new Error('install of ' + PLUGIN_ID + ' failed\\n' + installed.stdout + installed.stderr)
    }
    trustPlugin(entry.home, locked)
    enablePlugin(entry.home)
  } else {
    log('plugin already current in ' + entry.home)
  }

  writeProfile(entry.home, entry.route, true)
  stopDaemon(entry.home)
  startDaemon(entry.home)
  const finalEntry = readLock(entry.home)?.packages?.[PLUGIN_ID]
  return {
    label: entry.label,
    home: entry.home,
    route: entry.route,
    model: MODEL,
    baseUrl: routeBaseUrl(entry.route),
    integrity: finalEntry?.integrity ?? null,
  }
}

export function envJsonPath() {
  return join(PROJECT_ROOT, '.runtime', 'agh-env.json')
}

export function buildEnvJson(results) {
  const byLabel = Object.fromEntries(results.map((result) => [result.label, result]))
  return {
    cli: AGH_AGNES,
    profile: PROFILE,
    model: MODEL,
    homeA: HOMES[0].home,
    homeB: HOMES[1].home,
    routeA: HOMES[0].route,
    routeB: HOMES[1].route,
    baseUrlA: byLabel.a?.baseUrl ?? routeBaseUrl(HOMES[0].route),
    baseUrlB: byLabel.b?.baseUrl ?? routeBaseUrl(HOMES[1].route),
    daemonSocketA: join(HOMES[0].home, 'data', 'daemon', 'agnesd.sock'),
    daemonSocketB: join(HOMES[1].home, 'data', 'daemon', 'agnesd.sock'),
  }
}

export function writeEnvJson(results) {
  const payload = buildEnvJson(results)
  writePrivateFile(envJsonPath(), JSON.stringify(payload, null, 2) + '\n')
  return payload
}

export async function ensureEnv() {
  if (existsSync(AGH_AGNES) === false) throw new Error('AGH CLI entry not found: ' + AGH_AGNES)
  const sourceTreeIntegrity = hashDirectory(PLUGIN_DIR)
  const results = []
  for (const entry of HOMES) results.push(await ensureHome(entry, sourceTreeIntegrity))
  writeEnvJson(results)
  return results
}

export async function ensureUp() {
  const results = await ensureEnv()
  for (const entry of HOMES) startDaemon(entry.home)
  return writeEnvJson(results)
}

async function main() {
  if (existsSync(AGH_AGNES) === false) throw new Error('AGH CLI entry not found: ' + AGH_AGNES)
  await ensureEnv()
  for (const entry of HOMES) {
    const doctor = runAgh(entry.home, ['doctor', 'profile', '--profile', PROFILE, '--json'])
    let ok = false
    try {
      const sections = JSON.parse(doctor.stdout)
      ok = Array.isArray(sections) && sections.some((section) => section?.name === 'profile' && section.status === 'ok')
    } catch {}
    if (ok === false) throw new Error('doctor profile failed for ' + entry.home + '\\n' + doctor.stdout + doctor.stderr)
    log('doctor profile OK: ' + entry.home)
  }
  console.log('AGH_HOME_A=' + HOMES[0].home)
  console.log('AGH_HOME_B=' + HOMES[1].home)
  console.log('ROUTE_A=' + HOMES[0].route)
  console.log('ROUTE_B=' + HOMES[1].route)
  console.log('BASE_URL_A=' + routeBaseUrl(HOMES[0].route))
  console.log('BASE_URL_B=' + routeBaseUrl(HOMES[1].route))
  console.log('ENV_JSON=' + envJsonPath())
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  main().catch((error) => {
    console.error('[agh-env] FAILED')
    console.error(error)
    process.exit(1)
  })
}
