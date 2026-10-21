import test from 'node:test';
import assert from 'node:assert/strict';
import { BattleScheduler } from '../packages/battle-arena/scheduler.mjs';

test('concurrency can grow from 8 to 16 and 32 without restarting or cancelling existing games', () => {
  const scheduler = new BattleScheduler();
  assert.equal(scheduler.concurrency, 8);
  assert.equal(scheduler.setConcurrency(16).concurrency, 16);
  assert.equal(scheduler.setConcurrency(32).concurrency, 32);
  assert.throws(() => scheduler.setConcurrency(33), /1 to 32/);
});
import { BattleMatch } from '../packages/battle-arena/match.mjs';

const tick = () => new Promise(done => setImmediate(done));
const gate = () => { let release; const done = new Promise(resolve => { release = resolve; }); return { done, release }; };

test('a constrained model cannot fill the shared queue while unrelated games keep running', async () => {
  const scheduler = new BattleScheduler({ concurrency: 4 }), running = gate(), starts = [];
  for (const id of ['agnes-1', 'agnes-2', 'agnes-3', 'other-1', 'other-2']) {
    const route = id.startsWith('agnes') ? 'battle-agnes' : 'battle-glm';
    scheduler.enqueue({ id, models: { A: { route } }, run: async () => { starts.push(id); await running.done; return { status: 'finished' }; } });
  }
  await tick();
  assert.equal(scheduler.snapshot().running, 4);
  assert.deepEqual(starts, ['agnes-1', 'agnes-2', 'other-1', 'other-2']);
  running.release(); await scheduler.idle();
  assert.deepEqual(starts, ['agnes-1', 'agnes-2', 'other-1', 'other-2', 'agnes-3']);
});

test('all queued workspaces settle before any long task, and new preparation waits for active games', async () => {
  const firstPrep = gate(), running = gate(), prepared = [], starts = [];
  const scheduler = new BattleScheduler({ concurrency: 2, settlePreparation: async jobs => {
    assert.equal(scheduler.active.size, 0);
    assert.ok(jobs.every(job => prepared.includes(job.id)));
    if (jobs.some(job => job.id === 'one')) await firstPrep.done;
  } });
  for (const id of ['one','two']) scheduler.enqueue({ id, prepare: async () => { prepared.push(id); }, run: async () => { starts.push(id); await running.done; return { status: 'finished' }; } });
  await tick(); assert.equal(starts.length, 0); assert.deepEqual(prepared, ['one','two']);
  firstPrep.release(); await tick(); assert.deepEqual(starts, ['one','two']);
  scheduler.enqueue({ id:'three', prepare: async () => { prepared.push('three'); }, run: async () => { starts.push('three'); return { status:'finished' }; } });
  await tick(); assert.ok(!prepared.includes('three'));
  running.release(); await scheduler.idle(); assert.deepEqual(starts, ['one','two','three']);
});

test('a failed preparation drains all preparations before refusing paid tasks', async () => {
  const late = gate(); let settled = false;
  const scheduler = new BattleScheduler();
  const a=scheduler.enqueue({ id:'broken-prep', prepare: async () => { throw Error('binding failed'); }, run: () => assert.fail('paid task started') });
  const b=scheduler.enqueue({ id:'late-prep', prepare: async () => { await late.done; settled=true; }, run: () => assert.fail('paid task started') });
  await tick(); assert.equal(a.state,'queued');
  late.release(); await scheduler.idle(); assert.ok(settled); assert.equal(a.state,'failed');assert.equal(b.state,'failed');
});

test('failed Jev network evaluation is retried by the same task and only success is cached', async () => {
  const originalFetch=globalThis.fetch, originalKey=process.env.TYPESAFE_API_KEY;
  const match=await new BattleMatch({ id:'battle-jev-retry-test', jev:true }).start();let calls=0;
  try {
    process.env.TYPESAFE_API_KEY='synthetic-test-key';
    globalThis.fetch=async (_url,options) => {
      if(++calls===1)throw new TypeError('fetch failed');
      const body=JSON.parse(options.body), choice=Object.keys(body.questions.action.criteria)[0];
      return new Response(JSON.stringify({model:'jev-1.13.0',answers:{action:{choice,probabilities:{[choice]:1},confidence:1}}}));
    };
    const observation=match.observe('A');
    await assert.rejects(match.evaluate('A',observation.decisionId),/network/);
    const results=await Promise.all([match.evaluate('A',observation.decisionId),match.evaluate('A',observation.decisionId)]);
    assert.deepEqual(results[0],results[1]);assert.equal(calls,2);assert.equal(match.traces.filter(t=>t.type==='jev').length,1);
  } finally {
    globalThis.fetch=originalFetch;
    if(originalKey===undefined)delete process.env.TYPESAFE_API_KEY;else process.env.TYPESAFE_API_KEY=originalKey;
    await match.close();
  }
});

test('two games overlap, the third queues, and failure frees a slot without aborting another game', async () => {
  const scheduler = new BattleScheduler({ concurrency: 2 });
  const a = gate(), b = gate(), started = [];
  const first = scheduler.enqueue({ id: 'first', run: async () => { started.push('first'); await a.done; throw new Error('simulated upstream 429'); } });
  const second = scheduler.enqueue({ id: 'second', run: async () => { started.push('second'); await b.done; return { status: 'finished' }; } });
  const third = scheduler.enqueue({ id: 'third', run: async () => { started.push('third'); return { status: 'finished' }; } });
  await tick();
  assert.deepEqual(started, ['first', 'second']);
  assert.equal(scheduler.snapshot().running, 2); assert.equal(scheduler.snapshot().queued, 1);
  a.release(); await first.done; await tick();
  assert.equal(first.state, 'failed'); assert.equal(second.state, 'running');
  assert.deepEqual(started, ['first', 'second', 'third']);
  b.release(); await scheduler.idle();
  assert.equal(second.state, 'completed'); assert.equal(third.state, 'completed');
  assert.equal(scheduler.snapshot().running, 0);
});

test('two real rule engines resolve independent winners while all four player tasks are admitted', async () => {
  const scheduler = new BattleScheduler({ concurrency: 2 });
  const release = gate(), starts = [];
  const teams = {
    A: [{ species: 'Mewtwo', level: 100, moves: ['Psychic'] }],
    B: [{ species: 'Machop', level: 1, moves: ['Tackle'] }],
  };
  const matches = [new BattleMatch({ id: 'battle-concurrent-test-one', teams }), new BattleMatch({ id: 'battle-concurrent-test-two', teams: { A: teams.B, B: teams.A } })];
  try {
    for (const match of matches) scheduler.enqueue({ id: match.id, run: async () => {
      await match.start();
      await Promise.all(['A', 'B'].map(async seat => { starts.push(match.id + '/' + seat); await release.done; }));
      for (let phase = 0; phase < 2; phase++) for (const seat of ['A', 'B']) {
        const observed = match.observe(seat);
        await match.act(seat, { decisionId: observed.decisionId, candidateId: observed.candidates[0].id });
      }
      return match.snapshot();
    } });
    await tick(); await tick();
    assert.equal(starts.length, 4); assert.equal(scheduler.snapshot().running, 2);
    release.release(); await scheduler.idle();
    assert.equal(matches[0].winner, 'A'); assert.equal(matches[1].winner, 'B');
    for (const match of matches) assert.ok(match.decisions.every(d => d.decisionId.startsWith(match.id + '-')));
  } finally { for (const match of matches) await match.close(); }
});

test('queue bounds and shutdown cancel only queued jobs and reject further admission', async () => {
  const scheduler = new BattleScheduler({ concurrency: 1, maxQueued: 1 });
  const active = gate(); let cancelled = false;
  scheduler.enqueue({ id: 'active', run: () => active.done });
  const queued = scheduler.enqueue({ id: 'queued', run: () => assert.fail('cancelled job started'), onCancel: () => { cancelled = true; } });
  assert.equal(scheduler.canAccept(), false);
  assert.throws(() => scheduler.enqueue({ id: 'overflow', run: () => {} }));
  scheduler.stop(); await queued.done;
  assert.equal(cancelled, true); assert.equal(queued.state, 'cancelled');
  assert.equal(scheduler.canAccept(), false);
  active.release({ status: 'finished' }); await scheduler.idle();
});

test('an engine winner with failed AGH finalization is a failed job with its engine outcome preserved', async () => {
  const scheduler = new BattleScheduler();
  const job = scheduler.enqueue({ id: 'incomplete-agh', run: async () => ({ status: 'finished', autonomousTaskVerified: false }) });
  const result = await job.done;
  assert.equal(result.state, 'failed'); assert.equal(result.outcome, 'finished');
});

test('Jev requests for different games overlap while duplicate requests for one decision share a call', async () => {
  const originalFetch = globalThis.fetch, originalKey = process.env.TYPESAFE_API_KEY;
  const release = gate(), bodies = [];
  const matches = [new BattleMatch({ id: 'battle-jev-one', jev: true }), new BattleMatch({ id: 'battle-jev-two', jev: true })];
  try {
    process.env.TYPESAFE_API_KEY = 'synthetic-test-key';
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body); bodies.push(body); await release.done;
      const choice = Object.keys(body.questions.action.criteria)[0];
      return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { action: { choice, probabilities: { [choice]: 1 }, confidence: 1 } } }), { status: 200 });
    };
    for (const match of matches) await match.start();
    const [a, b] = matches.map(match => match.observe('A'));
    const requests = [matches[0].evaluate('A', a.decisionId), matches[0].evaluate('A', a.decisionId), matches[1].evaluate('A', b.decisionId)];
    await tick(); assert.equal(bodies.length, 2);
    assert.deepEqual(new Set(bodies.map(body => body.state.matchId)), new Set(matches.map(match => match.id)));
    release.release(); const results = await Promise.all(requests);
    assert.deepEqual(results[0], results[1]); assert.notEqual(results[0].decisionId, results[2].decisionId);
    assert.ok(matches.every(match => match.traces.filter(t => t.type === 'jev').length === 1));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = originalKey;
    for (const match of matches) await match.close();
  }
});
