import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { nativeMessage, nativeIdentity } from './deepseek-transport.mjs';

function nativeMetadata(text) {
  const summary = { usage: {}, finalUsageObserved: false };
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
    let event; try { event = JSON.parse(data); } catch { continue; }
    if (event.type === 'message_start') {
      summary.id = event.message?.id; summary.model = event.message?.model;
      Object.assign(summary.usage, event.message?.usage);
    }
    if (event.type === 'message_delta') {
      Object.assign(summary.usage, event.usage);
      summary.finalUsageObserved ||= event.delta?.stop_reason != null;
    }
  }
  return summary;
}

// Preserve malformed upstream replies without changing requests, streaming,
// retry policy or the original observer's handling of a failed parse.
export function installResponseDiagnostics(pool, { root }) {
  if (pool.responseDiagnosticsInstalled) return false;
  const original = pool.fetch;
  pool.fetch = function (url, init, keys, onAttempt) {
    if (!new URL(url).pathname.endsWith('/messages')) return original.call(this, url, init, keys, onAttempt);
    let body, identity;
    try { body = JSON.parse(init.body); identity = nativeIdentity(body); } catch {}
    if (!identity) return original.call(this, url, init, keys, onAttempt);
    return original.call(this, url, init, keys, row => {
      let recorded = row;
      if (row.bodyText && row.status === 200) {
        try { nativeMessage(row.bodyText); }
        catch (error) {
          const name = `malformed-native-${identity.seat.toLowerCase()}-${createHash('sha256').update(row.bodyText).digest('hex').slice(0, 12)}.sse`;
          const directory = join(root, 'runs', identity.matchId);
          mkdirSync(directory, { recursive: true });
          writeFileSync(join(directory, name), row.bodyText, { mode: 0o600 });
          const rawResponseSummary = nativeMetadata(row.bodyText);
          recorded = { ...row, responseParseError: { name: error.name, message: error.message },
            rawResponsePath: `runs/${identity.matchId}/${name}`, ...(rawResponseSummary ? { rawResponseSummary } : {}) };
        }
      }
      onAttempt?.(recorded);
    });
  };
  pool.responseDiagnosticsInstalled = true;
  return true;
}
