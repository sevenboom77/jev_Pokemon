import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createClient, memoryJournal } from '../../agnes-harness/packages/sdk/src/index.node.ts';
import { createBoundBattleSession } from './battle-session-setup.mjs';

const [home, cwd, title, route, model] = process.argv.slice(2);
if (!home || !resolve(home).includes('/pokemon/.runtime/battle-agh-') || !cwd || !title || !route || !model) throw new Error('Expected an isolated battle home, workspace, title and admitted model');
const owner = JSON.parse(readFileSync(join(home, 'data/daemon/owner.json'), 'utf8'));
const client = createClient({ transport: { kind: 'unix', path: owner.socketPath }, auth: { kind: 'local' }, journal: memoryJournal(), timeouts: { request: 30000 } });
try {
  const sessionId = await createBoundBattleSession(client, cwd, title, { route, model });
  console.log(JSON.stringify({ sessionId }));
} finally { await client.close(); }
