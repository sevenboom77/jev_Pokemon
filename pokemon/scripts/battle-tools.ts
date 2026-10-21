// Use AGH's public package administration API to limit each player to arena tools.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createClient, memoryJournal } from '../../agnes-harness/packages/sdk/src/index.node.ts';
import { buildRuntimeTarget, decodeRuntimeTargetArtifact, encodeRuntimeTargetArtifact } from '../../agnes-harness/packages/plugin-runtime/src/runtime-target.ts';

const home = process.argv[2];
if (!home || !resolve(home).includes('/pokemon/.runtime/battle-agh-')) throw new Error('Expected an isolated battle player home');
const owner = JSON.parse(readFileSync(join(home, 'data/daemon/owner.json'), 'utf8'));
const client = createClient({ transport: { kind: 'unix', path: owner.socketPath }, auth: { kind: 'local' }, journal: memoryJournal(), timeouts: { request: 30000 } });
try {
  const view = await client.packages.tree.get({ profile: 'local-dev' });
  if (!view.desired) throw new Error('Player has no runtime target');
  const target = decodeRuntimeTargetArtifact(view.desired);
  const rows = [...target.tree.rows, ...Object.values(target.resource.rows).filter(Boolean)]
    .map(row => ({ ...row, disabled: row.disabled || row.id.startsWith('ext:agnes/') || /ext:(skill|mcp|plugin)-helper\//.test(row.id) }));
  const revision = createHash('sha256').update(JSON.stringify({ rows, resources: { mcp: [], skills: {} } })).digest('hex');
  const artifact = encodeRuntimeTargetArtifact(buildRuntimeTarget({ rows, resources: { mcp: [], skills: {} }, resourceRevision: revision, compositeRevision: revision }));
  if (artifact.digest !== view.desired.digest) await client.packages.tree.apply({ profile: 'local-dev', clientId: await client.clientId(), commandId: 'battle-tools-' + randomUUID(), artifact });
  let state;
  for (let i = 0; i < 40; i++) {
    state = await client.packages.tree.list({ profile: 'local-dev' });
    if (state.actual && !state.pending && state.reportOk) break;
    if (state.failurePhase) throw new Error('Tool restriction failed: ' + state.failurePhase);
    await new Promise(done => setTimeout(done, 250));
  }
  if (!state?.reportOk || state.pending) throw new Error('Tool restriction did not converge');
  const evidence = { digest: artifact.digest, enabledExtensions: rows.filter(row => !row.disabled && row.id.startsWith('ext:')).map(row => row.id), disabledExtensions: rows.filter(row => row.disabled && row.id.startsWith('ext:')).map(row => row.id), observed: state };
  writeFileSync(join(home, 'battle-tools.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ enabledExtensions: evidence.enabledExtensions, actual: state.actual, reportOk: state.reportOk }));
} finally { await client.close(); }
