import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { BattleMatch } from '../packages/battle-arena/match.mjs';
import { runPlayers } from '../packages/battle-arena/runner.mjs';
import { ROOT } from '../scripts/battle-env.mjs';

test('premature completion aborts instead of injecting another task for the next turn', async () => {
  const match = await new BattleMatch({ id: 'test-long-task-' + randomUUID() }).start();
  const starts = [], models = Object.fromEntries(['A', 'B'].map(seat => [seat, { route: 'test', model: 'test' }]));
  try {
    const result = await runPlayers(match, models, {
      healthProbe: () => ({ pid: 1, generation: 'unit-test', alive: true, terminalReason: null }),
      openSession: async (seat, cwd, title, model) => {
        assert.deepEqual(model, models[seat]);
        return 'synthetic-' + seat;
      },
      invoke: async (seat, args) => {
        if (args[0] === 'export') return { stdout: '' };
        starts.push({ seat, prompts: args.filter(arg => arg === '-p').length });
        return { stdout: JSON.stringify({ sessionId: 'synthetic-' + seat, reason: 'completed' }) };
      },
    });
    assert.equal(result.status, 'aborted');
    assert.equal(result.winner, null);
    assert.equal(result.autonomousTaskVerified, false);
    assert.deepEqual(starts, [{ seat: 'A', prompts: 1 }, { seat: 'B', prompts: 1 }]);
    assert.match(result.error, /提前结束/);
    assert.equal(match.listenerCount('change'), 0);
  } finally {
    await match.close();
    rmSync(join(ROOT, 'runs', match.id), { recursive: true, force: true });
    rmSync(join(ROOT, '.runtime/battle-workspaces', match.id), { recursive: true, force: true });
  }
});

test('one failed final summary preserves the engine winner and lets the other AGH task finish', async () => {
  const match = await new BattleMatch({ id: 'test-finalize-' + randomUUID() }).start();
  const models = Object.fromEntries(['A', 'B'].map(seat => [seat, { route: 'test', model: 'test' }]));
  let healthyFinished = false;
  try {
    const result = await runPlayers(match, models, {
      healthProbe: () => ({ pid: 1, generation: 'unit-test', alive: true, terminalReason: null }),
      openSession: async seat => 'synthetic-' + seat,
      invoke: async (seat, args, options) => {
        if (args[0] === 'export') return { stdout: '' };
        if (seat === 'A') {
          match.status = 'finished'; match.finished = true; match.winner = 'B'; match.emit('change');
          throw new Error('A final-summary transport failed');
        }
        await new Promise(done => setTimeout(done, 20));
        assert.equal(options.signal.aborted, false);
        healthyFinished = true;
        return { stdout: JSON.stringify({ sessionId: 'synthetic-B', reason: 'completed' }) };
      },
    });
    assert.equal(result.status, 'finished'); assert.equal(result.winner, 'B');
    assert.equal(result.autonomousTaskVerified, false);
    assert.equal(result.taskResults.A.failureOrigin, 'player-task');
    assert.equal(result.taskResults.B.reason, 'completed');
    assert.equal(healthyFinished, true);
  } finally {
    await match.close();
    rmSync(join(ROOT, 'runs', match.id), { recursive: true, force: true });
    rmSync(join(ROOT, '.runtime/battle-workspaces', match.id), { recursive: true, force: true });
  }
});

for (const fault of ['daemon-restart', 'parked-task']) test(`a ${fault} ends the failed attempt without a second user task or waiting for the game deadline`, async () => {
  const match = await new BattleMatch({ id: 'test-health-' + randomUUID() }).start();
  const models = Object.fromEntries(['A', 'B'].map(seat => [seat, { route: 'test', model: 'test' }]));
  const starts = [];
  let polls = 0;
  try {
    const result = await runPlayers(match, models, {
      timeoutMs: 5000, healthIntervalMs: 10,
      openSession: async seat => 'synthetic-' + seat,
      healthProbe: seat => {
        if (seat === 'A') polls++;
        return { pid: 123, generation: fault === 'daemon-restart' && polls > 1 ? 'new' : 'old', alive: true,
          terminalReason: fault === 'parked-task' && seat === 'A' && polls > 1 ? 'parked' : null };
      },
      invoke: async (seat, args, { signal } = {}) => {
        if (args[0] === 'export') return { stdout: '' };
        starts.push({ seat, prompts: args.filter(arg => arg === '-p').length });
        await new Promise(done => signal.addEventListener('abort', done, { once: true }));
        throw new Error('stopped after the health check');
      },
    });
    assert.equal(result.status, 'aborted');
    assert.equal(result.winner, null);
    assert.equal(result.autonomousTaskVerified, false);
    assert.ok(result.elapsedMs < 2000);
    assert.deepEqual(starts, [{ seat: 'A', prompts: 1 }, { seat: 'B', prompts: 1 }]);
    assert.equal(result.traces.filter(t => t.type === 'agh-health-failure').length, 1);
    assert.match(result.error, /执行进程/);
  } finally {
    await match.close();
    rmSync(join(ROOT, 'runs', match.id), { recursive: true, force: true });
    rmSync(join(ROOT, '.runtime/battle-workspaces', match.id), { recursive: true, force: true });
  }
});
