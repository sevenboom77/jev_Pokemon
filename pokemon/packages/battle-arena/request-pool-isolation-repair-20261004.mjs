/** Admit requests only when every applicable service/model slot is available. */
export class RequestPool {
  constructor({ fetchImpl, retries = 2, retryBaseMs = 1000, maxRetryMs = 20000 } = {}) {
    this.fetchImpl = fetchImpl; this.retries = retries; this.retryBaseMs = retryBaseMs; this.maxRetryMs = maxRetryMs;
    this.groups = new Map(); this.queue = []; this.timer = null;
  }
  group({ key, max }) {
    if (!Number.isInteger(max) || max < 1) throw new Error('Request concurrency must be positive.');
    if (!this.groups.has(key)) this.groups.set(key, { key, max, limit: max, active: 0, requests: 0, rateLimits: 0, transientErrors: 0, successes: 0, cooldownUntil: 0 });
    return this.groups.get(key);
  }
  snapshot() { return { queued: this.queue.length, groups: [...this.groups.values()].map(g => ({ ...g })) }; }
  run(keys, operation, signal) {
    signal?.throwIfAborted();
    const groups = [...new Set(keys.map(key => this.group(key)))];
    return new Promise((resolve, reject) => {
      const item = { groups, operation, signal, resolve, reject };
      item.cancel = () => { this.queue = this.queue.filter(x => x !== item); reject(signal.reason); this.drain(); };
      signal?.addEventListener('abort', item.cancel, { once: true });
      this.queue.push(item); this.drain();
    });
  }
  drain() {
    clearTimeout(this.timer); this.timer = null;
    let wakeAt = Infinity;
    for (const item of [...this.queue]) {
      if (item.groups.some(g => g.active >= g.limit || g.cooldownUntil > Date.now())) {
        for (const g of item.groups) if (g.cooldownUntil > Date.now()) wakeAt = Math.min(wakeAt, g.cooldownUntil);
        continue;
      }
      this.queue.splice(this.queue.indexOf(item), 1);
      item.signal?.removeEventListener('abort', item.cancel);
      for (const g of item.groups) { g.active++; g.requests++; }
      Promise.resolve().then(item.operation).then(item.resolve, item.reject).finally(() => {
        for (const g of item.groups) g.active--;
        this.drain();
      });
    }
    if (wakeAt < Infinity) this.timer = setTimeout(() => this.drain(), Math.max(1, wakeAt - Date.now()));
  }
  async fetch(url, init, keys, onAttempt = null) {
    const groups = keys.map(key => this.group(key));
    for (let attempt = 0; ; attempt++) {
      const { response, retryableFailure } = await this.run(keys, async () => {
        const startedAt = new Date().toISOString();
        let result, bytes, retryableFailure, forwardedBytes = 0, firstFrameAt = null;
        try {
          const { onStreamFrame, onAttemptStart, ...requestInit } = init;
          onAttemptStart?.({ attempt, startedAt });
          result = await (this.fetchImpl ?? fetch)(url, requestInit);
          if (onStreamFrame && result.ok && /text\/event-stream/i.test(result.headers.get('content-type') ?? '')) {
            const reader = result.body.getReader(), chunks = [], decoder = new TextDecoder();
            let pending = '', length = 0, chatFinished = false;
            readStream: for (;;) {
              const part = await reader.read();
              if (part.done) break;
              chunks.push(part.value); length += part.value.length; pending += decoder.decode(part.value, { stream: true });
              for (;;) {
                const boundary = /\r?\n\r?\n/.exec(pending);
                if (!boundary) break;
                const end = boundary.index + boundary[0].length, frame = pending.slice(0,end); pending = pending.slice(end);
                if (onStreamFrame(frame, result.headers)) { forwardedBytes += Buffer.byteLength(frame); firstFrameAt ??= new Date().toISOString(); }
                const data = frame.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('\n');
                let terminal=data==='[DONE]';
                if (!terminal) { try {
                  const value=JSON.parse(data);
                  chatFinished ||= value.choices?.some(c=>c.finish_reason != null) ?? false;
                  terminal=value.type==='message_stop' || (value.type==='message_delta' && value.delta?.stop_reason != null) || (chatFinished && value.usage != null);
                } catch {} }
                if (terminal) { await reader.cancel().catch(()=>{}); break readStream; }
              }
            }
            pending += decoder.decode();
            if (pending && onStreamFrame(pending, result.headers)) { forwardedBytes += Buffer.byteLength(pending); firstFrameAt ??= new Date().toISOString(); }
            bytes = new Uint8Array(length); let offset=0;
            for (const chunk of chunks) { bytes.set(chunk,offset); offset+=chunk.length; }
          } else bytes = await result.arrayBuffer();
          const bodyText = new TextDecoder().decode(bytes);
          const transient = transientProviderResponse(result.status, bodyText);
          retryableFailure = transient && forwardedBytes === 0;
          onAttempt?.({ attempt, startedAt, finishedAt: new Date().toISOString(), status: result.status, bodyText, transient, retryableFailure, willRetry: retryableFailure && attempt < this.retries, forwardedBytes, firstFrameAt });
        } catch (error) {
          const networkCode=error.cause?.code ?? error.code;
          const retryableFailure=forwardedBytes===0 && !init.signal?.aborted && ['UND_ERR_SOCKET','ECONNRESET','ECONNREFUSED','EPIPE','ETIMEDOUT'].includes(networkCode);
          onAttempt?.({ attempt, startedAt, finishedAt: new Date().toISOString(), status: null, errorType: error.name, errorMessage: error.message, networkCode, forwardedBytes, firstFrameAt, retryableFailure, willRetry: retryableFailure && attempt<this.retries });
          if (retryableFailure && attempt<this.retries) {
            for(const g of groups){g.transientErrors=(g.transientErrors??0)+1;g.limit=Math.max(1,Math.floor(g.limit/2));g.cooldownUntil=Math.max(g.cooldownUntil,Date.now()+Math.min(this.maxRetryMs,this.retryBaseMs*2**attempt));}
            return {response:null,retryableFailure:true};
          }
          throw error;
        }
        // Keep slots until the body is received, including streamed provider responses.
        const buffered = new Response(bytes, { status: result.status, headers: result.headers });
        if (retryableFailure) {
          const modelUnavailable = result.status === 200 && /No available channel for model .+ under group .+ \(distributor\)/i.test(new TextDecoder().decode(bytes));
          const retryAfter = result.headers.get('retry-after');
          const requested = retryAfter === null ? NaN : Number(retryAfter) * 1000;
          const dated = retryAfter && !Number.isFinite(requested) ? Date.parse(retryAfter) - Date.now() : requested;
          const delay = Math.max(Math.min(this.maxRetryMs, this.retryBaseMs * 2 ** attempt), Number.isFinite(dated) ? dated : 0);
          const affected = modelUnavailable && groups.some(g => g.key.startsWith('model:')) ? groups.filter(g => g.key.startsWith('model:')) : groups;
          for (const g of affected) {
            if (result.status === 429) g.rateLimits++;
            else g.transientErrors = (g.transientErrors ?? 0) + 1;
            g.successes = 0;
            if (!modelUnavailable) g.limit = Math.max(1, Math.floor(g.limit / 2));
            g.cooldownUntil = Math.max(g.cooldownUntil, Date.now() + delay);
          }
        } else if (result.ok) {
          for (const g of groups) if (++g.successes >= 20) { g.limit = Math.min(g.max, g.limit + 1); g.successes = 0; }
        }
        return { response: buffered, retryableFailure };
      }, init.signal);
      if (!retryableFailure || attempt >= this.retries) return response;
    }
  }
}

export const modelRequests = new RequestPool();
export const jevRequests = new RequestPool();
export const modelRequestKeys = (model, upstream) => [
  { key: 'gateway:' + new URL(upstream).origin, max: Number(new URL(upstream).origin === 'http://103.221.143.59:52135' ? process.env.BATTLE_FE8_REQUESTS ?? 8 : process.env.BATTLE_GATEWAY_REQUESTS ?? 16) },
  { key: 'model:' + model, max: Number(model === 'agnes-3.0-flash' ? process.env.BATTLE_AGNES_REQUESTS ?? 2 : process.env.BATTLE_MODEL_REQUESTS ?? 8) },
];
export const jevRequestKeys = [{ key: 'jev-1.13.0', max: Number(process.env.BATTLE_JEV_REQUESTS ?? 16) }];
import { responseSummary } from './request-ledger.mjs';

export function transientProviderResponse(status, text) {
  if ([429,500,502,503,504].includes(status)) return true;
  if (status !== 200) return false;
  let error;
  try { error = responseSummary(text).error; } catch { return false; }
  if (!error) return false;
  return ['do_request_failed','overloaded_error','server_error','service_unavailable'].includes(error.code ?? error.type)
    || /do_request_failed|overloaded_error|请求上游失败|temporarily unavailable|No available channel for model .+ under group .+ \(distributor\)/i.test(error.message ?? '');
}
