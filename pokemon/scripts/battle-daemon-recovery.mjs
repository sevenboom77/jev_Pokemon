import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const abortRelayBefore = 'const onAbort = () => void this.link.command("abort", { runId });';
export const abortRelayAfter = `const onAbort = () => {
      void this.link.command("abort", { runId }).catch((error) => {
        const code = typeof error?.code === "string" && /^[A-Z0-9_-]{1,80}$/.test(error.code) ? error.code : null;
        console.error(JSON.stringify({ type: "battle-abort-relay-failed", at: new Date().toISOString(), sessionId: this.key, code }));
      });
    };`;

// The run RPC still reports its original outcome. Only the fire-and-forget abort
// relay is handled here; a failed request must not terminate unrelated sessions.
export function patchBattleDaemonAbort(root) {
  const path = join(root, '.runtime/battle-agh-runtime/daemon.mjs');
  const source = readFileSync(path, 'utf8');
  if (source.includes(abortRelayAfter)) return [];
  if (source.split(abortRelayBefore).length !== 2) throw new Error('Daemon abort relay patch target is not unique');
  const changed = source.replace(abortRelayBefore, abortRelayAfter);
  const hash = text => createHash('sha256').update(text).digest('hex');
  copyFileSync(path, path + '.before-abort-relay-' + hash(source).slice(0, 12));
  writeFileSync(path, changed);
  return [{ file: 'daemon.mjs', before: hash(source), after: hash(changed), changesTaskOutcome: false }];
}

export function patchBattleDaemonDiagnostics(root) {
  const path = join(root, '.runtime/battle-agh-runtime/daemon.mjs');
  const source = readFileSync(path, 'utf8');
  const diagnosticImport = 'import "../../scripts/battle-daemon-diagnostics.mjs";';
  if (source.includes(diagnosticImport)) return [];
  if (!source.startsWith('#!/usr/bin/env node\n')) throw new Error('Unexpected daemon bundle header');
  const changed = source.replace('#!/usr/bin/env node\n', '#!/usr/bin/env node\n' + diagnosticImport + '\n');
  const hash = text => createHash('sha256').update(text).digest('hex');
  copyFileSync(path, path + '.before-fatal-diagnostics-' + hash(source).slice(0, 12));
  writeFileSync(path, changed);
  return [{ file: 'daemon.mjs', before: hash(source), after: hash(changed), fatalBehaviorPreserved: true }];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  console.log(JSON.stringify([...patchBattleDaemonAbort(root), ...patchBattleDaemonDiagnostics(root)]));
}
