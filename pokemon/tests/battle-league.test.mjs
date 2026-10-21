import test from 'node:test';
import assert from 'node:assert/strict';
import { BattleMatch } from '../packages/battle-arena/match.mjs';
import { RequestPool } from '../packages/battle-arena/request-pool.mjs';
import { leagueResults } from '../scripts/battle-league-audit.mjs';
import { BattleScheduler, spreadModelPairs } from '../packages/battle-arena/scheduler.mjs';

test('a 16-game wave spreads work across models while retaining all 45 pairs', () => {
  const pairs = [];
  for (let a=0;a<10;a++)for(let b=a+1;b<10;b++)pairs.push({games:[{models:{A:String(a),B:String(b)}}]});
  const ordered=spreadModelPairs(pairs,8),counts=new Map();
  assert.equal(ordered.length,45);assert.equal(new Set(ordered).size,45);
  for(const p of ordered.slice(0,8))for(const id of Object.values(p.games[0].models))counts.set(id,(counts.get(id)??0)+2);
  assert.equal(counts.size,10);assert.ok(Math.max(...counts.values())<=4);
});

test('turn-limit settlement produces a real engine tie and wakes both waiting agents', async () => {
  const match = await new BattleMatch({ league: { maxTurns: 40 } }).start();
  try {
    await match.settleTurnLimit();
    assert.equal(match.status, 'finished'); assert.equal(match.winner, null);
    assert.ok(match.publicLog.some(line => line.split('|')[1] === 'tie')); assert.equal(match.settlementReason, 'turn-limit-draw');
    for (const seat of ['A','B']) assert.equal((await match.wait(seat, match.observe(seat).decisionId)).finished, true);
  } finally { await match.close(); }
});
test('each 429 and successful retry retains its own usage and request attempt', async () => {
  let count=0; const recorded=[];
  const pool=new RequestPool({retryBaseMs:1,maxRetryMs:1,fetchImpl:async()=>new Response(JSON.stringify({usage:count++?{input_tokens:10}:null}),{status:count===1?429:200})});
  const response=await pool.fetch('https://test',{},[{key:'model',max:8}],r=>recorded.push(r));
  assert.equal(response.status,200);assert.deepEqual(recorded.map(r=>r.status),[429,200]);
  assert.deepEqual(recorded.map(r=>r.attempt),[0,1]); assert.equal(JSON.parse(recorded[1].bodyText).usage.input_tokens,10);
});
test('pair scoring chooses the first complete attempt and excludes lone successful legs', () => {
  const game=(winner,valid=true)=>({models:{A:'one',B:'two'},result:{winnerModelId:winner,valid}});
  const manifest={models:[{id:'one',displayName:'one'},{id:'two',displayName:'two'}],pairs:[{attempts:[{games:[game('one'),game('two',false)]},{games:[game('two'),game(null)]},{games:[game('one'),game('one')]}]}]};
  const result=leagueResults(manifest);
  assert.equal(result.validSelectedGames,2); assert.equal(result.standings[0].score,25);
  assert.equal(result.standings[1].score,75); assert.equal(result.standings[0].rank,null);
});
test('workspace preparation stays bounded and all bindings finish before a paid task starts', async () => {
  let active=0,maximum=0,finished=0;
  const scheduler=new BattleScheduler({concurrency:8,preparationConcurrency:2});
  for(let i=0;i<8;i++)scheduler.enqueue({id:'job-'+i,prepare:async()=>{active++;maximum=Math.max(maximum,active);await new Promise(r=>setTimeout(r,5));active--;finished++;},run:async()=>{assert.equal(finished,8);return {status:'finished'};}});
  await scheduler.idle(); assert.equal(maximum,2);
});
