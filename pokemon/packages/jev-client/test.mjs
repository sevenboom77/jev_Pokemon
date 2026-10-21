import http from 'node:http';
import assert from 'node:assert/strict';
import { buildChoiceRequest, decide, offlineDecider, selftest, JevError } from './index.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`not ok - ${name}: ${error?.stack ?? error}`);
  }
}

const observation = {
  phase: 'MAIN_TURN',
  own: { active: 'Pikachu ex', bench: ['Raichu'], handCount: 5 },
  opponent: { active: 'Charizard ex', bench: [], handCount: 4 },
  public_history: [{ seq: 1, type: 'ATTACH_ENERGY', seat: 'A' }],
  available_card_rules: { attachEnergyOncePerTurn: true },
};

const candidates = [
  { id: 'c-attack', kind: 'ATTACK', label: 'Thunder Burst', description: 'Deals 220 damage.', publicFacts: { damage: 220, targetHp: 180, canKnockOut: true } },
  { id: 'c-attach', kind: 'ATTACH_ENERGY', label: 'Attach Lightning Energy', description: 'Attach one Lightning Energy.', publicFacts: {} },
  { id: 'c-end', kind: 'END_TURN', label: 'End turn', description: 'End your turn.', publicFacts: {} },
];
const request = buildChoiceRequest({ observation, candidates });

const serverState = { count429: 0, countFlaky: 0, requests: [] };

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const server = http.createServer(async (req, res) => {
  res.on('error', () => {});
  const url = new URL(req.url, 'http://127.0.0.1');
  const bodyText = await readBody(req);
  serverState.requests.push({ path: url.pathname, body: bodyText });
  const payload = safeParse(bodyText);
  const ids = payload?.questions?.action?.criteria ? Object.keys(payload.questions.action.criteria) : [];
  const first = ids[0] ?? 'c-1';

  if (url.pathname === '/ok') {
    sendJson(res, 200, {
      model: 'jev-1.13.0',
      answers: { action: { choice: first, probabilities: { [first]: 0.91 }, confidence: 0.91 } },
      usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
    });
    return;
  }
  if (url.pathname === '/invalid') {
    sendJson(res, 200, {
      model: 'jev-1.13.0',
      answers: { action: { choice: 'c-does-not-exist', probabilities: {}, confidence: 0.5 } },
      usage: {},
    });
    return;
  }
  if (url.pathname === '/401') {
    sendJson(res, 401, { error: { message: 'invalid api key' } });
    return;
  }
  if (url.pathname === '/429') {
    serverState.count429 += 1;
    sendJson(res, 429, { error: { message: 'rate limited' } });
    return;
  }
  if (url.pathname === '/timeout') {
    setTimeout(() => {
      try {
        if (res.writableEnded) return;
        sendJson(res, 200, {
          model: 'jev-1.13.0',
          answers: { action: { choice: first, probabilities: { [first]: 1 }, confidence: 1 } },
          usage: {},
        });
      } catch {
        // client already aborted; ignore
      }
    }, 250);
    return;
  }
  if (url.pathname === '/flaky') {
    if (serverState.countFlaky === 0) {
      serverState.countFlaky = 1;
      sendJson(res, 503, { error: { message: 'temporary' } });
      return;
    }
    sendJson(res, 200, {
      model: 'jev-1.13.0',
      answers: { action: { choice: first, probabilities: { [first]: 0.8 }, confidence: 0.8 } },
      usage: { total_tokens: 7 },
    });
    return;
  }
  sendJson(res, 404, { error: { message: 'not found' } });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

await test('selftest() runs offline and passes', async () => {
  const result = await selftest();
  assert.equal(result.ok, true);
  assert.equal(result.networkCalls, 0);
});

await test('normal 200 returns selectedCandidateId/model/usage/latency/attempts', async () => {
  const result = await decide(request, { apiKey: 'fake-test-key', apiUrl: `${base}/ok`, timeoutMs: 2000 });
  assert.equal(result.selectedCandidateId, 'c-attack');
  assert.equal(result.offline, false);
  assert.equal(result.model, 'jev-1.13.0');
  assert.equal(result.usage.total_tokens, 14);
  assert.equal(result.attempts, 1);
  assert.equal(typeof result.latencyMs, 'number');
  assert.equal(result.probabilities['c-attack'], 0.91);
  assert.equal(result.confidence, 0.91);
});

await test('HTTP 401 surfaces E_AUTH without retrying', async () => {
  await assert.rejects(
    () => decide(request, { apiKey: 'bad-key', apiUrl: `${base}/401`, timeoutMs: 2000 }),
    (error) => error instanceof JevError && error.code === 'E_AUTH' && error.status === 401 && error.attempts === 1,
  );
});

await test('HTTP 429 surfaces E_RETRYABLE after exactly one retry', async () => {
  serverState.count429 = 0;
  await assert.rejects(
    () => decide(request, { apiKey: 'fake-test-key', apiUrl: `${base}/429`, timeoutMs: 2000 }),
    (error) => error instanceof JevError && error.code === 'E_RETRYABLE' && error.status === 429 && error.attempts === 2,
  );
  assert.equal(serverState.count429, 2);
});

await test('HTTP 503 is retried once and can succeed', async () => {
  serverState.countFlaky = 0;
  const result = await decide(request, { apiKey: 'fake-test-key', apiUrl: `${base}/flaky`, timeoutMs: 2000 });
  assert.equal(result.attempts, 2);
  assert.equal(serverState.countFlaky, 1);
  assert.equal(result.selectedCandidateId, 'c-attack');
});

await test('timeout aborts with E_TIMEOUT', async () => {
  await assert.rejects(
    () => decide(request, { apiKey: 'fake-test-key', apiUrl: `${base}/timeout`, timeoutMs: 60 }),
    (error) => error instanceof JevError && error.code === 'E_TIMEOUT',
  );
  await delay(350);
});

await test('choice outside the candidate set throws E_INVALID_CHOICE', async () => {
  await assert.rejects(
    () => decide(request, { apiKey: 'fake-test-key', apiUrl: `${base}/invalid`, timeoutMs: 2000 }),
    (error) => error instanceof JevError && error.code === 'E_INVALID_CHOICE' && error.chosen === 'c-does-not-exist',
  );
});

await test('missing API key refuses before network', async () => {
  let fetchCalled = false;
  await assert.rejects(
    () => decide(request, {
      apiKey: '',
      fetchImpl: async () => {
        fetchCalled = true;
        throw new Error('must not be called');
      },
    }),
    (error) => error instanceof JevError && error.code === 'E_NO_API_KEY',
  );
  assert.equal(fetchCalled, false);
});

await test('offlineDecider is deterministic and marked offline', async () => {
  const previous = process.env.TCG_JEV_MODE;
  process.env.TCG_JEV_MODE = 'offline';
  try {
    const first = offlineDecider(request, { seed: 5 });
    const second = offlineDecider(request, { seed: 5 });
    assert.equal(first.offline, true);
    assert.equal(first.model, 'offline-stub');
    assert.equal(first.selectedCandidateId, second.selectedCandidateId);
    assert.ok(Object.keys(request.questions.action.criteria).includes(first.selectedCandidateId));
  } finally {
    if (previous === undefined) delete process.env.TCG_JEV_MODE;
    else process.env.TCG_JEV_MODE = previous;
  }
});

await test('offlineDecider refuses to run outside TCG_JEV_MODE=offline', async () => {
  const previous = process.env.TCG_JEV_MODE;
  delete process.env.TCG_JEV_MODE;
  try {
    await assert.rejects(
      async () => {
        offlineDecider(request, { seed: 1 });
      },
      (error) => error instanceof JevError && error.code === 'E_OFFLINE_NOT_ALLOWED',
    );
  } finally {
    if (previous === undefined) delete process.env.TCG_JEV_MODE;
    else process.env.TCG_JEV_MODE = previous;
  }
});

server.closeAllConnections?.();
await new Promise((resolve) => server.close(resolve));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exitCode = 1;
