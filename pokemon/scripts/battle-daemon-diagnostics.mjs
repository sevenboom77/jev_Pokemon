import { createHook } from 'node:async_hooks';
import { writeSync } from 'node:fs';

// Diagnostic metadata contains code paths, never model payloads or credentials.
// Keep fatal rejection behavior; this is not a process-wide error suppressor.
const origins = new WeakMap();
const hook = createHook({
  init(id, type, trigger, resource) {
    if (type !== 'PROMISE') return;
    const stack = new Error('Promise created').stack;
    if (stack?.includes('battle-agh-runtime/daemon.mjs')) origins.set(resource, stack);
  },
});
hook.enable();
process.on('unhandledRejection', (reason, promise) => {
  hook.disable();
  const safeCode = value => typeof value === 'string' && /^[A-Z0-9_-]{1,80}$/.test(value) ? value : typeof value === 'number' ? value : null;
  const diagnostic = {
    type: 'battle-daemon-fatal-rejection', at: new Date().toISOString(), pid: process.pid,
    reasonType: reason?.constructor?.name ?? typeof reason,
    code: safeCode(reason?.code), detailCode: safeCode(reason?.data?.code),
    method: typeof reason?.data?.method === 'string' && /^[a-zA-Z0-9._-]{1,80}$/.test(reason.data.method) ? reason.data.method : null,
    promiseOrigin: origins.get(promise) ?? null,
  };
  writeSync(2, JSON.stringify(diagnostic) + '\n');
  process.exit(1);
});
