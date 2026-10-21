import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT } from './battle-env.mjs';
import { nativeMessage, nativeRecord, restoreNativeThinking } from '../packages/battle-arena/deepseek-transport.mjs';

// Explicit invocation only; probes never change the active model catalog.
const allowed = new Set(['claude-opus-4-8', 'mimo-v2.6-pro', 'minimax-m3', 'deepseek-flash']);
const model = process.argv[2];
if (!allowed.has(model)) throw new Error('Specify one supported fe8 model explicitly. Maximum three requests, no retries.');
const { key } = JSON.parse(readFileSync(join(ROOT, '.runtime/model-credentials/deepseek.json'), 'utf8'));
const report = { at: new Date().toISOString(), gatewayAlias: 'fe8', requestModel: model,
  api: 'anthropic-messages', createsMatches: false, createsAGHTasks: false, requestBudget: 3, retries: 0,
  checks: {}, responses: [] };
const marker = randomUUID();
const messages = [{ role: 'user', content: [{ type: 'text', text: `Call battle_probe once with marker="${marker}". After its successful result, reply exactly PROBE_OK.` }] }];
const body = { model, stream: false, max_tokens: 8192, messages,
  tools: [{ name: 'battle_probe', description: 'Return the supplied marker and success flag.',
    input_schema: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'], additionalProperties: false } }] };
const visible = message => message.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
// MiniMax may wrap reasoning inside a text block rather than a thinking block.
const answer = message => visible(message).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
async function request(phase, input) {
  const started = Date.now();
  const response = await fetch('http://103.221.143.59:52135/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(input), signal: AbortSignal.timeout(90000),
  });
  const item = { phase, httpStatus: response.status, elapsedMs: Date.now() - started };
  report.responses.push(item);
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const message = nativeMessage(await response.text());
  Object.assign(item, { reportedModel: message.model, responseId: message.id, usage: message.usage,
    stopReason: message.stop_reason, contentTypes: message.content.map(b => b.type), visibleText: visible(message) });
  return message;
}
try {
  const first = await request('tool-call', body);
  const call = first.content.find(b => b.type === 'tool_use');
  report.checks.toolCall = call?.name === 'battle_probe' && call.input.marker === marker;
  if (!report.checks.toolCall) throw new Error('E_TOOL_CALL');
  const projected = first.content.filter(b => !['thinking', 'redacted_thinking'].includes(b.type))
    .map(b => b.type === 'tool_use' ? { ...b, id: 'agh-probe-call' } : b);
  const continued = [...messages, { role: 'assistant', content: projected },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'agh-probe-call', content: JSON.stringify({ marker, success: true }) }] }];
  const restored = restoreNativeThinking({ messages: continued }, () => nativeRecord(first));
  report.checks.historyRestoration = true;
  const second = await request('tool-result', { ...body, messages: restored });
  report.checks.toolResult = answer(second) === 'PROBE_OK';
  if (!report.checks.toolResult) throw new Error('E_TOOL_RESULT');
  const summary = { content: [{ type: 'text', text: 'Conversation summary: battle_probe succeeded. The user now requests exactly COMPACTION_OK.' }], stop_reason: 'end_turn' };
  const compactedMessages = [messages[0], { role: 'assistant', content: summary.content },
    { role: 'user', content: [{ type: 'text', text: 'Continue from the summary. Reply exactly COMPACTION_OK, without tools.' }] }];
  const compacted = await request('compacted-history', { ...body,
    messages: restoreNativeThinking({ messages: compactedMessages }, () => nativeRecord(summary)) });
  report.checks.compactedHistory = answer(compacted) === 'COMPACTION_OK';
  report.passed = Object.values(report.checks).every(Boolean);
} catch (error) { report.passed = false; report.error = error.message; }
const filename = `fe8-native-${model}-probe-${Date.now()}.json`;
writeFileSync(join(ROOT, 'evidence', filename), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ model, passed: report.passed, checks: report.checks, evidence: filename,
  responses: report.responses.map(r => ({ phase: r.phase, status: r.httpStatus, model: r.reportedModel, text: r.visibleText?.slice(-160) })) }));
process.exitCode = report.passed ? 0 : 1;
