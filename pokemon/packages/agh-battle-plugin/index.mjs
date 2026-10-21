import { readFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';

const Kind = Symbol.for('TypeBox.Kind');
const string = maxLength => ({ [Kind]: 'String', type: 'string', minLength: 1, maxLength });
const object = (properties, required) => ({ [Kind]: 'Object', type: 'object', properties, required, additionalProperties: false });
const meta = (mutating = false) => ({
  isReadOnly: !mutating, isDestructive: false, isConcurrencySafe: true,
  isOpenWorld: false, replay: mutating ? 'never' : 'safe',
  deferLoading: false, requiresApproval: 'never', costHint: undefined,
});

// No code, file, shell, browser or subagent tools are installed in the battle-player profile.
export const presets = {
  battle: {
    name: 'battle', extends: 'base', disclosure: 'standard',
    model: { route: { primary: { route: 'default', model: 'default' } }, prompt_sections: [] },
    compaction: { agent_callable: false, reserve_tokens: 4096, keep_recent_tokens: 4096 }, budget: { per_request_cap: 3000, max_steps: 384 },
    subagent: { max_depth: 0 },
  },
};

export const battlePlugin = {
  inject: ['extension'],
  apply(ctx) {
    const extension = ctx.extension();
    const binding = JSON.parse(readFileSync(join(process.env.AGH_HOME, 'battle-binding.json'), 'utf8'));
    const sessionMatches = new Map();
    async function call(path, body, signal, timeoutMs = 65000) {
      let value;
      try {
        const response = await fetch(binding.arenaUrl + '/player/' + path, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + binding.token },
          body: JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
        });
        value = await response.json();
        if (!response.ok) value = { error: value.error ?? 'E_ARENA', message: value.message ?? 'Arena refused the request' };
      } catch (error) { value = { error: 'E_ARENA', message: error.message }; }
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structured: value };
    }
    const identity = { matchId: string(128) };
    const decision = { ...identity, decisionId: string(160) };
    for (const tool of [
      { name: 'battle_observe', path: 'observe', properties: identity, required: ['matchId'], description: 'Read YOUR current Pokemon battle observation and legal candidates. Opponent private state is withheld.' },
      { name: 'battle_evaluate', path: 'evaluate', properties: decision, required: ['matchId', 'decisionId'], mutating: true, description: 'Call real Jev (paid) once to evaluate current legal actions. Returns an advisory choice distribution, not a win probability. You still choose and submit the action.' },
      { name: 'battle_act', path: 'act', properties: { ...decision, candidateId: string(32), explanation: string(400) }, required: ['matchId', 'decisionId', 'candidateId', 'explanation'], mutating: true, description: 'Submit ONE legal candidate ID from your current observation. Include a brief public Chinese explanation. The engine validates the action; both players choose before the turn resolves.' },
      { name: 'battle_feedback', path: 'feedback', properties: decision, required: ['matchId', 'decisionId'], description: 'Verify your submission receipt and read public engine feedback. accepted can mean waiting for the other player; do not submit a second action for this decision.' },
      { name: 'battle_wait', path: 'wait', properties: decision, required: ['matchId'], description: 'Wait for YOUR next decision or the engine-confirmed end of the match. Set decisionId to the last decision you handled. The tool waits up to 45 seconds and returns your new observation; a timeout means call it again, not end your whole-match task. Never repeatedly submit an accepted action.' },
    ]) {
      extension.registerTool({ name: tool.name, description: tool.description, parameters: object(tool.properties, tool.required), meta: meta(tool.mutating), execute: (args, tctx) => {
        const root = tctx.session.workspaceRoot;
        const workspaceMatch = root && basename(root) === binding.seat && /^battle-[a-zA-Z0-9-]+$/.test(basename(dirname(root))) ? basename(dirname(root)) : null;
        const expected = workspaceMatch ?? sessionMatches.get(tctx.session.key);
        if (expected && args.matchId !== expected) {
          const value = { error: 'E_MATCH_BINDING', message: 'This AGH session belongs to ' + expected + '; other games cannot be observed or controlled.' };
          return { content: [{ type: 'text', text: JSON.stringify(value) }], structured: value };
        }
        sessionMatches.set(tctx.session.key, args.matchId);
        return call(tool.path, args, tctx.signal);
      } });
    }
    // Completion belongs to AGH: this hook keeps its current turn open until the
    // environment confirms termination. It never selects actions or adds user tasks.
    extension.registerHook('turn_stopping', async (_payload, hctx) => {
      const matchId = sessionMatches.get(hctx.session.key);
      if (!matchId) return { action: 'continue', note: '整局任务尚未开始读取环境。请使用 battle_observe 获取自己的对局，持续完成对战。' };
      const result = await call('observe', { matchId }, hctx.signal, 800);
      if (result.structured.finished) return { action: 'stop' };
      return { action: 'continue', note: '环境尚未确认整局结束。继续当前任务，通过 battle_observe 或 battle_wait 读取局面并自主行动；只有 finished=true 才能提交最终总结。' };
    });
  },
};
