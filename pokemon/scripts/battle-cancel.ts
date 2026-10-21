import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient, memoryJournal } from '../../agnes-harness/packages/sdk/src/index.node.ts';

const [root, matchId] = process.argv.slice(2);
if (!root || !/^battle-[a-f0-9]+$/.test(matchId ?? '')) throw new Error('Expected a battle identity');
const battle = JSON.parse(readFileSync(join(root, 'runs', matchId, 'battle.json'), 'utf8'));
await Promise.all(['A','B'].map(async seat => {
  const home = join(root, '.runtime/battle-agh-' + seat.toLowerCase());
  const owner = JSON.parse(readFileSync(join(home, 'data/daemon/owner.json'), 'utf8'));
  const client = createClient({ transport: { kind:'unix', path:owner.socketPath }, auth:{ kind:'local' }, journal:memoryJournal() });
  try {
    const session = await client.session.load(battle.sessions[seat], { cwd:join(root,'.runtime/battle-workspaces',matchId,seat) });
    await session.cancel();
  } finally { await client.close(); }
}));
console.log('Requested cancellation of both tasks for ' + matchId);
