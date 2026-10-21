import { Agent, fetch as undiciFetch } from 'undici';
import { isIP } from 'node:net';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const AGNES_HOST = 'api.agnes-ai.cn';
export class AgnesDNS {
  constructor({ fetchImpl = fetch, now = Date.now, onAnswer = () => {} } = {}) {
    this.fetchImpl = fetchImpl; this.now = now; this.onAnswer = onAnswer;
    this.cached = null; this.pending = null;
    this.lookup = (hostname, options, callback) => {
      if (hostname !== AGNES_HOST) return callback(Object.assign(new Error('Unexpected DNS host'), { code: 'E_DNS_HOST' }));
      this.resolve().then(addresses => options?.all ? callback(null, addresses) : callback(null, addresses[0].address, 4), callback);
    };
  }
  async resolve() {
    if (this.cached?.expires > this.now()) return this.cached.addresses;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const source = 'https://dns.alidns.com/resolve?name=' + AGNES_HOST + '&type=A';
      const response = await this.fetchImpl(source, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('Trusted DNS HTTP ' + response.status);
      const answer = await response.json();
      const records = (answer.Answer ?? []).filter(r => r.type === 1 && isIP(r.data) === 4);
      if (answer.Status !== 0 || !records.length) throw new Error('Trusted DNS has no valid AGNES address');
      const addresses = [...new Set(records.map(r => r.data))].map(address => ({ address, family: 4 }));
      const ttl = Math.max(0, Math.min(...records.map(r => Number(r.TTL) || 0)));
      this.cached = { addresses, expires: this.now() + ttl * 1000 };
      this.onAnswer({ at: new Date().toISOString(), hostname: AGNES_HOST, source, addresses, ttlSeconds: ttl });
      return addresses;
    })();
    try { return await this.pending; } finally { this.pending = null; }
  }
}
const directory = resolve(import.meta.dirname, '../../.runtime/battle-provider-replay');
const dns = new AgnesDNS({ onAnswer: answer => {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  appendFileSync(join(directory, 'dns-resolutions.jsonl'), JSON.stringify(answer) + '\n', { mode: 0o600 });
} });
// Custom lookup affects only this dispatcher. TLS still verifies the original
// hostname; credentials are never sent to an endpoint with a mismatched cert.
const agnesAgent = new Agent({ connect: { lookup: dns.lookup } });
export function dispatcherFor(url) {
  const parsed = new URL(url);
  return parsed.protocol === 'https:' && parsed.hostname === AGNES_HOST && (!parsed.port || parsed.port === '443') ? agnesAgent : undefined;
}
export function fetchWithNetwork(url, init) {
  const dispatcher = dispatcherFor(url);
  // Use the matching fetch/dispatcher versions for this isolated origin.
  return dispatcher ? undiciFetch(url, { ...init, dispatcher }) : fetch(url, init);
}
