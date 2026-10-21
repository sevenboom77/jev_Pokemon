import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A read-only video stage: no AGH/provider clients and no match-start endpoint.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2]);
const port = Number(process.argv[3] ?? 8798);
mkdirSync(output, { recursive: true });
const ids = ['battle-2331a524', 'battle-ffed2593', 'battle-93e9ced9', 'battle-04e00d95', 'battle-7e58c430', 'battle-6db04883', 'battle-7c82c57e', 'battle-a543442e', 'battle-ee4794fc'];
const matches = new Map();
for (const id of ids) {
  const source = join(root, 'runs', id, 'battle.json');
  const bytes = readFileSync(source), data = JSON.parse(bytes);
  if (data.status !== 'finished' || !data.autonomousTaskVerified || data.executionMode !== 'agh-long-task-v1' || data.suite === 'concurrency-smoke') throw new Error('Only verified complete recorded matches: ' + id);
  matches.set(id, data);
  const dir = join(output, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'recording.json'), JSON.stringify({ matchId: id, capturedLive: false, source: 'Archived real match events rendered by the Pokémon Showdown animation engine', sourceFile: source, sourceSha256: createHash('sha256').update(bytes).digest('hex'), models: Object.fromEntries(['A', 'B'].map(seat => [seat, data.models[seat].model])), jev: 'jev-1.13.0', autonomousTaskVerified: true, turns: data.turn, winner: data.winner }, null, 2) + '\n');
}
writeFileSync(join(output, 'source-index.json'), JSON.stringify({ matches: ids, port }, null, 2) + '\n');
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>AGNES HARNESS 宝可梦对战</title>
<link rel="stylesheet" href="/dist/battle.css"><link rel="stylesheet" href="/dist/battle-log.css">
<style>*{box-sizing:border-box}html,body{margin:0;background:#0b1220;width:960px;height:540px;overflow:hidden}#arena{position:relative;width:640px;height:360px;transform:scale(1.5);transform-origin:top left;border:0;visibility:hidden}.battle .backdrop{opacity:1!important}.battle .leftbar,.battle .rightbar{background:rgba(248,250,243,.86)}#log{display:none}</style>
<div id="arena"></div><div id="log"></div>
<script>window.Config={routes:{client:'127.0.0.1:${port}'}};</script>
<script src="/dist/jquery-2.2.4.min.js"></script><script src="/dist/html-sanitizer-minified.js"></script><script src="/dist/showdown.js"></script>
<script type="module">
import {displayBattleLines} from '/model-names.js';
const id=new URLSearchParams(location.search).get('match');
window.captureState={id,ready:false,startedAt:null,endedAt:null,errors:[]};
window.addEventListener('error',e=>captureState.errors.push(e.message));
const data=await fetch('/match/'+id).then(r=>{if(!r.ok)throw new Error('Missing recorded match');return r.json()});
window.BattleSound.setMute(true);
const battle=new window.Battle({$frame:window.$('#arena'),$logFrame:window.$('#log'),paused:true,autoresize:false,log:displayBattleLines(data.publicLog,data)});
window.captureBattle=battle;
battle.scene.acceleration=1;
battle.seekTurn(0,true);
battle.subscribe(event=>{if(event==='atqueueend'&&battle.ended&&captureState.startedAt){captureState.endedAt=Date.now();captureState.turn=battle.turn;captureState.consumedSteps=battle.currentStep;captureState.totalSteps=battle.stepQueue.length;}});
await new Promise(resolve=>setTimeout(resolve,1200));
await Promise.all([...document.images].map(img=>img.complete?Promise.resolve():new Promise(resolve=>{img.addEventListener('load',resolve,{once:true});img.addEventListener('error',resolve,{once:true});setTimeout(resolve,15000)})));
captureState.ready=true;
window.startCapture=()=>{if(!captureState.ready||captureState.startedAt)throw new Error('Capture not ready');captureState.startedAt=Date.now();document.getElementById('arena').style.visibility='visible';battle.play();};
</script></html>`;
writeFileSync(join(output, 'capture.html'), html);
const inFlight = new Map();
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.png':'image/png', '.gif':'image/gif', '.jpg':'image/jpeg', '.webm':'video/webm', '.mp4':'video/mp4', '.json':'application/json' };
const assetsRoot = join(output, 'assets');
async function asset(pathname) {
  const cached = join(assetsRoot, pathname);
  const vendor = join(root, 'vendor/showdown-client/play.pokemonshowdown.com', pathname);
  if (existsSync(cached)) return readFileSync(cached);
  if (existsSync(vendor)) return readFileSync(vendor);
  if (!inFlight.has(pathname)) inFlight.set(pathname, (async () => {
    const response = await fetch('https://play.pokemonshowdown.com' + pathname, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('Asset unavailable');
    const bytes = Buffer.from(await response.arrayBuffer());
    mkdirSync(dirname(cached), { recursive: true });
    writeFileSync(cached, bytes);
    return bytes;
  })().finally(() => inFlight.delete(pathname)));
  return inFlight.get(pathname);
}
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:' + port), path = url.pathname;
  const send = (type, body) => { res.writeHead(200, { 'content-type':type });res.end(body); };
  if (req.method !== 'GET') { res.writeHead(405);res.end();return; }
  try {
    if (path === '/') return send(mime['.html'], html);
    if (path === '/index.json') return send(mime['.json'], JSON.stringify({ matches: ids }));
    if (path === '/model-names.js') return send(mime['.js'], readFileSync(join(root, 'packages/battle-web/model-names.js')));
    if (path.startsWith('/match/')) {
      const data = matches.get(path.slice(7));
      if (!data) {res.writeHead(404);res.end();return;}
      return send(mime['.json'], JSON.stringify({id:data.id,models:data.models,playerNames:data.playerNames,publicLog:data.publicLog}));
    }
    if (/^\/dist\/(battle\.css|battle-log\.css|showdown\.js|jquery-2\.2\.4\.min\.js|html-sanitizer-minified\.js)$/.test(path)) return send(mime[extname(path)], readFileSync(join(root,'packages/battle-web',path)));
    if (/^\/(sprites|fx)\/[a-zA-Z0-9_./-]+\.(png|gif|jpg|webm|mp4)$/.test(path) && !path.includes('..')) return send(mime[extname(path)], await asset(path));
    res.writeHead(404);res.end();
  } catch { res.writeHead(502);res.end(); }
});
server.listen(port, '127.0.0.1', () => console.log('Read-only recorded-match video stage: http://127.0.0.1:' + port));
