import test from 'node:test';
import { capChatOutput, nativeStreamTrailers, restoreLiteralThinking, readTransportBody } from '../packages/battle-arena/deepseek-transport.mjs';

test('Chat requests carry the shared output cap even when AGH omits a sampling cap', () => {
  const body = { model: 'qwen', messages: [{ role: 'system', content: 'unchanged' }] };
  const result = capChatOutput(body, 8192);
  assert.equal(result.max_tokens, 8192); assert.deepEqual(result.messages, body.messages);
  assert.equal(capChatOutput({ ...body, max_completion_tokens: 20000 }, 8192).max_tokens, 8192);
  assert.equal(capChatOutput({ ...body, max_tokens: 512 }, 8192).max_tokens, 512);
  assert.ok(!JSON.stringify(result).includes('max_completion_tokens'));
});
test('Qwen uses the combined reasoning-and-answer cap with the documented tolerance reserved', () => {
  const body = { model: 'qwen3.8-max-0902', messages: [{ role: 'system', content: 'unchanged' }], reasoning_effort: 'xhigh' };
  const result = capChatOutput(body, 8192);
  assert.equal(result.max_completion_tokens, 8182); assert.equal(result.max_tokens, undefined);
  assert.equal(result.reasoning_effort, 'xhigh'); assert.deepEqual(result.messages, body.messages);
  assert.equal(capChatOutput({ ...body, max_tokens: 512 }, 8192).max_completion_tokens, 512);
});
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeMessage, nativeRecord, restoreNativeThinking, writeMessageSSE, NativeHistoryCache, nativeConversation, nativeIdentity } from '../packages/battle-arena/deepseek-transport.mjs';

test('Chat tool messages with null content retain the original match identity', () => {
  const body = { messages: [{ role:'user',content:'你是宝可梦对战的 A 方玩家。matchId=battle-chat-one。' },{role:'assistant',content:null,tool_calls:[]}] };
  assert.deepEqual(nativeIdentity(body),{matchId:'battle-chat-one',seat:'A'});
});

const message = {
  id: 'native-response-id', type: 'message', role: 'assistant', model: 'deepseek-flash',
  content: [{ type: 'thinking', thinking: '', signature: 'actual-upstream-signature' },
    { type: 'tool_use', id: 'original-call', name: 'battle_act', input: { matchId: 'm', decisionId: 'd', candidateId: 'c' } }],
  stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 },
};
test('Chinese assistant history remains exact across byte-split HTTP request chunks', async () => {
  const actual = { ...message, content: [{ type: 'text', text: '<think>对手换人，选择技能。</think>' }, message.content[1]] };
  const text = JSON.stringify({ messages: [{ role: 'assistant', content: actual.content }] });
  const bytes = Buffer.from(text);
  async function* chunks() { for (const byte of bytes) yield Buffer.from([byte]); }
  const body = JSON.parse(await readTransportBody(chunks()));
  assert.deepEqual(body.messages[0].content, actual.content);
  assert.deepEqual(restoreNativeThinking(body, () => nativeRecord(actual))[0].content, actual.content);
});
test('AGH think-tag projection replays only the exactly authenticated original literal text', () => {
  const actual = { ...message, content: [{ type: 'text', text: '<think>actual provider text</think>\n选择技能' }, message.content[1]] };
  const saved = nativeRecord(actual);
  const incoming = [{ type: 'thinking', thinking: 'actual provider text', signature: '' },
    { type: 'text', text: '\n选择技能' }, { ...message.content[1], id: 'agh-reminted' }];
  const restored = restoreNativeThinking({ messages: [{ role: 'assistant', content: incoming }] }, () => saved);
  assert.deepEqual(restored[0].content, [{ ...actual.content[0] }, { ...message.content[1], id: 'agh-reminted' }]);
  assert.equal(restoreLiteralThinking(saved, [{ ...incoming[0], thinking: 'invented' }, ...incoming.slice(1)]), null);
  assert.equal(restoreLiteralThinking(saved, [...incoming.slice(0, 2), { ...incoming[2], input: { changed: true } }]), null);
  assert.equal(restoreLiteralThinking({ ...saved, thinking: [{ type: 'thinking', thinking: 'signed original' }] }, incoming), null);
});
test('the actual AGH wire client accepts completed native responses across a separate ending frame', async () => {
  const { stream } = await import('../../agnes-harness/packages/ai/node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js');
  const parts = [];
  writeMessageSSE({ writeHead() {}, write: chunk => parts.push(chunk), end() {} }, message);
  const withoutEnd = parts.filter(frame => !frame.startsWith('event: message_stop'));
  const finalDelta = withoutEnd.pop();
  const wireModel = { id: 'test-native', name: 'test', provider: 'anthropic', api: 'anthropic-messages',
    baseUrl: 'http://mock', input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { allowEmptySignature: true } };
  const run = async text => {
    const events = [];
    for await (const event of stream(wireModel, { messages: [{ role: 'user', content: 'test', timestamp: 0 }] }, {
      apiKey: 'local-test-no-network', fetch: async () => new Response(text, { headers: { 'content-type': 'text/event-stream' } }),
    })) events.push(event);
    return events;
  };
  const failed = await run(withoutEnd.join('') + finalDelta);
  assert.equal(failed.at(-1).type, 'error');
  assert.match(failed.at(-1).error.errorMessage, /before message_stop/);
  const normalized = await run(withoutEnd.join('') + nativeStreamTrailers([finalDelta]));
  assert.equal(normalized.at(-1).type, 'done');
  assert.equal(normalized.at(-1).message.stopReason, 'toolUse');
  assert.equal(normalized.at(-1).message.usage.output, 20);
  assert.equal(nativeStreamTrailers([parts.at(-1)]), parts.at(-1));
});
test('restores the actual empty thinking block and signature without changing AGH tool IDs', () => {
  const call = { ...message.content[1], id: 'agh-normalized-call' };
  const result = restoreNativeThinking({ messages: [{ role: 'assistant', content: [call] }] }, () => nativeRecord(message));
  assert.deepEqual(result[0].content, [message.content[0], call]);
});
test('refuses missing or mismatched native history rather than synthesizing reasoning', () => {
  const body = { messages: [{ role: 'assistant', content: [{ ...message.content[1], input: { decisionId: 'another' } }] }] };
  assert.throws(() => restoreNativeThinking(body, () => nativeRecord(message)), /does not match/);
  assert.throws(() => restoreNativeThinking(body, () => null), /unavailable/);
});
test('AGH may omit blank native text while meaningful text and every tool call still match', () => {
  const text = { type: 'text', text: 'Use the observed candidate.' };
  const native = { ...message, content: [message.content[0], { type: 'text', text: ' ' }, text, message.content[1]] };
  const record = nativeRecord(native);
  const body = { messages: [{ role: 'assistant', content: [text, message.content[1]] }] };
  assert.deepEqual(restoreNativeThinking(body, () => record)[0].content, [message.content[0], text, message.content[1]]);
  assert.throws(() => restoreNativeThinking({ messages: [{ role: 'assistant', content: [message.content[1]] }] }, () => record), /does not match/);
  assert.throws(() => restoreNativeThinking({ messages: [{ role: 'assistant', content: [text] }] }, () => record), /does not match/);
  assert.throws(() => restoreNativeThinking({ messages: [{ role: 'assistant', content: [text, { ...message.content[1], input: {} }] }] }, () => record), /does not match/);
});
test('AGH can continue after discarding a tool call from a truncated native response', () => {
  const text = { type: 'text', text: 'I will evaluate the next move.' };
  const native = { ...message, stop_reason: 'max_tokens', content: [message.content[0], text, message.content[1]] };
  const body = { messages: [{ role: 'assistant', content: [text] }] };
  assert.deepEqual(restoreNativeThinking(body, () => nativeRecord(native))[0].content, [message.content[0], text]);
  assert.throws(() => restoreNativeThinking(body, () => nativeRecord({ ...native, stop_reason: 'tool_use' })), /does not match/);
  assert.throws(() => restoreNativeThinking({ messages: [{ role: 'assistant', content: [{ ...text, text: 'changed text' }] }] }, () => nativeRecord(native)), /does not match/);
  assert.throws(() => restoreNativeThinking({ messages: [{ role: 'assistant', content: [{ ...message.content[1], input: {} }] }] }, () => nativeRecord(native)), /does not match/);
});
test('SSE adaptation preserves original content, usage, response ID and stop reason', () => {
  let output = '';
  writeMessageSSE({ writeHead() {}, write(part) { output += part; }, end() {} }, message);
  assert.deepEqual(nativeMessage(output), message);
});

test('compaction replays the genuine summary and retained responses after ordinal changes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'battle-native-'));
  try {
    const cache = new NativeHistoryCache(directory);
    const old = { ...message, content: [{ type: 'thinking', thinking: 'first', signature: 'sig-first' }, message.content[1]] };
    const tail = { ...message, content: [{ type: 'thinking', thinking: 'second', signature: 'sig-second' }, message.content[1]] };
    cache.save(0, old); cache.save(1, tail);
    const content = id => [{ ...message.content[1], id }];
    // Same action can be waited on repeatedly; wire IDs bind each genuine response separately.
    restoreNativeThinking({ messages: [{ role: 'assistant', content: content('agh-first') }, { role: 'assistant', content: content('agh-second') }] }, (i, c) => cache.lookup(i, c));
    const summary = { ...message, stop_reason: 'end_turn', content: [{ type: 'text', text: 'Goal: finish this battle. Earlier decisions were compacted.' }] };
    cache.save(2, summary);
    const compacted = [{ role: 'assistant', content: summary.content }, { role: 'assistant', content: content('agh-second') }];
    const restored = restoreNativeThinking({ messages: compacted }, (i, c) => cache.lookup(i, c));
    assert.deepEqual(restored[0].content, summary.content);
    assert.deepEqual(restored[1].content, [tail.content[0], ...content('agh-second')]);
    assert.throws(() => restoreNativeThinking({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'invented summary' }] }] }, (i, c) => cache.lookup(i, c)), /unavailable/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('native cache identity survives a genuine task summary and isolates each game and seat', () => {
  const request = (id, seat) => ({ model: 'deepseek-flash', messages: [{ role: 'user', content: [{ type: 'text', text: `你是宝可梦对战的 ${seat} 方玩家。matchId=${id}。` }] }] });
  const original = request('battle-one', 'A');
  const summarized = { ...original, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Goal:\n"' + original.messages[0].content[0].text + '"\nConstraints: keep waiting.' }] }] };
  assert.equal(nativeConversation(original, 'https://gateway'), nativeConversation(summarized, 'https://gateway'));
  const paraphrased = { ...original, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Actual summary with no textual identity marker' }] }] };
  assert.equal(nativeConversation(original, 'https://gateway'), nativeConversation(paraphrased, 'https://gateway', { matchId: 'battle-one', seat: 'A' }));
  assert.notEqual(nativeConversation(original, 'https://gateway'), nativeConversation(request('battle-two', 'A'), 'https://gateway'));
  assert.notEqual(nativeConversation(original, 'https://gateway'), nativeConversation(request('battle-one', 'B'), 'https://gateway'));
});

test('thinking-only continuations keep each genuine response when compaction changes ordinals', () => {
  const directory = mkdtempSync(join(tmpdir(), 'battle-thinking-only-'));
  try {
    const cache = new NativeHistoryCache(directory);
    const first = { ...message, id: 'thinking-first', stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: 'First genuine reasoning', signature: 'first-signature' }] };
    const second = { ...first, id: 'thinking-second', content: [{ type: 'thinking', thinking: 'Second genuine reasoning', signature: 'second-signature' }] };
    const wire = response => response.content.map(b => ({ ...b, signature: '' }));
    cache.save(0, first);
    assert.deepEqual(cache.lookup(0, wire(first)).thinking, first.content);
    cache.save(1, second);
    assert.deepEqual(cache.lookup(1, wire(second)).thinking, second.content);
    assert.deepEqual(cache.lookup(0, wire(second)).thinking, second.content);
    assert.equal(cache.lookup(0, [{ type: 'thinking', thinking: 'Altered reasoning', signature: '' }]), null);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a just-generated retained tool call binds to its ledger response even before its first replay', () => {
  const directory = mkdtempSync(join(tmpdir(), 'battle-retained-'));
  try {
    const original = { ...message, id: 'response-old', content: [{ type: 'thinking', thinking: 'old', signature: 'sig-old' }, message.content[1]] };
    const retained = { ...message, id: 'response-retained', content: [{ type: 'thinking', thinking: 'retained', signature: 'sig-retained' }, message.content[1]] };
    const cache = new NativeHistoryCache(directory, ids => ids[0] === 'agh-retained' ? 'response-retained' : null);
    cache.save(0, original); cache.save(14, retained);
    const summary = { ...message, id: 'summary-response', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Actual compacted summary' }] };
    cache.save(15, summary);
    const call = { ...message.content[1], id: 'agh-retained' };
    const result = restoreNativeThinking({ messages: [{ role: 'assistant', content: summary.content }, { role: 'assistant', content: [call] }] }, (i,c) => cache.lookup(i,c));
    assert.deepEqual(result[1].content, [retained.content[0], call]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('only an authenticated AGH system compaction replacement can replay without native reasoning', () => {
  const directory = mkdtempSync(join(tmpdir(), 'battle-system-summary-'));
  const summary = [{ type:'text', text:'[compaction] No model summary; real system replacement.' }];
  try {
    const cache = new NativeHistoryCache(directory, () => null, c => JSON.stringify(c) === JSON.stringify(summary) ? summary : null);
    assert.deepEqual(restoreNativeThinking({ messages:[{role:'assistant',content:summary}] }, (i,c)=>cache.lookup(i,c))[0].content,summary);
    assert.throws(()=>restoreNativeThinking({messages:[{role:'assistant',content:[{type:'text',text:'[compaction] invented replacement'}]}]},(i,c)=>cache.lookup(i,c)),/unavailable/);
  } finally { rmSync(directory,{recursive:true,force:true}); }
});
