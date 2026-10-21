import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cli, ROOT, createPlayerSession } from '../../scripts/battle-env.mjs';
import { PLAYER_STRATEGY } from './strategy.mjs';
import { readStoredHistory, readPlayerTaskHealth } from '../../scripts/battle-history.mjs';
import { displayModelName } from '../battle-web/model-names.js';

const taskMetadata = (stdout, sessionId) => String(stdout ?? '').split('\n')
  .flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } })
  .find(row => row.sessionId === sessionId);

export function wholeMatchPrompt(match, seat) {
  return [
    `你是宝可梦对战的 ${seat} 方玩家。matchId=${match.id}。你的长程任务是自主完成这整局对战，目标是获胜。`,
    '这是整局唯一一次用户任务。持续使用工具行动，直到环境返回 finished=true，再给出简短中文最终总结。',
    '先调用 battle_observe 获取自己的局面和合法候选。自主判断技能、属性、换人、状态和后续策略；对手未公开的信息视为未知。',
    ...PLAYER_STRATEGY,
    match.jevEnabled
      ? '本局启用 Jev。多个合法候选必须先调用 battle_evaluate 获取真实辅助建议，然后由你最终选择；只有一个合法候选无需评估。'
      : '本局不使用 Jev，禁止调用 battle_evaluate。独立比较合法候选并选择；其他行动、反馈和等待流程相同。',
    '用 battle_act 提交观察中的 matchId、decisionId、candidateId，explanation 写一句简短中文公开理由，然后用 battle_feedback 核对结果。',
    'accepted=true 只说明当前选择已提交，不说明整局结束。记住该 decisionId，调用 battle_wait 等待自己的下一次决策或终局。',
    'battle_wait 返回 ready 后自行继续评估和行动；等待超时、对手未提交、暂停或强制换人都不能作为完成任务的理由。超时后继续等待。',
    '工具返回的旧决策或非法候选错误需重新观察，不能凭记忆重复提交。技术中止时如 finished=true，报告中止原因，不宣称获胜。',
    '规则与胜负由引擎决定。联赛达到 40 回合仍无胜者时由引擎结算平局；收到终局后正常完成总结。你只能操作自己的一方，使用这些对战工具；不要创建子任务、不要访问文件或网络。',
  ].join('\n');
}

export async function prepareMatchSessions(match, models, openSession = createPlayerSession) {
  const workspace = join(ROOT, '.runtime/battle-workspaces', match.id);
  for (const seat of ['A', 'B']) {
    if (match.sessions[seat]) continue;
    const cwd = join(workspace, seat);
    mkdirSync(cwd, { recursive: true });
    match.sessions[seat] = await openSession(seat, cwd, `宝可梦整局自主对战 · ${seat} · ${displayModelName(models[seat])} · ${match.id}`, models[seat]);
    match.emit('change');
  }
}

/** Launch exactly one AGH task per player. This supervisor never sends a next-turn prompt. */
export async function runPlayers(match, models, { maxTurns = 40, timeoutMs = 40 * 60 * 1000, openSession = createPlayerSession, invoke = cli,
  healthProbe = readPlayerTaskHealth, healthIntervalMs = 5000 } = {}) {
  const started = Date.now();
  match.executionMode = 'agh-long-task-v1';
  match.status = 'running';
  match.emit('change');
  const workspace = join(ROOT, '.runtime/battle-workspaces', match.id);
  const cancellations = Object.fromEntries(['A', 'B'].map(seat => [seat, new AbortController()]));
  const cancelBoth = () => { for (const controller of Object.values(cancellations)) controller.abort(); };
  const counts = { A: 0, B: 0 }, taskResults = {};
  const supervise = () => {
    if (match.turn > maxTurns && !match.finished) {
      if (match.league) void match.settleTurnLimit().catch(error => match.abort(error.message));
      else match.abort('整局回合预算已用尽；没有宣告胜者。');
    }
    if (match.status === 'aborted') cancelBoth();
  };
  match.on('change', supervise);
  const deadline = setTimeout(() => { match.abort('整局时间预算已用尽；没有宣告胜者。'); cancelBoth(); }, timeoutMs);
  let healthTimer;
  try {
    await prepareMatchSessions(match, models, openSession);
    const initialHealth = Object.fromEntries(['A', 'B'].map(seat => [seat, healthProbe(seat, match.sessions[seat])]));
    healthTimer = setInterval(() => {
      if (match.finished) return;
      for (const seat of ['A', 'B']) {
        let health;
        try { health = healthProbe(seat, match.sessions[seat]); } catch { continue; }
        const initial = initialHealth[seat];
        const generationChanged = health.pid !== initial.pid || health.generation !== initial.generation;
        if (health.alive && !generationChanged && !health.terminalReason) continue;
        match.traces.push({ type: 'agh-health-failure', seat, sessionId: match.sessions[seat], at: new Date().toISOString(),
          initial, observed: health, generationChanged });
        match.abort(`${seat} 方 AGH 执行进程退出、重启或任务已停止（${health.terminalReason ?? 'daemon-generation'}）；保留真实轨迹，不等待整局时限。`);
        cancelBoth();
        return;
      }
    }, healthIntervalMs);
    const tasks = ['A', 'B'].map(async seat => {
      const args = ['--cwd', join(workspace, seat), '--profile', 'local-dev', '--mode', 'json', '--meta',
        '--resume', match.sessions[seat], '--model', 'primary=' + models[seat].route + '/' + models[seat].model, '-p', wholeMatchPrompt(match, seat)];
      counts[seat]++;
      match.traces.push({ type: 'agh-start', seat, sessionId: match.sessions[seat], scope: 'whole-match', model: models[seat].model, at: new Date().toISOString() });
      match.emit('change');
      try {
        const result = await invoke(seat, args, { cwd: join(workspace, seat), timeoutMs: Math.max(1, timeoutMs - (Date.now() - started)), signal: cancellations[seat].signal });
        const metadata = taskMetadata(result.stdout, match.sessions[seat]);
        taskResults[seat] = metadata ?? { reason: 'missing-result' };
        if (!metadata || metadata.reason !== 'completed') throw new Error(seat + ' 方 AGH 长程任务未正常完成。');
        if (!match.finished) throw new Error(seat + ' 方提前结束了整局任务；不通过外部逐回合提示补跑。');
        match.traces.push({ type: 'agh-complete', seat, sessionId: match.sessions[seat], scope: 'whole-match', model: models[seat].model, at: new Date().toISOString() });
        match.emit('change');
      } catch (error) {
        const failureOrigin = cancellations[seat].signal.aborted ? 'supervisor-cancellation' : 'player-task';
        taskResults[seat] ??= taskMetadata(error.result?.stdout, match.sessions[seat]) ?? { reason: 'error', message: error.message };
        taskResults[seat].failureOrigin = failureOrigin;
        match.traces.push({ type: 'agh-error', seat, sessionId: match.sessions[seat], at: new Date().toISOString(), message: error.message, failureOrigin, engineFinished: match.status === 'finished' });
        // Once the engine has settled, let the healthy player finish its own summary.
        if (!match.finished) match.abort(error.message);
        throw error;
      }
    });
    await Promise.allSettled(tasks);
  } catch (error) { match.abort(error.message); cancelBoth(); }
  finally { clearTimeout(deadline); clearInterval(healthTimer); match.off('change', supervise); }
  const dir = join(ROOT, 'runs', match.id);
  mkdirSync(dir, { recursive: true });
  const historyChecks = {};
  for (const seat of ['A', 'B']) {
    if (!match.sessions[seat]) continue;
    // Restoring another workspace through the CLI can refresh shared resources.
    // Export committed AGH events directly, without touching running sessions.
    let exported, exportSource;
    try { exported = { stdout: readStoredHistory(seat, match.sessions[seat], { allowUnstarted: true, allowIncomplete: true }) }; exportSource = 'read-only-sqlite'; }
    catch {
      exported = await invoke(seat, ['export', match.sessions[seat], '--format', 'agnes', '--raw']).catch(() => null);
      exportSource = exported ? 'agh-cli' : 'unavailable';
    }
    if (exported) {
      writeFileSync(join(dir, 'agh-' + seat.toLowerCase() + '.jsonl'), exported.stdout, { mode: 0o600 });
      const events = exported.stdout.trim().split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      const terminal = events.filter(e => e.type === 'turn/end').at(-1)?.data;
      historyChecks[seat] = {
        exportSource,
        events: events.length,
        sequenceContinuous: events.length > 0 && events.every((event, index) => event.seq === index + 1),
        userTasks: events.filter(e => e.type === 'user/message' && e.data?.kind !== 'runtime_context').length,
        taskStarts: events.filter(e => e.type === 'turn/start').length,
        internalContinuationNotes: events.filter(e => e.type === 'user/message' && e.data?.kind === 'runtime_context').length,
        tools: events.filter(e => e.type === 'tool/call').map(e => e.data.name),
        terminalReason: terminal?.reason ?? null,
        terminalError: terminal?.error ?? null,
      };
    }
  }
  const autonomousTaskVerified = match.status === 'finished' && ['A', 'B'].every(seat => counts[seat] === 1 && taskResults[seat]?.reason === 'completed' && historyChecks[seat]?.userTasks === 1 && historyChecks[seat]?.taskStarts === 1 && historyChecks[seat]?.sequenceContinuous === true);
  const snapshot = { ...match.snapshot(), models, executionBudget: { maxTurns, timeoutMs }, counts, taskResults, historyChecks, autonomousTaskVerified, elapsedMs: Date.now() - started };
  writeFileSync(join(dir, 'battle.json'), JSON.stringify(snapshot, null, 2) + '\n');
  return snapshot;
}
