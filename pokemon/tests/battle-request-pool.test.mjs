import test from 'node:test';
import { chatFrameHasOutput } from '../packages/battle-arena/deepseek-transport.mjs';
import assert from 'node:assert/strict';
import { RequestPool } from '../packages/battle-arena/request-pool.mjs';

test('a real terminal SSE frame completes even when the gateway keeps its HTTP socket open',async()=>{
  let cancelled=false;const text='data: {"usage":{"completion_tokens":2}}\n\ndata: [DONE]\n\n';
  const pool=new RequestPool({fetchImpl:async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(text));},cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}})});
  const response=await pool.fetch('https://stream',{onStreamFrame:()=>true},[{key:'live',max:1}]);
  assert.equal(await response.text(),text);assert.equal(cancelled,true);
});
test('actual final reason plus usage completes Chat and native streams without cosmetic terminators',async()=>{
  for(const text of ['data: {"choices":[{"finish_reason":"tool_calls","delta":{}}]}\n\ndata: {"choices":[],"usage":{"completion_tokens":2}}\n\n','data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":2}}\n\n']){
    const pool=new RequestPool({fetchImpl:async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(text));}}),{headers:{'content-type':'text/event-stream'}})});
    const response=await pool.fetch('https://stream',{onStreamFrame:()=>true},[{key:'live',max:1}]);assert.equal(await response.text(),text);
  }
});
test('socket failure before any model output retries without fabricating a response status',async()=>{
  let calls=0;const rows=[];const pool=new RequestPool({retryBaseMs:1,maxRetryMs:1,fetchImpl:async()=>{if(++calls===1)throw new TypeError('fetch failed',{cause:{code:'UND_ERR_SOCKET'}});return new Response('{"model":"same"}');}});
  await pool.fetch('https://same',{},[{key:'live',max:1}],r=>rows.push(r));assert.equal(calls,2);assert.deepEqual(rows.map(r=>r.status),[null,200]);assert.equal(rows[0].networkCode,'UND_ERR_SOCKET');
});

test('real SSE frames arrive before completion while the slot and full usage receipt remain held', async () => {
  const encoder=new TextEncoder();let release,firstFrame;const received=new Promise(r=>firstFrame=r),tail=new Promise(r=>release=r);
  const head='data: {"choices":[{"delta":{"content":"中文"}}]}\n\n',last='data: {"usage":{"completion_tokens":2}}\n\ndata: [DONE]\n\n';
  const pool=new RequestPool({fetchImpl:async()=>new Response(new ReadableStream({async start(c){const bytes=encoder.encode(head);c.enqueue(bytes.slice(0,40));c.enqueue(bytes.slice(40));await tail;c.enqueue(encoder.encode(last));c.close();}}),{headers:{'content-type':'text/event-stream'}})});
  const rows=[],frames=[];const job=pool.fetch('https://stream', {onStreamFrame:f=>{frames.push(f);firstFrame();return true;}},[{key:'live',max:1}],r=>rows.push(r));
  await received;assert.equal(pool.snapshot().groups[0].active,1);assert.equal(rows.length,0);assert.equal(frames[0],head);
  release();const response=await job;assert.equal(await response.text(),head+last);assert.equal(rows[0].bodyText,head+last);assert.ok(rows[0].firstFrameAt);
});

test('a transient error after real output is forwarded never silently repeats the generation', async () => {
  let calls=0;const rows=[];const text='data: {"choices":[{"delta":{"content":"real"}}]}\n\ndata: {"error":{"code":"do_request_failed"}}\n\n';
  const pool=new RequestPool({fetchImpl:async()=>{calls++;return new Response(text,{headers:{'content-type':'text/event-stream'}});}});
  await pool.fetch('https://stream',{onStreamFrame:()=>true},[{key:'live',max:1}],r=>rows.push(r));
  assert.equal(calls,1);assert.equal(rows[0].transient,true);assert.equal(rows[0].willRetry,false);
});

test('same-channel 500 retries retain actual statuses and stop after two retries', async () => {
  let calls=0;const attempts=[];
  const pool=new RequestPool({retryBaseMs:1,maxRetryMs:1,fetchImpl:async()=>{const fail=++calls<3;return new Response(JSON.stringify(fail?{error:{code:'do_request_failed'}}:{model:'unchanged',usage:{completion_tokens:10}}),{status:fail?500:200});}});
  const response=await pool.fetch('https://same-channel',{},[{key:'test',max:8}],r=>attempts.push(r));
  assert.equal(response.status,200);assert.deepEqual(attempts.map(r=>r.status),[500,500,200]);
  assert.equal(pool.snapshot().groups[0].transientErrors,2);assert.equal(pool.snapshot().groups[0].rateLimits,0);
});
test('HTTP-200 transient SSE errors retry while invalid-parameter errors do not', async () => {
  for(const transient of [true,false]){
    let calls=0;const attempts=[];
    const pool=new RequestPool({retryBaseMs:1,maxRetryMs:1,fetchImpl:async()=>new Response(++calls===1?'data: '+JSON.stringify({error:{code:transient?'do_request_failed':'invalid_parameter_error',message:transient?'请求上游失败':'unsupported role'}})+'\n\n':'data: {"model":"unchanged","usage":{"completion_tokens":10}}\n\n')});
    await pool.fetch('https://same-channel',{},[{key:'test',max:8}],r=>attempts.push(r));
    assert.equal(calls,transient?2:1);assert.equal(attempts[0].willRetry,transient);
    assert.equal(attempts[0].status,200);
  }
});

test('an upstream unavailable-channel error after role metadata retries without forwarding a fake response', async () => {
  let calls = 0; const attempts = [], output = [];
  const role = 'data: {"id":"metadata","choices":[{"delta":{"role":"assistant"}}]}\n\n';
  const unavailable = 'data: {"error":{"type":"invalid_request_error","message":"No available channel for model glm-5.3 under group gpt-vip (distributor)"}}\n\n';
  const content = 'data: {"id":"actual","choices":[{"delta":{"content":"actual response"},"finish_reason":"stop"}],"usage":{"completion_tokens":2}}\n\n';
  const pool = new RequestPool({ retryBaseMs: 1, maxRetryMs: 1, unavailableRetryBaseMs: 1, maxUnavailableRetryMs: 1, fetchImpl: async () =>
    new Response(++calls === 1 ? role + unavailable : content, { headers: { 'content-type': 'text/event-stream' } }) });
  await pool.fetch('https://same-channel', { onStreamFrame: frame => {
    const value = JSON.parse(frame.split('\n').find(line => line.startsWith('data:')).slice(5));
    if (!chatFrameHasOutput(value)) return false;
    output.push(value.id); return true;
  } }, [{ key: 'gateway:shared', max: 12 }, { key: 'model:glm', max: 8 }], r => attempts.push(r));
  assert.equal(calls, 2); assert.deepEqual(output, ['actual']);
  assert.equal(attempts[0].forwardedBytes, 0); assert.equal(attempts[0].willRetry, true);
  assert.equal(pool.snapshot().groups.find(g => g.key === 'gateway:shared').limit, 12);
  assert.equal(pool.snapshot().groups.find(g => g.key === 'model:glm').limit, 8);
});

test('temporary model unavailability can recover beyond the ordinary retry limit with the exact same request', async () => {
  const bodies = [], rows = [];
  const unavailable = JSON.stringify({ error: { type: 'invalid_request_error', message: 'No available channel for model glm-5.3 under group gpt-vip (distributor)' } });
  const pool = new RequestPool({ unavailableRetryBaseMs: 1, maxUnavailableRetryMs: 1, fetchImpl: async (_, init) => {
    bodies.push(init.body); return new Response(bodies.length < 5 ? unavailable : '{"model":"glm-5.3","usage":{"completion_tokens":2}}');
  } });
  const response = await pool.fetch('https://same', { body: '{"model":"glm-5.3","messages":["unchanged"]}' }, [{ key: 'model:glm', max: 8 }], r => rows.push(r));
  assert.equal(bodies.length, 5); assert.equal(new Set(bodies).size, 1); assert.match(await response.text(), /completion_tokens/);
  assert.deepEqual(rows.map(r => r.willRetry), [true, true, true, true, false]);
  pool.fetchImpl = async () => new Response(unavailable);
  const exhausted = [];
  await pool.fetch('https://same', {}, [{ key: 'model:glm', max: 8 }], r => exhausted.push(r));
  assert.equal(exhausted.length, 6); assert.equal(exhausted.at(-1).willRetry, false);
});

test('model and shared gateway limits both apply without blocking unrelated services', async () => {
  const pool = new RequestPool(), releases = [], starts = [];
  const run = (name, model, gateway) => pool.run([{ key: model, max: 1 }, { key: gateway, max: 2 }], () => new Promise(done => { starts.push(name); releases.push(done); }));
  const jobs = [run('a', 'm1', 'g1'), run('b', 'm1', 'g1'), run('c', 'm2', 'g1'), run('d', 'm3', 'g2')];
  await new Promise(done => setImmediate(done));
  assert.deepEqual(starts, ['a', 'c', 'd']);
  releases.shift()(); await new Promise(done => setImmediate(done));
  assert.deepEqual(starts, ['a', 'c', 'd', 'b']);
  releases.forEach(done => done()); await Promise.all(jobs);
});

test('429 lowers service concurrency and retries only the same request with a bounded count', async () => {
  const models = [];
  const pool = new RequestPool({ retryBaseMs: 1, maxRetryMs: 2, retries: 2,
    fetchImpl: async (_, init) => { models.push(JSON.parse(init.body).model); return new Response('limited', { status: 429 }); },
  });
  const result = await pool.fetch('https://provider', { body: '{"model":"exact-model"}' }, [{ key: 'model', max: 8 }]);
  assert.equal(result.status, 429); assert.deepEqual(models, ['exact-model', 'exact-model', 'exact-model']);
  assert.equal(pool.snapshot().groups[0].limit, 1); assert.equal(pool.snapshot().groups[0].rateLimits, 3);
});

test('cancelling a queued request removes it without making a provider call', async () => {
  const pool = new RequestPool(), key = [{ key: 'one', max: 1 }];
  let release;
  const first = pool.run(key, () => new Promise(done => { release = done; }));
  await new Promise(done => setImmediate(done));
  const controller = new AbortController(); let started = false;
  const second = pool.run(key, () => { started = true; }, controller.signal);
  controller.abort(); await assert.rejects(second, { name: 'AbortError' });
  assert.equal(started, false); assert.equal(pool.snapshot().queued, 0);
  release(); await first;
});
