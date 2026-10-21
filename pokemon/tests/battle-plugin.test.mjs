import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { battlePlugin } from '../packages/agh-battle-plugin/index.mjs';

test('the AGH completion hook keeps the same task open until the environment confirms termination', async () => {
  const home = mkdtempSync(join(tmpdir(), 'battle-hook-test-'));
  const originalHome = process.env.AGH_HOME, originalFetch = globalThis.fetch;
  const tools = new Map(), hooks = new Map(), signal = new AbortController().signal;
  let finished = false;
  try {
    process.env.AGH_HOME = home;
    writeFileSync(join(home, 'battle-binding.json'), JSON.stringify({ arenaUrl: 'http://127.0.0.1:1', token: 'synthetic-test-token', seat: 'A' }));
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ matchId: 'synthetic', finished }) });
    battlePlugin.apply({ extension: () => ({ registerTool: tool => tools.set(tool.name, tool), registerHook: (name, hook) => hooks.set(name, hook) }) });
    const context = { session: { key: 'synthetic' }, signal };
    await tools.get('battle_observe').execute({ matchId: 'synthetic' }, context);
    assert.equal((await tools.get('battle_observe').execute({ matchId: 'other-game' }, context)).structured.error, 'E_MATCH_BINDING');
    const scoped = { session: { key: 'other-session', workspaceRoot: '/synthetic/battle-own/A' }, signal };
    assert.equal((await tools.get('battle_observe').execute({ matchId: 'battle-foreign' }, scoped)).structured.error, 'E_MATCH_BINDING');
    assert.equal((await tools.get('battle_observe').execute({ matchId: 'battle-own' }, scoped)).structured.finished, false);
    assert.equal((await hooks.get('turn_stopping')({}, context)).action, 'continue');
    finished = true;
    assert.equal((await hooks.get('turn_stopping')({}, context)).action, 'stop');
    assert.ok(tools.has('battle_wait'));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.AGH_HOME; else process.env.AGH_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  }
});
