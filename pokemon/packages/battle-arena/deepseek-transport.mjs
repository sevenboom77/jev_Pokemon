import { createServer } from 'node:http';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { loadExtraModels } from '../../scripts/battle-extra-models.mjs';
import { modelConfigs } from '../../scripts/battle-env.mjs';
import { modelRequests, modelRequestKeys } from './request-pool.mjs';
import { requestObserver, responseSummary } from './request-ledger.mjs';
import { storedToolResponseId, storedCompactionSummary, storedCompactionIdentity } from '../../scripts/battle-history.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const fingerprint = content => hash(content.filter(block => block.type !== 'thinking' && block.type !== 'redacted_thinking').map(block =>
  block.type === 'tool_use' ? { type: block.type, name: block.name, input: canonical(block.input) } : { type: block.type, text: block.text ?? '' }));

export async function readTransportBody(req) {
  const chunks = []; let bytes = 0;
  for await (const part of req) {
    bytes += part.length;
    if (bytes > 4 * 1024 * 1024) throw new Error('Request too large');
    chunks.push(part);
  }
  // HTTP chunks may split a Chinese UTF-8 scalar. Decode after joining bytes.
  return Buffer.concat(chunks).toString('utf8');
}

// Some gateway responses use SSE even for stream:false. Reconstruct their actual message.
export function nativeMessage(text) {
  if (text.trimStart().startsWith('{')) return JSON.parse(text);
  let message;
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
    if (!data || data === '[DONE]') continue;
    const event = JSON.parse(data);
    if (event.type === 'message_start') message = { ...event.message, content: [] };
    if (event.type === 'content_block_start') message.content[event.index] = { ...event.content_block };
    if (event.type === 'content_block_delta') {
      const block = message.content[event.index], delta = event.delta;
      if (delta.type === 'text_delta') block.text = (block.text ?? '') + delta.text;
      if (delta.type === 'thinking_delta') block.thinking = (block.thinking ?? '') + delta.thinking;
      if (delta.type === 'signature_delta') block.signature = (block.signature ?? '') + delta.signature;
      if (delta.type === 'input_json_delta') block.partial = (block.partial ?? '') + delta.partial_json;
    }
    if (event.type === 'content_block_stop') {
      const block = message.content[event.index];
      if (block.partial) { block.input = JSON.parse(block.partial); delete block.partial; }
    }
    if (event.type === 'message_delta') { Object.assign(message, event.delta); Object.assign(message.usage, event.usage); }
    if (event.type === 'error') throw new Error('Upstream stream returned an error');
  }
  if (!message?.stop_reason) throw new Error('Incomplete upstream message');
  return message;
}

// Restore only thinking blocks actually received from this exact conversation response.
export function restoreNativeThinking(body, lookup) {
  let ordinal = 0;
  return body.messages.map(message => {
    if (message.role !== 'assistant') return message;
    const index = ordinal++, saved = lookup(index, message.content);
    const literalThinking = restoreLiteralThinking(saved, message.content);
    if (literalThinking) return { ...message, content: literalThinking };
    const current = fingerprint(message.content);
    // AGH discards unfinished tool calls when the provider hits max_tokens. Its
    // continuation legitimately contains just the unchanged text of that reply.
    // Accept only that exact projection of an actually truncated native reply.
    const discardedTruncatedCalls = saved?.stopReason === 'max_tokens'
      && !message.content.some(block => block.type === 'tool_use')
      && saved.fingerprintWithoutToolCalls === current;
    // pi-ai's Anthropic serializer omits whitespace-only text blocks. Accept
    // exactly that stored projection; meaningful text and tool arguments must match.
    const omittedBlankText = saved?.fingerprintWithoutBlankText === current;
    if (!saved || (saved.fingerprint !== current && !discardedTruncatedCalls && !omittedBlankText)) {
      const error = new Error('Native thinking history is unavailable or does not match; start a new match.');
      error.code = 'E_NATIVE_HISTORY'; error.historyOrdinal = index;
      throw error;
    }
    return { ...message, content: [...saved.thinking, ...message.content.filter(block => block.type !== 'thinking' && block.type !== 'redacted_thinking')] };
  });
}

// AGH's think-tag decoder promotes a closed <think> text span to a thinking block.
// A text-only native reply has no signed thinking to replay. Recombine that exact
// text only when its fingerprint equals the genuine saved response, including all
// visible text and tool arguments. Never infer or borrow another response's reasoning.
export function restoreLiteralThinking(saved, content) {
  if (!saved || saved.thinking.length || !content.some(b => b.type === 'thinking') || content.some(b => b.type === 'redacted_thinking')) return null;
  const original = [];
  for (const block of content) {
    const value = block.type === 'thinking' ? { type: 'text', text: '<think>' + block.thinking + '</think>' } : { ...block };
    if (value.type === 'text' && original.at(-1)?.type === 'text') original.at(-1).text += value.text;
    else original.push(value);
  }
  return fingerprint(original) === saved.fingerprint ? original : null;
}

export function nativeRecord(message) {
  return {
    fingerprint: fingerprint(message.content),
    fingerprintWithoutBlankText: fingerprint(message.content.filter(block => block.type !== 'text' || block.text.trim().length > 0)),
    stopReason: message.stop_reason,
    ...(message.stop_reason === 'max_tokens' ? { fingerprintWithoutToolCalls: fingerprint(message.content.filter(block => block.type !== 'tool_use')) } : {}),
    thinking: message.content.filter(block => block.type === 'thinking' || block.type === 'redacted_thinking'),
    responseId: message.id,
    reportedModel: message.model,
  };
}

const matchesRecord = (saved, content) => {
  if (restoreLiteralThinking(saved, content)) return true;
  const current = fingerprint(content);
  const incomingThinking = thinkingProjection(content);
  return saved && (!incomingThinking.length || hash(incomingThinking) === hash(thinkingProjection(saved.thinking)))
    && (saved.fingerprint === current || saved.fingerprintWithoutBlankText === current
    || (saved.stopReason === 'max_tokens' && !content.some(b => b.type === 'tool_use') && saved.fingerprintWithoutToolCalls === current));
};
const thinkingProjection = content => content.filter(b => ['thinking', 'redacted_thinking'].includes(b.type)).map(b =>
  b.type === 'thinking' ? { type: b.type, thinking: b.thinking ?? '' } : { type: b.type, data: b.data });
const wireFingerprint = content => hash(content.map(b => canonical(b.type === 'thinking'
  ? { type: b.type, thinking: b.thinking ?? '' } : b)));

export function capChatOutput(body, cap = Number(process.env.BATTLE_OUTPUT_CAP ?? 8192)) {
  const requested = body.max_tokens ?? body.max_completion_tokens ?? cap;
  if (!Number.isInteger(cap) || cap < 1 || !Number.isInteger(requested) || requested < 1) throw new Error('Invalid output budget');
  if (body.model === 'qwen3.8-max-0902') {
    // Qwen max_tokens excludes reasoning. Its combined-output parameter has a
    // documented tolerance of up to ten tokens; reserve that tiny margin.
    return { ...body, max_tokens: undefined, max_completion_tokens: Math.min(requested, Math.max(1, cap - 10)) };
  }
  // These Chinese Chat routes support max_tokens; the SDK omits both fields
  // when the AGH sampling request has no explicit maxTokens.
  return { ...body, max_tokens: Math.min(requested, cap), max_completion_tokens: undefined };
}

/** Compaction changes message positions; retained tool IDs and genuine summary content do not. */
export class NativeHistoryCache {
  constructor(directory, responseIdFor = () => null, compactionSummaryFor = () => null) { this.directory = directory; this.responseIdFor = responseIdFor; this.compactionSummaryFor = compactionSummaryFor; mkdirSync(directory, { recursive: true, mode: 0o700 }); }
  read(name) { const file = join(this.directory, name + '.json'); return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; }
  write(name, record) { writeFileSync(join(this.directory, name + '.json'), JSON.stringify(record), { mode: 0o600 }); }
  save(index, message) {
    const record = nativeRecord(message);
    if (message.id) this.write('response-' + hash(message.id), record);
    this.write('ordinal-' + index, record);
    for (const value of new Set([record.fingerprint, record.fingerprintWithoutBlankText, record.fingerprintWithoutToolCalls].filter(Boolean))) {
      const name = 'content-' + value, records = this.read(name) ?? [];
      if (!records.some(r => JSON.stringify(r.thinking) === JSON.stringify(record.thinking) && r.stopReason === record.stopReason)) records.push(record);
      this.write(name, records);
    }
  }
  lookup(index, content) {
    const name = 'wire-' + wireFingerprint(content);
    let record = this.read(name);
    if (!record) {
      const toolIds = content.filter(b => b.type === 'tool_use').map(b => b.id);
      const responseId = toolIds.length ? this.responseIdFor(toolIds) : null;
      if (responseId) record = this.read('response-' + hash(responseId));
      if (record && !matchesRecord(record, content)) record = null;
      const positional = this.read('ordinal-' + index);
      if (!record && matchesRecord(positional, content)) record = positional;
      if (!record) {
        const records = (this.read('content-' + fingerprint(content)) ?? []).filter(r => matchesRecord(r, content));
        // Ambiguous repeated text never borrows another response's reasoning.
        if (records.length === 1) record = records[0];
      }
      if (!record) {
        const summary = this.compactionSummaryFor(content);
        if (summary) record = nativeRecord({ content: summary, stop_reason: 'end_turn' });
      }
      if (record) this.write(name, record);
      else this.write('unmatched-wire-' + index, { fingerprint: fingerprint(content), content });
    }
    return record;
  }
}

export function nativeIdentity(body) {
  const texts = body.messages.flatMap(m => typeof m.content === 'string' ? [m.content] : Array.isArray(m.content) ? m.content.filter(b => b.type === 'text').map(b => b.text) : []).join('\n');
  const identity = texts.match(/你是宝可梦对战的 ([AB]) 方玩家。matchId=(battle-[a-zA-Z0-9-]+)/);
  if (identity) return { matchId: identity[2], seat: identity[1] };
  const decisions = body.messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(b => b.type === 'tool_use').map(b => b.input?.decisionId).filter(Boolean) : []);
  const ids = [...new Set(decisions.map(id => id.match(/^(battle-[a-zA-Z0-9-]+)-([AB])-\d+$/)?.slice(1).join(':')).filter(Boolean))];
  if (ids.length === 1) { const [matchId, seat] = ids[0].split(':'); return { matchId, seat }; }
  return null;
}
export function nativeConversation(body, upstream, identity = nativeIdentity(body)) {
  if (identity) return hash([upstream, body.model, identity.matchId, identity.seat]);
  const first = body.messages.find(m => m.role === 'user');
  return hash([upstream, body.model, first?.content]);
}

export function writeMessageSSE(res, message) {
  const send = event => res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  send({ type: 'message_start', message: { ...message, content: [], stop_reason: null, stop_sequence: null, usage: { ...message.usage, output_tokens: 0 } } });
  message.content.forEach((block, index) => {
    const initial = block.type === 'tool_use' ? { ...block, input: {} } : block.type === 'thinking' ? { type: 'thinking', thinking: '', signature: '' } : block.type === 'text' ? { type: 'text', text: '' } : block;
    send({ type: 'content_block_start', index, content_block: initial });
    if (block.type === 'text') send({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    if (block.type === 'thinking') {
      send({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } });
      if (block.signature) send({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } });
    }
    if (block.type === 'tool_use') send({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    send({ type: 'content_block_stop', index });
  });
  send({ type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: message.stop_sequence ?? null }, usage: message.usage });
  send({ type: 'message_stop' }); res.end();
}

// The pool settles at the genuine final stop_reason/usage frame. Some gateways
// close the socket instead of delivering their cosmetic message_stop afterward.
// Normalize this transport marker only after the actual message has been parsed
// and its exact history saved; it adds no content, usage, or synthetic progress.
export function nativeStreamTrailers(frames) {
  const text = frames.join('');
  return /^event: message_stop\r?$/m.test(text) ? text
    : text + 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
}

export function chatFrameHasOutput(event) {
  return (event.choices ?? []).some(c => {
    const d = c.delta ?? {};
    return ['content', 'reasoning_content', 'reasoning', 'reasoning_text'].some(k => typeof d[k] === 'string' && d[k].length > 0)
      || d.tool_calls?.length > 0 || d.function_call != null;
  });
}

export function createDeepSeekHandler({ root }) {
  const globalHome = process.env.BATTLE_MODEL_HOME ?? join(homedir(), '.agh');
  const key = JSON.parse(readFileSync(join(globalHome, 'secrets/claude-gateway/deepseek-flash'), 'utf8')).value;
  const upstream = (process.env.BATTLE_GATEWAY_BASE_URL ?? JSON.parse(readFileSync(join(homedir(), '.claude/settings.json'), 'utf8')).env.ANTHROPIC_BASE_URL).replace(/\/+$/, '');
  const primary = modelConfigs();
  const models = new Map([{ ...primary.A, upstream: primary.A.baseUrl }, { ...primary.B, key, upstream }, ...loadExtraModels(root)].map(model => [model.model, model]));
  const cache = join(root, '.runtime/battle-provider-replay');
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  return async (req, res) => {
    let stage = 'request', ordinal = null, identity = null, requestedModel = null;
    try {
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      if (req.method !== 'POST' || !['/v1/messages', '/v1/chat/completions'].includes(path)) { res.writeHead(404); res.end(); return; }
      const text = await readTransportBody(req);
      let body = JSON.parse(text);
      requestedModel = body.model;
      const config = models.get(body.model);
      if (!config) throw new Error('Unsupported model');
      const native = path === '/v1/messages';
      if ((native ? req.headers['x-api-key'] : req.headers.authorization?.replace(/^Bearer /, '')) !== config.key) { res.writeHead(401); res.end(); return; }
      identity = nativeIdentity(body) ?? (native ? storedCompactionIdentity(body.messages.find(m => m.role === 'assistant')?.content ?? [], body.model) : null);
      const history = native ? new NativeHistoryCache(join(cache, nativeConversation(body, config.upstream, identity)),
        ids => identity ? storedToolResponseId(identity.seat, ids, identity.matchId) : null,
        content => identity ? storedCompactionSummary(identity.seat, identity.matchId, content, body.model) : null) : null;
      if (native) {
        ordinal = body.messages.filter(message => message.role === 'assistant').length;
        stage = 'history'; body.messages = restoreNativeThinking(body, (index, content) => history.lookup(index, content));
        body.stream = true;
      }
      if (!native) body = capChatOutput(body);
      const headers = native ? { 'content-type': 'application/json', 'x-api-key': config.key, 'anthropic-version': '2023-06-01' }
        : { 'content-type': 'application/json', authorization: 'Bearer ' + config.key };
      stage = 'upstream';
      const controller = new AbortController();
      const disconnected = () => { if (!res.writableEnded) controller.abort(); };
      res.once('close', disconnected);
      const target = config.upstream.replace(/\/+$/, '').replace(/\/v1$/, '') + path;
      const finalFrames = [], rawStopReasons = [], chatPrelude = [];
      const onStreamFrame = (frame, headers) => {
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
        if (!data) return false;
        if (data === '[DONE]') { finalFrames.push(frame); return false; }
        let event; try { event = JSON.parse(data); } catch { return false; }
        for (const reason of [event.delta?.stop_reason, ...(event.choices ?? []).map(c => c.finish_reason)].filter(Boolean)) {
          if (!rawStopReasons.includes(reason)) rawStopReasons.push(reason);
        }
        if (event.type === 'message_stop' || (event.type === 'message_delta' && event.delta?.stop_reason != null)) { finalFrames.push(frame); return false; }
        if ((event.error || event.type === 'error') && !res.headersSent) return false;
        if (!native && !res.headersSent && !chatFrameHasOutput(event) && !(event.choices ?? []).some(c => c.finish_reason != null)) {
          chatPrelude.push(frame); return false;
        }
        if (!res.headersSent) res.writeHead(200, { 'content-type': headers.get('content-type') ?? 'text/event-stream', 'cache-control': 'no-cache' });
        for (const prelude of chatPrelude.splice(0)) res.write(prelude);
        res.write(frame); return true;
      };
      let response;
      try { response = await modelRequests.fetch(target, { method: 'POST', headers, body: JSON.stringify(body), onStreamFrame, onAttemptStart: () => { finalFrames.length = 0; rawStopReasons.length = 0; chatPrelude.length = 0; }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(Number(process.env.BATTLE_PROVIDER_TIMEOUT_MS ?? 660000))]) }, modelRequestKeys(body.model, config.upstream),
        requestObserver(root, { kind: 'main-model', model: body.model, api: native ? 'anthropic-messages' : 'openai-completions', matchId: identity?.matchId ?? null, seat: identity?.seat ?? null,
          wireMaxTokens: body.max_tokens ?? body.max_completion_tokens ?? null, wireThinkingType: body.thinking?.type ?? null,
          wireOutputCapKind: body.max_completion_tokens != null ? 'max_completion_tokens' : 'max_tokens',
          wireThinkingBudgetTokens: body.thinking?.budget_tokens ?? null, rawStopReasons }, native ? nativeMessage : responseSummary)); }
      finally { res.off('close', disconnected); }
      const answer = await response.text();
      let reportedModel = null;
      if (response.ok) {
        try { reportedModel = native ? nativeMessage(answer).model : responseSummary(answer).model; } catch {}
      }
      appendFileSync(join(cache, 'requests.jsonl'), JSON.stringify({ at: new Date().toISOString(), model: body.model, reportedModel, matchId: identity?.matchId ?? null, seat: identity?.seat ?? null, path, ordinal, status: response.status }) + '\n', { mode: 0o600 });
      if (!response.ok) { if (!res.headersSent) res.writeHead(response.status, { 'content-type': 'application/json' }); res.end(answer); return; }
      if (!native) { if (res.headersSent) res.end(finalFrames.join('')); else { res.writeHead(200, { 'content-type': response.headers.get('content-type') ?? 'application/json' }); res.end(answer); } return; }
      stage = 'response';
      const message = nativeMessage(answer);
      if (message.type !== 'message' || !Array.isArray(message.content)) throw new Error('Invalid upstream message');
      history.save(ordinal, message);
      if (res.headersSent) res.end(nativeStreamTrailers(finalFrames));
      else writeMessageSSE(res, message);
    } catch (error) {
      appendFileSync(join(cache, 'transport-errors.jsonl'), JSON.stringify({ at: new Date().toISOString(), stage, ordinal,
        matchId: identity?.matchId ?? null, seat: identity?.seat ?? null, model: requestedModel,
        code: error.code ?? error.name, historyOrdinal: error.historyOrdinal ?? null }) + '\n', { mode: 0o600 });
      if (res.headersSent) { res.end(); return; }
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: error.message } }));
    }
  };
}

export async function startDeepSeekTransport({ root, port = 8796 }) {
  const server = createServer(createDeepSeekHandler({ root }));
  await new Promise((done, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', done); });
  return { url: 'http://127.0.0.1:' + port, close: () => new Promise(done => server.close(done)) };
}
