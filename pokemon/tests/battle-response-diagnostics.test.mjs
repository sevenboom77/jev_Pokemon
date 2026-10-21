import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installResponseDiagnostics } from '../packages/battle-arena/response-diagnostics-repair-20261004.mjs';

test('records exact malformed native bytes while preserving request, result and observer usage evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'battle-response-diagnostic-'));
  try {
    const raw = 'data: {"type":"message_start","message":{"id":"reply-id","type":"message","model":"test","usage":{"input_tokens":12},"content":[]}}\n\n'
      + 'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","name":"battle_act","input":{}}}\n\n'
      + 'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{bad 中文}"}}\n\n'
      + 'data: {"type":"content_block_stop","index":0}\n\n'
      + 'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}\n\n';
    const init = { body: JSON.stringify({ messages: [{ role: 'user', content: '你是宝可梦对战的 A 方玩家。matchId=battle-diagnostic-test。' }] }) };
    const result = new Response('original'); let received, observed;
    const pool = { async fetch(url, sent, keys, callback) { received = sent; callback({ bodyText: raw, status: 200, attempt: 0 }); return result; } };
    assert.equal(installResponseDiagnostics(pool, { root }), true);
    assert.equal(installResponseDiagnostics(pool, { root }), false);
    assert.equal(await pool.fetch('http://test/v1/messages', init, [], row => { observed = row; }), result);
    assert.equal(received, init);
    assert.equal(observed.bodyText, raw);
    assert.equal(observed.responseParseError.name, 'SyntaxError');
    assert.equal(observed.rawResponseSummary.usage.input_tokens, 12);
    assert.equal(observed.rawResponseSummary.usage.output_tokens, 3);
    assert.equal(observed.rawResponseSummary.finalUsageObserved, true);
    assert.equal(readFileSync(join(root, observed.rawResponsePath), 'utf8'), raw);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('valid native replies pass through unchanged with no diagnostic file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'battle-response-diagnostic-'));
  try {
    const row = { status: 200, bodyText: JSON.stringify({ type: 'message', content: [], stop_reason: 'end_turn' }) };
    const pool = { async fetch(url, init, keys, callback) { callback(row); return 1; } };
    installResponseDiagnostics(pool, { root }); let observed;
    await pool.fetch('http://test/v1/messages', { body: JSON.stringify({ messages: [{ content: '你是宝可梦对战的 B 方玩家。matchId=battle-valid-test。' }] }) }, [], value => { observed = value; });
    assert.equal(observed, row);
    assert.equal(existsSync(join(root, 'runs')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
