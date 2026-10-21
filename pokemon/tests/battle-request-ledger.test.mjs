import test from 'node:test';
import assert from 'node:assert/strict';
import { responseSummary } from '../packages/battle-arena/request-ledger.mjs';

test('Chat SSE final usage and HTTP-200 stream errors are retained together', () => {
  const frames = [{ id: 'response-real', model: 'qwen-real', usage: null },
    { error: { type: 'invalid_request_error', message: 'unsupported role' } },
    { id: '', model: '', usage: { prompt_tokens: 68, completion_tokens: 0 } }];
  const text = frames.map(x => 'data: ' + JSON.stringify(x) + '\r\n\r\n').join('') + 'data: [DONE]\r\n\r\n';
  assert.deepEqual(responseSummary(text), { id: 'response-real', model: 'qwen-real', error: frames[1].error, usage: frames[2].usage });
});

test('An absent usage report stays absent for both JSON and SSE', () => {
  assert.equal(responseSummary('{"model":"test"}').usage, undefined);
  assert.equal(responseSummary('data: {"model":"test"}\n\ndata: [DONE]\n\n').usage, undefined);
});
