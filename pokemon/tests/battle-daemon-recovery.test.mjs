import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { abortRelayBefore, abortRelayAfter } from '../scripts/battle-daemon-recovery.mjs';

const runtimeSource = new URL('../.runtime/battle-agh-runtime/daemon.mjs', import.meta.url);
const source = readFileSync(existsSync(runtimeSource)
  ? runtimeSource
  : new URL('./fixtures/battle-remote-session.mjs', import.meta.url), 'utf8');
const start = source.indexOf('var RemoteSession = class');
assert.ok(start >= 0);
const end = source.indexOf('\n// ', start);
const remoteSession = source.slice(start, end).replace(abortRelayAfter, abortRelayBefore);

function exercise(patched, failAbort) {
  const code = remoteSession.replace(abortRelayBefore, patched ? abortRelayAfter : abortRelayBefore) + `
    const failure = { code: 'E_SESSION', message: 'Session unavailable' };
    let finish;
    const link = { alive: true, command(method) {
      if (method === 'run') return new Promise((resolve, reject) => { finish = reject; });
      if (method === 'abort') return ${failAbort ? 'Promise.reject(failure)' : 'Promise.resolve()'};
      if (method === 'latest') return Promise.resolve({ stillPending: true });
    }};
    const session = new RemoteSession('test-session', 'test-run', 1, link, '/tmp');
    const controller = new AbortController();
    const run = session.run({ until: 'turn-end', signal: controller.signal });
    run.catch(error => { if (error !== failure) throw new Error('Original run failure changed'); });
    controller.abort();
    finish(failure);
    setTimeout(() => {
      if (session.running) throw new Error('Activity was not released');
      console.log('original run failure preserved');
    }, 20);
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
}

test('original abort relay crashes on an object-valued worker rejection', () => {
  const result = exercise(false, true);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ERR_UNHANDLED_REJECTION/);
});

test('failed abort relay is recorded while the original run still fails', () => {
  const result = exercise(true, true);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /battle-abort-relay-failed/);
  assert.match(result.stderr, /E_SESSION/);
  assert.match(result.stdout, /original run failure preserved/);
});

test('successful abort relay preserves the original run failure too', () => {
  const result = exercise(true, false);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /battle-abort-relay-failed/);
  assert.match(result.stdout, /original run failure preserved/);
});
