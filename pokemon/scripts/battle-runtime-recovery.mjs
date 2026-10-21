import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** Resolve a rejected historical call only after a real, admitted replacement succeeded.
 * Dispatch and step verification still reject the malformed call. Raw events are unchanged.
 */
export function recoveredBattleCalls(calls, results, valid, trusted) {
  const names = new Set(['battle_observe', 'battle_evaluate', 'battle_act', 'battle_feedback', 'battle_wait']);
  const byId = new Map(results.map(e => [e.data.toolUseId, e]));
  return calls.filter(call => {
    const { name, args, toolUseId } = call.data;
    if (valid(name, args) || !names.has(name) || typeof args?.matchId !== 'string') return true;
    const rejection = byId.get(toolUseId);
    if (!rejection?.data.isError || rejection.data.code !== 'TOOL_ARGS_INVALID') return true;
    const replacement = calls.some(next => {
      const n = next.data;
      if (next.seq <= rejection.seq || n.name !== name || !valid(n.name, n.args) || !trusted(next)) return false;
      if (n.args?.matchId !== args.matchId || (args.decisionId != null && n.args?.decisionId !== args.decisionId)) return false;
      const result = byId.get(n.toolUseId);
      if (!result || result.seq <= next.seq || result.data.isError !== false || result.data.structured?.error) return false;
      if (name === 'battle_act') return result.data.structured?.accepted === true;
      if (name === 'battle_evaluate') return result.data.structured?.model === 'jev-1.13.0' && result.data.structured?.offline === false;
      return result.data.structured != null;
    });
    return !replacement;
  });
}

export function patchBattleRuntime(root) {
  const before = 'async function turnVerifyInput(s2, triggerSeq) {\n  return assemble(s2, await scanWindow(s2, triggerSeq));\n}';
  const after = recoveredBattleCalls.toString() + '\nasync function turnVerifyInput(s2, triggerSeq) {\n' +
    '  const w = await scanWindow(s2, triggerSeq);\n' +
    '  if (s2.preset.name === "battle") w.calls = recoveredBattleCalls(w.calls, w.results, (name,args)=>schemaOk(s2,name,args), hasTrustedToolCallProvenance);\n' +
    '  return assemble(s2, w);\n}';
  const receipts = [];
  for (const file of ['agnes.mjs', 'worker.mjs']) {
    const path = join(root, '.runtime/battle-agh-runtime', file);
    const source = readFileSync(path, 'utf8');
    if (source.includes(after)) continue;
    if (source.split(before).length !== 2) throw new Error('Runtime patch target is not unique: ' + file);
    const changed = source.replace(before, after);
    const hash = text => createHash('sha256').update(text).digest('hex');
    copyFileSync(path, path + '.before-recovery-' + hash(source).slice(0, 12));
    writeFileSync(path, changed);
    receipts.push({ file, before: hash(source), after: hash(changed) });
  }
  return receipts;
}

// Apply at an idle cold restart so every newly admitted seat has the same bounds.
export function patchBattleTimeouts(root) {
  const before = 'DEFAULT_TIMEOUT = { firstToken: 12e4, total: 6e5 };';
  const after = 'DEFAULT_TIMEOUT = { firstToken: 3e5, total: 6e5 };';
  const receipts = [];
  for (const file of ['agnes.mjs', 'worker.mjs']) {
    const path = join(root, '.runtime/battle-agh-runtime', file), source = readFileSync(path, 'utf8');
    if (source.includes(after)) continue;
    if (source.split(before).length !== 2) throw new Error('Timeout patch target is not unique: ' + file);
    const changed = source.replace(before, after);
    const hash = text => createHash('sha256').update(text).digest('hex');
    copyFileSync(path, path + '.before-timeout-' + hash(source).slice(0, 12));
    writeFileSync(path, changed);
    receipts.push({ file, before: hash(source), after: hash(changed), firstTokenMs: 300000, totalMs: 600000 });
  }
  return receipts;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  console.log(JSON.stringify(process.argv[2] === 'timeouts' ? patchBattleTimeouts(root) : patchBattleRuntime(root)));
}
