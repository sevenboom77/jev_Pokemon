import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient, memoryJournal } from '../../agnes-harness/packages/sdk/src/index.node.ts';

const [home, ...workspaces] = process.argv.slice(2);
if (!home || !resolve(home).includes('/pokemon/.runtime/battle-agh-') || !workspaces.length) throw new Error('Expected isolated battle resources');
const owner = JSON.parse(readFileSync(join(home, 'data/daemon/owner.json'), 'utf8'));
const client = createClient({ transport: { kind: 'unix', path: owner.socketPath }, auth: { kind: 'local' }, journal: memoryJournal(), timeouts: { request: 30000 } });
try {
  // Let the official 200ms onBound watcher dispatch its automatic scans first.
  await new Promise(done => setTimeout(done, 300));
  for (const cwd of workspaces) {
    const { workspace } = await client.workspace.add(cwd);
    if (!workspace.workspaceId) throw new Error('Missing registered workspace identity');
    // Concurrent automatic scans may advance the durable snapshot during a scan.
    // Retry this read-only workspace refresh before admitting any paid model task.
    for (let attempt = 0; ; attempt++) {
      const receipt = await client.skills.refresh({ profile: 'local-dev', rootKey: 'workspace-agnes', workspaceId: workspace.workspaceId, clientId: 'local', commandId: randomUUID() });
      let operation;
      for (;;) {
        operation = await client.resources.operation.get({ profile: 'local-dev', operationId: receipt.operationId });
        if (['succeeded', 'failed', 'cancelled'].includes(operation.state)) break;
        await new Promise(done => setTimeout(done, 250));
      }
      if (operation.state === 'succeeded') break;
      if (attempt >= 4 || operation.state === 'cancelled') throw new Error('Resource preparation failed: ' + JSON.stringify(operation));
      await new Promise(done => setTimeout(done, 250 * (attempt + 1)));
    }
  }
} finally { await client.close(); }
