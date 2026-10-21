import test from 'node:test';
import assert from 'node:assert/strict';
import { AgnesDNS, AGNES_HOST, dispatcherFor } from '../packages/battle-arena/network.mjs';

test('trusted lookup coalesces requests, honors TTL, and returns net-compatible address shapes', async () => {
  let calls = 0, now = 0; const answers = [];
  const dns = new AgnesDNS({ now: () => now, onAnswer: a => answers.push(a), fetchImpl: async url => {
    assert.match(url, /^https:\/\/dns\.alidns\.com\/resolve/); calls++;
    return Response.json({ Status: 0, Answer: [{ type: 1, data: '192.0.2.1', TTL: 1 }] });
  } });
  assert.deepEqual(await Promise.all([dns.resolve(), dns.resolve()]), [[{ address: '192.0.2.1', family: 4 }], [{ address: '192.0.2.1', family: 4 }]]);
  assert.equal(calls, 1); await dns.resolve(); assert.equal(calls, 1);
  now = 1001; await dns.resolve(); assert.equal(calls, 2);
  const all = await new Promise((resolve, reject) => dns.lookup(AGNES_HOST, { all: true }, (e, a) => e ? reject(e) : resolve(a)));
  assert.deepEqual(all, [{ address: '192.0.2.1', family: 4 }]);
  const single = await new Promise((resolve, reject) => dns.lookup(AGNES_HOST, {}, (e, a, f) => e ? reject(e) : resolve([a, f])));
  assert.deepEqual(single, ['192.0.2.1', 4]); assert.equal(answers.length, 2);
});
test('failed or invalid trusted DNS never falls back to the poisoned system address', async () => {
  for (const answer of [{ Status: 3 }, { Status: 0, Answer: [{ type: 1, data: 'invalid', TTL: 1 }] }]) {
    const dns = new AgnesDNS({ fetchImpl: async () => Response.json(answer) });
    await assert.rejects(dns.resolve(), /no valid/);
  }
  const dns = new AgnesDNS();
  await assert.rejects(new Promise((resolve, reject) => dns.lookup('other.example', {}, e => e ? reject(e) : resolve())), { code: 'E_DNS_HOST' });
});
test('the custom dispatcher is restricted to the original AGNES HTTPS origin', () => {
  assert.ok(dispatcherFor('https://api.agnes-ai.cn/v1/chat/completions'));
  for (const url of ['http://api.agnes-ai.cn/v1', 'https://api.agnes-ai.cn:444/v1', 'https://other.example/v1']) assert.equal(dispatcherFor(url), undefined);
});
