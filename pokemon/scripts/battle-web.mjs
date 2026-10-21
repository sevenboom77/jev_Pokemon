import { spawn } from 'node:child_process';
import { CLI, ROOT, PLAYER_HOMES, PLAYER_WEB_PORTS } from './battle-env.mjs';

const seat = process.argv[2];
if (!['A', 'B'].includes(seat)) throw new Error('Expected player A or B');
const { TYPESAFE_API_KEY, ...environment } = process.env;
const child = spawn(process.execPath, [CLI, 'serve', '--port', String(PLAYER_WEB_PORTS[seat]), '--cwd', ROOT], {
  cwd: ROOT,
  env: { ...environment, AGH_HOME: PLAYER_HOMES[seat], AGNES_WEB_ORIGIN: 'http://127.0.0.1:' + PLAYER_WEB_PORTS[seat] },
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 0; });
