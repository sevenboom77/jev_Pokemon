// A single browser canvas captures the two original AGH workbenches and arena.
// Cropping that master recording keeps all three exports on the same frame clock.
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const directory = resolve(process.argv[2] ?? 'output/playwright/recording-20261004');
mkdirSync(directory, { recursive: true });
const file = join(directory, 'control.json');
let initial = { matchId: null, sessions: {}, startedAt: null, status: '准备同步录屏' };
try { initial = JSON.parse(readFileSync(file, 'utf8')); } catch {}
writeFileSync(file, JSON.stringify(initial, null, 2) + '\n');
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>AGH 宝可梦对战 · 同步实录</title>
<style>
*{box-sizing:border-box}body{margin:0;width:2560px;height:1600px;overflow:hidden;background:#0e1725;color:#ecf3ff;font:18px system-ui,sans-serif}
header{height:64px;padding:0 30px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #324055}header b{font-size:25px;letter-spacing:1px}header span{color:#a9bbd2}#clock{font-variant-numeric:tabular-nums}
.agents{display:flex;height:728px}.panel{width:1280px}.label{height:40px;padding:0 24px;background:#17253b;display:flex;align-items:center;justify-content:space-between;font-size:18px}.b .label{background:#263042}.label small{color:#b2c6e0;font-size:15px}iframe{border:0;display:block;background:#fff;width:100%;height:688px}.battle .label{background:#173c32}.battle iframe{height:768px}
</style>
<header><b>AGNES HARNESS · 宝可梦自主对战</b><span id="match">一方一次任务 · 双方自主调用工具 · Jev 辅助</span><span id="clock">准备录制</span></header>
<section class="agents"><div class="panel"><div class="label"><strong id="name-a">A · 等待模型配置</strong><small>原生 AGH 会话与工具调用</small></div><iframe id="agh-a" title="A 方原生 AGH 界面"></iframe></div><div class="panel b"><div class="label"><strong id="name-b">B · 等待模型配置</strong><small>原生 AGH 会话与工具调用</small></div><iframe id="agh-b" title="B 方原生 AGH 界面"></iframe></div></section>
<section class="battle"><div class="label"><strong>真实对战动画 · Pokémon Showdown</strong><small id="state">同一帧时钟同步录制 · 非历史重演</small></div><iframe id="arena" title="真实对战动画"></iframe></section>
<script type="module">
import { displayModelName } from '/model-names.js';
let control={}; const urls={}; let modelMatchId=null;
async function update(){const c=await fetch('/control.json',{cache:'no-store'}).then(r=>r.json());control=c;let models=c.models;if(!models&&c.matchId&&modelMatchId!==c.matchId){const response=await fetch('/models.json?match='+encodeURIComponent(c.matchId));if(response.ok){models=(await response.json()).models;modelMatchId=c.matchId;}}if(models){for(const seat of ['A','B'])document.getElementById('name-'+seat.toLowerCase()).textContent=seat+' · '+displayModelName(models[seat]);document.title=['A','B'].map(seat=>displayModelName(models[seat])).join(' × ')+' · 同步实录';}for(const seat of ['A','B']){if(!c.sessions?.[seat])continue;const id='agh-'+seat.toLowerCase(),url='http://127.0.0.1:'+(seat==='A'?4181:4182)+'/?session='+encodeURIComponent(c.sessions[seat]);if(urls[id]!==url){urls[id]=url;document.getElementById(id).src=url;}}if(c.matchId&&urls.arena!==c.matchId){urls.arena=c.matchId;document.getElementById('arena').src='http://127.0.0.1:8795/?match='+c.matchId;}document.getElementById('match').textContent=c.matchId||'一方一次任务 · 双方自主调用工具 · Jev 辅助';document.getElementById('state').textContent=c.status||'同步实时录制';}
setInterval(()=>{const now=Date.now(),elapsed=control.startedAt?Math.max(0,now-control.startedAt):0;document.getElementById('clock').textContent=new Date(now).toLocaleTimeString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'})+' 北京时间 · '+String(Math.floor(elapsed/60000)).padStart(2,'0')+':'+String(Math.floor(elapsed/1000)%60).padStart(2,'0')+' 对局时间';},100);
update();setInterval(()=>update().catch(()=>{}),250);
</script></html>`;
writeFileSync(join(directory, 'capture.html'), html);
createServer(async (req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1:8797');
  if(url.pathname==='/models.json'){
    const id=url.searchParams.get('match');
    if(!/^battle-[a-zA-Z0-9-]+$/.test(id??'')){res.writeHead(400);res.end();return;}
    try{const upstream=await fetch('http://127.0.0.1:8795/api/match/'+id,{signal:AbortSignal.timeout(5000)});const data=await upstream.json();res.writeHead(upstream.status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({models:data.models}));}
    catch{res.writeHead(503);res.end();}
    return;
  }
  if(req.url==='/model-names.js'){res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'});res.end(readFileSync(new URL('../packages/battle-web/model-names.js',import.meta.url)));return;}
  if(req.url==='/control.json'){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(readFileSync(file));return;}
  if(req.url!=='/'&&req.url!=='/favicon.ico'){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(html);
}).listen(8797,'127.0.0.1',()=>console.log('Synchronized capture: http://127.0.0.1:8797/'));
