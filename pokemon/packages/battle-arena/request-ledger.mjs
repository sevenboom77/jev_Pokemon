import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Chat gateways stream their usage in a final SSE frame. Preserve that frame's
// reported values even when the stream also contains an HTTP-200 error.
export function responseSummary(text) {
  if (text.trimStart().startsWith('{')) return JSON.parse(text);
  const summary = {};
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
    if (!data || data === '[DONE]') continue;
    const value = JSON.parse(data);
    if (value.id) summary.id = value.id;
    if (value.model) summary.model = value.model;
    if (value.usage) summary.usage = value.usage;
    if (value.error) summary.error = value.error;
  }
  return summary;
}

export function requestObserver(root, context, parseResponse = responseSummary) {
  const requestId = randomUUID();
  return ({ bodyText, ...attempt }) => {
    let result = null;
    try { result = parseResponse(bodyText); } catch {}
    const row = { v: 1, requestId, ...context, ...attempt,
      reportedModel: result?.model ?? null, responseId: result?.id ?? null,
      usage: result?.usage ?? null, usageMissing: !result?.usage,
      ...(result?.error ? { providerError: result.error } : {}),
      actualCharge: null };
    const global = join(root, '.runtime/battle-provider-replay');
    mkdirSync(global, { recursive: true, mode: 0o700 });
    appendFileSync(join(global, 'request-attempts.jsonl'), JSON.stringify(row) + '\n', { mode: 0o600 });
    if (/^battle-[a-zA-Z0-9-]+$/.test(context.matchId ?? '')) {
      const directory = join(root, 'runs', context.matchId);
      mkdirSync(directory, { recursive: true });
      appendFileSync(join(directory, 'provider-attempts.jsonl'), JSON.stringify(row) + '\n', { mode: 0o600 });
    }
  };
}
