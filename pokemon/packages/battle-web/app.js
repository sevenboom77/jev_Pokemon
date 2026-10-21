import { displayModelName, displayBattleLines } from './model-names.js';

const $id = id => document.getElementById(id);
const escape = text => String(text ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const initialQuery = new URLSearchParams(location.search);
let config = null, battle = null, matchId = initialQuery.get('match'), requestedReplay = initialQuery.get('replay') === '1', displayed = 0, replaying = false, snapshot = null;
let modelOptionsReady = false;
function newBattle() {
  battle?.destroy();
  battle = new window.Battle({ $frame: window.$('#battle-frame'), $logFrame: window.$('#battle-log'), paused: false, autoresize: false });
  window.BattleSound.setMute(true);
  $id('sound').textContent = '开启声音';
  $id('pause').textContent = '暂停';
  battle.scene.acceleration = Number($id('speed').value);
  window.arenaBattle = battle;
  displayed = 0;
  $id('welcome').style.display = 'none';
  fit();
}
function fit() {
  const width = document.querySelector('.stage-viewport').clientWidth;
  $id('battle-frame').style.transform = `scale(${Math.min(1, width / 640)})`;
  $id('battle-frame').style.transformOrigin = 'top left';
  document.querySelector('.stage-viewport').style.height = Math.min(360, width * 360 / 640) + 'px';
}
window.addEventListener('resize', fit);
async function get(path) { const r = await fetch(path, { cache: 'no-store' }); if (!r.ok) throw new Error('读取失败 ' + r.status); return r.json(); }
async function post(path, value) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-battle-token': config.adminToken }, body: JSON.stringify(value) });
  const result = await r.json(); if (!r.ok) throw new Error(result.message ?? result.error); return result;
}
function render(data) {
  snapshot = data;
  $id('turn').textContent = data.status === 'queued' ? '排队等待启动' : data.finished ? '对局结束 · ' + data.turn + ' 回合' : data.turn ? '第 ' + data.turn + ' 回合' : '选择首发';
  $id('outcome').textContent = data.status === 'aborted' ? '对局中止：' + data.error : data.finished ? (data.winner ? data.winner + ' 方获胜' : '平局') + (data.autonomousTaskVerified === false ? ' · AGH 任务未完整完成' : '') : data.paused ? '已暂停，当前提交处理结束后等待继续' : '双方自主选择，引擎结算后播放动画';
  $id('pause').disabled = replaying ? !battle : data.finished;
  $id('start').disabled = !config?.ready;
  const longTask = data.executionMode === 'agh-long-task-v1';
  $id('model-banner').textContent = ['A', 'B'].map(seat => displayModelName(data.models?.[seat]) || seat).join(' × ');
  $id('mode').textContent = (data.suite === 'concurrency-smoke' ? '并发验收 · 不计模型成绩 · ' : longTask ? '整局自主任务 · ' : '旧版逐回合任务 · ') + (replaying ? '记录回放' : '实时对战');
  $id('mode').classList.toggle('replay', replaying);
  for (const seat of ['A', 'B']) {
    const lower = seat.toLowerCase();
    $id('model-' + lower).textContent = displayModelName(data.models?.[seat]) || 'AGH 玩家 ' + seat;
    $id('name-' + lower).textContent = displayModelName(data.models?.[seat]) || '玩家 ' + seat;
    $id('team-' + lower).innerHTML = (data.teams?.[seat] ?? []).map(name => `<img alt="${escape(name)}" title="${escape(name)}" src="https://play.pokemonshowdown.com/sprites/gen5/${name.toLowerCase().replace(/[^a-z0-9]/g, '')}.png">`).join('');
    const actions = data.decisions.filter(d => d.seat === seat);
    const traces = data.traces.filter(t => t.seat === seat);
    const latest = traces.at(-1);
    const working = !data.finished && !data.paused && (data.pending ?? []).includes(seat) && latest?.type === 'agh-start';
    const task = data.taskResults?.[seat];
    $id('state-' + lower).textContent = task?.reason === 'completed' ? '任务完成' : task?.failureOrigin === 'supervisor-cancellation' ? '对局控制取消' : task && task.reason !== 'completed' ? '任务失败' : data.finished ? '等待任务收尾' : data.paused ? '已暂停' : working ? '决策中' : data.sessions[seat] ? '等待对手' : '准备会话';
    $id('thinking-' + lower).textContent = working ? '正在通过 AGH 观察战况、判断技能与换人…' : actions.at(-1)?.explanation ?? '等待选择首发';
    $id('history-' + lower).innerHTML = actions.slice(-8).reverse().map(d => `<div class="action"><small>回合 ${d.turn || '首发'} · 引擎已接受</small><strong>${escape(d.label)}</strong><p>${escape(d.explanation)}</p></div>`).join('');
    const historyLink = $id('agh-' + lower);
    historyLink.hidden = !data.sessions[seat];
    if (data.sessions[seat]) historyLink.href = 'http://127.0.0.1:' + (config?.playerWebPorts?.[seat] ?? (seat === 'A' ? 4181 : 4182)) + '/?session=' + encodeURIComponent(data.sessions[seat]);
  }
  const jev = data.traces.filter(t => t.type === 'jev');
  $id('details').textContent = '对局 ' + data.id + ' · ' + data.decisions.length + ' 次提交 · ' + jev.length + ' 次真实 Jev 评估。' + (longTask ? '每方一次整局任务，由 AGH 连续执行。' : '旧版记录：外部脚本逐回合发任务。');
}
async function poll() {
  try {
    config = await get('/api/config');
    const schedule = await get('/api/schedule');
    $id('schedule-status').textContent = `并发上限 ${schedule.concurrency} 场 · 正在执行 ${schedule.running} 场 · 排队 ${schedule.queued} 场${schedule.preparing ? ' · 正在准备 AGH 会话' : ''} · Jev jev-1.13.0`;
    if (document.activeElement !== $id('concurrency')) $id('concurrency').value = schedule.concurrency;
    if (!modelOptionsReady && config.modelCatalog?.length) {
      for (const seat of ['A', 'B']) {
        const select = $id('choose-' + seat.toLowerCase());
        select.innerHTML = config.modelCatalog.map(model => `<option value="${escape(model.route)}">${escape(displayModelName(model))}${model.contextWindow !== 128000 ? ' · ' + model.contextWindow / 1024 + 'k 压缩验收' : ''}</option>`).join('');
        select.value = config.models[seat].route;
      }
      modelOptionsReady = true;
    }
    if (!matchId) for (const seat of ['A', 'B']) $id('model-' + seat.toLowerCase()).textContent = displayModelName(config.models?.[seat]) || '正在连接';
    $id('connection').textContent = config.ready ? '两个真实 AGH 玩家已连接' : '正在准备 AGH 玩家…';
    if (!matchId) {
      const list = await get('/api/matches');
      matchId = list.current;
      $id('start').disabled = !config.ready;
    }
    if (matchId && !replaying) {
      const data = await get('/api/match/' + matchId);
      if (data.recorded || (requestedReplay && data.finished)) { replaying = true; }
      if (!battle) newBattle();
      battle.addBatch(displayBattleLines(data.publicLog.slice(displayed), data));
      displayed = data.publicLog.length;
      render(data);
    }
  } catch (error) { $id('connection').textContent = error.message; }
}
async function records() {
  const list = await get('/api/matches');
  const previous = $id('records').value;
  $id('records').innerHTML = '<option value="">选择历史对局</option>' + list.matches.reverse().map(id => `<option value="${escape(id)}">${escape(id)}</option>`).join('');
  $id('records').value = previous;
}
$id('start').onclick = async () => {
  $id('start').disabled = true;
  try {
    const result = await post('/api/start', { jev: $id('jev').checked, models: { A: $id('choose-a').value, B: $id('choose-b').value } });
    matchId = result.id; replaying = false; requestedReplay = false; newBattle();
    history.replaceState(null, '', '?match=' + matchId);
    await poll(); await records();
  } catch (error) { $id('outcome').textContent = error.message; $id('start').disabled = false; }
};
$id('set-concurrency').onclick = async () => {
  try { await post('/api/concurrency', { concurrency: Number($id('concurrency').value) }); await poll(); }
  catch (error) { $id('schedule-status').textContent = error.message; }
};
$id('pause').onclick = async () => {
  if (replaying) { battle.paused ? battle.play() : battle.pause(); $id('pause').textContent = battle.paused ? '继续' : '暂停'; return; }
  const paused = !snapshot?.paused;
  await post('/api/pause', { matchId, paused });
  paused ? battle.pause() : battle.play();
  $id('pause').textContent = paused ? '继续' : '暂停';
};
$id('speed').onchange = () => { if (battle) { battle.scene.acceleration = Number($id('speed').value); battle.messageFadeTime = 200 / Number($id('speed').value); } };
$id('sound').onclick = () => { const muted = $id('sound').textContent === '开启声音'; window.BattleSound.setMute(!muted); $id('sound').textContent = muted ? '关闭声音' : '开启声音'; };
$id('replay').onclick = async () => {
  const id = $id('records').value;
  if (!id) return;
  const data = await get('/api/match/' + id);
  if (!data.finished) { $id('outcome').textContent = '该局正在进行，请选择已结束的记录'; return; }
  matchId = id; replaying = true; newBattle();
  battle.addBatch(displayBattleLines(data.publicLog, data)); displayed = data.publicLog.length;
  render(data); history.replaceState(null, '', '?match=' + id + '&replay=1');
};
await poll(); await records();
setInterval(poll, 1200); setInterval(() => records().catch(() => {}), 12000);
