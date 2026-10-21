import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { transform } from 'esbuild';
import sim from 'pokemon-showdown';
import { FIXED_TEAMS } from '../packages/battle-arena/match.mjs';
import { ROOT } from './battle-env.mjs';

const pinned = 'c0f6bfc707a5e3bba4da3785e9cb06c8ae04f8d9';
const checkout = join(ROOT, 'vendor/showdown-client');
if (!existsSync(checkout)) {
  execFileSync('git', ['clone', '--filter=blob:none', '--no-checkout', 'https://github.com/smogon/pokemon-showdown-client.git', checkout], { stdio: 'inherit' });
  execFileSync('git', ['fetch', '--depth=1', 'origin', pinned], { cwd: checkout, stdio: 'inherit' });
  execFileSync('git', ['checkout', '--detach', pinned], { cwd: checkout, stdio: 'inherit' });
}
const revision = existsSync(join(checkout, '.git')) ? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim() : JSON.parse(readFileSync(join(checkout, 'SOURCE-REVISION.json'), 'utf8')).revision;
if (revision !== pinned) throw new Error('Showdown animation checkout is not at the pinned revision: ' + pinned);
const upstream = join(checkout, 'play.pokemonshowdown.com');
const out = join(ROOT, 'packages/battle-web/dist');
mkdirSync(out, { recursive: true });
const names = [
  'battle-dex-data', 'battle-log-misc', 'battle-dex', 'battle-teams', 'battle-text-parser',
  'battle-log', 'battle-scene-stub', 'battle-sound', 'battle-animations', 'battle-animations-moves', 'battle-tooltips', 'battle',
];
// Upstream also compiles these as shared global scripts. Do not import the full client app.
let bundle = '/* Pokemon Showdown replay/animation modules; upstream license headers retained. */\n' +
  'var Config = window.Config = {routes:{client:"play.pokemonshowdown.com",root:"pokemonshowdown.com"}, customcolors:{}, whitelist:[]};\n' +
  'var PS = undefined; var Net = undefined;\n';
const req = createRequire(import.meta.url);
// The pinned simulator uses [TOKEN] templates; the newer replay parser uses {TOKEN}.
function normalizeText(value) {
  if (typeof value === 'string') return value.replace(/\[([A-Z][A-Z0-9]*)\]/g, '{$1}');
  if (Array.isArray(value)) return value.map(normalizeText);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalizeText(child)]));
  return value;
}
const text = normalizeText(Object.fromEntries(['Default', 'Moves', 'Abilities', 'Items', 'Pokedex'].map(name => [name, req(join(ROOT, 'node_modules/pokemon-showdown/dist/data/text', name.toLowerCase() + '.js'))[name + 'Text']])));
Object.assign(text.Default.default, {
  startBattle: '{TRAINER1} 与 {TRAINER2} 的对战开始！', winBattle: '**{TRAINER}** 获胜！',
  tieBattle: '{TRAINER1} 与 {TRAINER2} 平局！', turn: '== 第 {NUMBER} 回合 ==',
  pokemon: '{NICKNAME}', opposingPokemon: '对手的 {NICKNAME}',
  switchIn: '{TRAINER} 派出了 {FULLNAME}！', switchInOwn: '去吧，{FULLNAME}！',
  switchOut: '{TRAINER} 收回了 {NICKNAME}！', switchOutOwn: '{NICKNAME}，回来吧！',
  faint: '{POKEMON} 倒下了！', move: '{POKEMON} 使用了 **{MOVE}**！',
  damagePercentage: '  （{POKEMON} 失去了 {PERCENTAGE}% 的体力！）',
  heal: '  {POKEMON} 恢复了体力。', superEffective: '  效果拔群！',
  resisted: '  效果不太好……', immune: '  对 {POKEMON} 没有效果……',
  crit: '  击中了要害！', miss: '  {POKEMON} 躲开了攻击！', fail: '  但是失败了！',
});
bundle += 'var BattleText=window.BattleText={en:' + JSON.stringify(text) + '}; var BattleUIText={};\n';
const species = [...new Set(Object.values(FIXED_TEAMS).flat().map(p => p.species))];
const data = {
  BattlePokedex: Object.fromEntries(species.map(s => { const p = sim.Dex.species.get(s); return [p.id, p]; })),
  BattleMovedex: Object.fromEntries(sim.Dex.moves.all().map(m => [m.id, m])),
  BattleAbilities: Object.fromEntries(sim.Dex.abilities.all().map(a => [a.id, a])),
  BattleItems: {}, BattleAliases: sim.Dex.data.Aliases, BattleTypeChart: sim.Dex.data.TypeChart,
  BattlePokemonSprites: Object.fromEntries(species.map(s => { const p = sim.Dex.species.get(s); return [p.id, { num: p.num, front: { w: 100, h: 100 }, back: { w: 100, h: 100 } }]; })),
};
for (const [name, value] of Object.entries(data)) bundle += `var ${name}=window.${name}=${JSON.stringify(value)};\n`;
for (const name of names) {
  const ext = name === 'battle-log-misc' ? '.js' : '.ts';
  const source = readFileSync(join(upstream, 'src', name + ext), 'utf8');
  const compiled = await transform(source, { loader: ext === '.ts' ? 'ts' : 'js', target: 'es2022', format: 'esm', legalComments: 'inline' });
  bundle += '\n' + compiled.code
    .replace(/^import\s[\s\S]*?;\s*$/gm, '')
    .replace(/^export\s*\{[\s\S]*?\};?\s*$/gm, '');
  // Animation initialization checks window.Dex before prefixing every effect URL.
  if (name === 'battle-dex') bundle += '\nwindow.Dex=Dex;\n';
}
bundle += '\nwindow.Battle=Battle; window.BattleSound=BattleSound; window.Dex=Dex;\n';
writeFileSync(join(out, 'showdown.js'), bundle);
for (const name of ['battle.css', 'battle-log.css']) {
  const css = readFileSync(join(upstream, 'style', name), 'utf8')
    .replaceAll('../fx/', 'https://play.pokemonshowdown.com/fx/');
  writeFileSync(join(out, name), css);
}
for (const name of ['jquery-2.2.4.min.js', 'html-sanitizer-minified.js']) cpSync(join(upstream, 'js/lib', name), join(out, name));
writeFileSync(join(out, 'provenance.json'), JSON.stringify({ simulator: 'pokemon-showdown@0.11.10', animationSource: 'https://github.com/smogon/pokemon-showdown-client', revision, modules: names, resources: 'Sprites, backgrounds and effects are loaded by the browser from play.pokemonshowdown.com.' }, null, 2));
console.log('Battle animation UI built from Showdown ' + revision.slice(0, 12));
