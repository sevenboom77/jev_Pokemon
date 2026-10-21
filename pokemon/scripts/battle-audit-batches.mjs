import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT } from './battle-env.mjs';
import { readStoredHistory } from './battle-history.mjs';

const [output, ...inputs] = process.argv.slice(2);
if (!output || !inputs.length) throw new Error('Usage: node scripts/battle-audit-batches.mjs evidence/report.json manifest1.json ...');
if (existsSync(output)) throw new Error('Audit exists; preserve it.');
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const allowed = new Set(['battle_observe','battle_evaluate','battle_act','battle_feedback','battle_wait']);
const peak = intervals => {
  const points = intervals.filter(([a,b])=>a&&b&&a<b).flatMap(([a,b])=>[[Date.parse(a),1],[Date.parse(b),-1]]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  let n=0,max=0; for(const [,delta]of points) { n+=delta; max=Math.max(max,n); } return max;
};
const batches = inputs.map(file => {
  const manifest = JSON.parse(readFileSync(file)); assert.equal(manifest.status, 'complete');
  const matches = manifest.ids.map((id,index) => {
    const dir=join(ROOT,'runs',id), b=JSON.parse(readFileSync(join(dir,'battle.json'))), seats={};
    assert.equal(b.models.A.route,manifest.pairs[index].A);assert.equal(b.models.B.route,manifest.pairs[index].B);
    for(const seat of ['A','B']) {
      const raw=join(dir,'agh-'+seat.toLowerCase()+'.jsonl');
      const rawText=existsSync(raw)?readFileSync(raw,'utf8'):readStoredHistory(seat,b.sessions[seat],{allowUnstarted:true});
      const es=rawText.trim().split('\n').filter(Boolean).map(JSON.parse);
      assert.ok(es.every((e,i)=>e.seq===i+1), id+' '+seat+' ledger continuity');
      const userTasks=es.filter(e=>e.type==='user/message'&&e.data.kind!=='runtime_context').length;
      const starts=es.filter(e=>e.type==='turn/start'), ends=es.filter(e=>e.type==='turn/end');
      assert.ok(userTasks<=1);assert.ok(starts.length<=1);assert.ok(ends.length<=1);
      if (starts.length) { assert.equal(userTasks,1); assert.equal(ends.length,1); }
      else { assert.equal(userTasks,0); assert.equal(ends.length,0); }
      assert.ok(es.filter(e=>e.type==='tool/call').every(e=>allowed.has(e.data.name)));
      const ledger=es.filter(e=>e.type==='cost/ledger'&&e.data.purpose==='inference');
      const compactions=es.filter(e=>e.surfaceOp?.op==='replace').map(e=>({seq:e.seq,origin:e.origin,
        nextInferenceStatus:ledger.find(l=>l.seq>e.seq)?.data.response?.status??null,
        continued:ledger.some(l=>l.seq>e.seq&&l.data.response?.status===200),
      }));
      seats[seat]={model:b.models[seat].model,session:b.sessions[seat],userTasks,taskStarts:starts.length,
        terminal:ends[0]?.data.reason??'not-started',error:ends[0]?.data.error??null,startedAt:starts[0]?.ts,endedAt:ends[0]?.ts,
        compactions,inferenceRequests:ledger.length,httpErrors:ledger.filter(e=>e.data.response?.status>=400).length,
        historySource:existsSync(raw)?(b.historyChecks?.[seat]?.exportSource??'agh-cli'):'read-only-sqlite-unstarted',sha256:createHash('sha256').update(rawText).digest('hex'),
        page:'http://127.0.0.1:'+(seat==='A'?4181:4182)+'/?session='+encodeURIComponent(b.sessions[seat]),
      };
    }
    const engineTerminal=b.publicLog.find(line=>line.startsWith('|win|')||line==='|tie|')??null;
    if(b.status==='finished')assert.equal(engineTerminal,b.winner?'|win|'+b.playerNames[b.winner]:'|tie|');
    else assert.equal(engineTerminal,null);
    const verified=b.status==='finished'&&['A','B'].every(s=>seats[s].terminal==='completed'&&seats[s].userTasks===1&&seats[s].taskStarts===1&&b.counts[s]===1);
    assert.equal(b.autonomousTaskVerified??false,verified,id+' AGH acceptance flag');
    return {id,suite:b.suite,models:b.models,seats,status:b.status,winner:b.winner,engineTerminal,
      verified,contextWindow:manifest.contextWindow,executionBudget:b.executionBudget??{maxTurns:40,timeoutMs:1200000},elapsedMs:b.elapsedMs,turn:b.turn,
      actions:b.decisions.length,jevCalls:b.traces.filter(t=>t.type==='jev').length,
      voluntarySwitches:b.decisions.filter(d=>d.switchReason==='voluntary').length,
      immediateSwitchBacks:b.decisions.filter(d=>d.immediateSwitchBack).length,
      error:b.error,page:'http://127.0.0.1:8795/?match='+id+'&replay=1',sha256:sha(join(dir,'battle.json')),
      eligibleForModelScores:verified&&b.suite==='evaluation'&&manifest.includeInModelScores!==false&&['A','B'].every(s=>b.models[s].contextWindow===128000),
    };
  });
  const intervals=matches.flatMap(m=>['A','B'].map(s=>[m.seats[s].startedAt,m.seats[s].endedAt]));
  const both=matches.map(m=>[[m.seats.A.startedAt,m.seats.B.startedAt].sort().at(-1),[m.seats.A.endedAt,m.seats.B.endedAt].sort()[0]]);
  return {manifest:file,purpose:manifest.purpose,suite:manifest.suite,contextWindow:manifest.contextWindow,
    concurrency:manifest.concurrency,attempted:matches.length,started:matches.filter(m=>m.seats.A.taskStarts||m.seats.B.taskStarts).length,verified:matches.filter(m=>m.verified).length,
    peakAghTasks:peak(intervals),peakGamesWithBothTasksActive:peak(both),matches};
});
const old=JSON.parse(readFileSync(join(ROOT,'evidence/domestic-pre-run-20261003.json'))).historicalFiles;
const preservation=Object.entries(old).map(([file,digest])=>({file,unchanged:sha(join(ROOT,file))===digest}));
assert.ok(preservation.every(p=>p.unchanged),'Historical evidence changed');
const all=batches.flatMap(b=>b.matches);
const normal=all.filter(m=>m.eligibleForModelScores);
const report={at:new Date().toISOString(),attempted:all.length,started:all.filter(m=>m.seats.A.taskStarts||m.seats.B.taskStarts).length,
  bothTasksStarted:all.filter(m=>m.seats.A.taskStarts&&m.seats.B.taskStarts).length,
  preparationOnly:all.filter(m=>!m.seats.A.taskStarts&&!m.seats.B.taskStarts).length,fullyVerified:all.filter(m=>m.verified).length,
  modelScoreEligible:normal.length,normalMetrics:{actions:normal.reduce((n,m)=>n+m.actions,0),jevCalls:normal.reduce((n,m)=>n+m.jevCalls,0),
    voluntarySwitches:normal.reduce((n,m)=>n+m.voluntarySwitches,0),immediateSwitchBacks:normal.reduce((n,m)=>n+m.immediateSwitchBacks,0)},batches,historicalPreservation:preservation,
  scope:'Finite domestic-model pilot plus explicit native-compaction and concurrency acceptance fixtures. Failed tasks and short/narrow-context fixtures excluded from model scores. No full league or stable ranking; gateway model tags are not independent official-version verification.'};
writeFileSync(output,JSON.stringify(report,null,2)+'\n');
let md='# 国产模型对打与并发验收\n\n';
md+=`本轮七个国产模型有 ${report.modelScoreEligible} 场完整 3v3 对局通过验收。另有短局并发与历史压缩技术测试，均不计模型成绩。\n\n`;
md+=`所有阶段共登记 ${report.attempted} 场：${report.started} 场至少一方实际启动 AGH，${report.bothTasksStarted} 场双方均启动，${report.preparationOnly} 场在准备阶段拒绝且未启动玩家任务。${report.fullyVerified} 场引擎结算、双方单次用户任务与正常结束全部核对通过。技术中止不计模型败局。\n\n`;
md+=`正常八场共 ${report.normalMetrics.actions} 次行动、${report.normalMetrics.jevCalls} 次 Jev 评估、${report.normalMetrics.voluntarySwitches} 次主动换人、${report.normalMetrics.immediateSwitchBacks} 次下一回合立即换回。这是当前赛程的观察，不单独证明策略改动的因果收益。\n\n`;
const smoke=batches.filter(b=>b.suite==='concurrency-smoke').sort((a,b)=>b.peakAghTasks-a.peakAghTasks)[0];
const compact=all.filter(m=>m.verified&&m.suite==='evaluation'&&!m.eligibleForModelScores).at(-1);
if(smoke)md+=`并发短局：${smoke.verified}/${smoke.attempted} 场完整完成，真实峰值 ${smoke.peakAghTasks} 个 AGH 任务、${smoke.peakGamesWithBothTasksActive} 场双方同时运行。失败仅影响所在对局。当前配置上限为 32 场；短局不证明 16 场长 3v3 吞吐，也未验收 32 场压力。\n\n`;
if(compact)md+=`压缩验收：[${compact.id}](${compact.page}) 已在第 ${compact.turn} 回合自然结束，双方 AGH 正常完成；${compact.seats.A.compactions.length+compact.seats.B.compactions.length} 次真实历史替换后的推理均正常继续。它采用较窄测试窗口，排除模型成绩。[A 真实会话](${compact.seats.A.page}) · [B 真实会话](${compact.seats.B.page})。\n\n`;
md+='## 正常换边对局\n\n| A 模型 | B 模型 | 胜者 | 回合 | 时间上限 | 主动换人 / 立即换回 | 回放 |\n| --- | --- | --- | ---: | ---: | ---: | --- |\n';
for(const m of all.filter(m=>m.eligibleForModelScores))md+=`| ${m.models.A.model} | ${m.models.B.model} | ${m.winner?m.models[m.winner].model+'（'+m.winner+'）':'平局'} | ${m.turn} | ${m.executionBudget.timeoutMs/60000} 分钟 | ${m.voluntarySwitches} / ${m.immediateSwitchBacks} | [${m.id}](${m.page}) |\n`;
md+='\n相同固定队伍、相同种子、相同 Jev（jev-1.13.0）。补跑的 40 分钟上限与早期的 20 分钟上限分别标明；这是有限小样本，不建立稳定胜率或排行榜。模型名称来自配置与真实网关响应，不是底层官方版本的独立认证。\n\n## 全部阶段与失败记录\n\n';
for(const batch of batches){
 md+=`## ${batch.purpose}\n\n${batch.verified}/${batch.attempted} 场通过完整 AGH 验收；实际同时运行 ${batch.peakAghTasks} 个 AGH 任务、${batch.peakGamesWithBothTasksActive} 场双方任务重叠的对局。每侧实际上下文窗口分别标明。\n\n| A 模型 | B 模型 | A / B 窗口 | 回合 | 引擎结果 | 双方任务 | 回放 |\n| --- | --- | --- | ---: | --- | --- | --- |\n`;
 for(const m of batch.matches)md+=`| ${m.models.A.model} | ${m.models.B.model} | ${m.models.A.contextWindow} / ${m.models.B.contextWindow} | ${m.turn} | ${m.status==='finished'?(m.winner?m.models[m.winner].model+'（'+m.winner+'）获胜':'平局'):'技术中止，无胜负'} | ${m.verified?'完整完成':m.seats.A.terminal+' / '+m.seats.B.terminal} | [${m.id}](${m.page}) |\n`;
 md+='\n';for(const m of batch.matches)md+=`- ${m.id}：[A 会话](${m.seats.A.page}) · [B 会话](${m.seats.B.page})。\n`;
 md+='\n';
}
md+=`原有 ${preservation.length} 个对局/AGH 日志文件哈希保持不变。16k/32k 历史压缩测试和 1v1 并发短局不计模型成绩；完整 3v3 小样本仍不足以建立稳定模型排名。未启动的任务单独标记，不能算作实际模型对局。所有结果均来自实际规则引擎与原始 AGH 日志。\n`;
writeFileSync(output.replace(/\.json$/,'.md'),md);
console.log(JSON.stringify({attempted:report.attempted,verified:report.fullyVerified,batches:batches.map(b=>({attempted:b.attempted,verified:b.verified,peakTasks:b.peakAghTasks,peakGames:b.peakGamesWithBothTasksActive}))}));
