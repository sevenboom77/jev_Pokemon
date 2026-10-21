import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { displayModelName } from '../packages/battle-web/model-names.js';

// Compose archived recordings only. This exporter never creates agent tasks.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(process.argv[2]);
const destination = resolve(process.argv[3]);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const entries = manifest.matches;
if (!Array.isArray(entries) || !entries.length || entries.length > 16) throw new Error('Supply 1 to 16 recorded matches');
mkdirSync(destination, { recursive: true });
const output = join(destination, 'AGNES-HARNESS-Pokemon-Grid.mp4');
if (existsSync(output)) throw new Error('Refusing to overwrite an existing collection');
const run = (args, logName) => {
  const log = openSync(join(destination, logName), 'w');
  try {
    const result = spawnSync('ffmpeg', args, { stdio: ['ignore', log, log] });
    if (result.status !== 0) throw new Error('Video export failed; see ' + logName);
  } finally { closeSync(log); }
};
const probe = file => {
  const result = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'format=duration:stream=width,height,r_frame_rate,nb_read_frames,nb_frames,start_time,duration', '-of', 'json', file], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Cannot inspect ' + file);
  return JSON.parse(result.stdout);
};
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const width = 1920, height = manifest.height ?? 1080, fps = 25, gap = 24, top = 120;
if (!Number.isInteger(height) || height < 1080 || height > 2160 || height % 2) throw new Error('Height must be an even number from 1080 to 2160');
const columns = manifest.columns ?? Math.ceil(Math.sqrt(entries.length));
if (!Number.isInteger(columns) || columns < 1 || columns > 4) throw new Error('Columns must be 1 to 4');
const rows = Math.ceil(entries.length / columns);
const even = value => Math.floor(value / 2) * 2;
const cellWidth = even((width - gap * (columns + 1)) / columns);
const cellHeight = even((height - top - gap * rows) / rows);
const header = rows > 2 ? 70 : 88, footer = 44, inset = 24;
const mediaWidth = cellWidth - inset * 2;
const mediaHeight = even(cellHeight - header - footer);
const seen = new Set(), matches = [];
for (const [index, entry] of entries.entries()) {
  const recording = JSON.parse(readFileSync(resolve(root, entry.recording), 'utf8'));
  if (!recording.autonomousTaskVerified || seen.has(recording.matchId)) throw new Error('Require unique verified recorded matches');
  seen.add(recording.matchId);
  const source = resolve(root, entry.file), information = probe(source), stream = information.streams[0];
  if (stream.r_frame_rate !== '25/1') throw new Error('Source must be 25 fps');
  const sourceFrames = Number(stream.nb_read_frames), startFrame = entry.startFrame ?? 0, endFrame = entry.endFrame ?? sourceFrames;
  if (!Number.isInteger(startFrame) || startFrame < 0 || startFrame >= sourceFrames) throw new Error('Invalid recording start frame');
  if (!Number.isInteger(endFrame) || endFrame <= startFrame || endFrame > sourceFrames) throw new Error('Invalid recording end frame');
  const crop = entry.crop;
  if (!Array.isArray(crop) || crop.length !== 4 || crop.some(n => !Number.isInteger(n) || n < 0) || crop[0] + crop[2] > stream.width || crop[1] + crop[3] > stream.height || crop[2] < 2 || crop[3] < 2) throw new Error('Invalid arena crop');
  const frames = endFrame - startFrame;
  const clip = join(destination, 'match-' + String(index + 1).padStart(2, '0') + '.mp4');
  if (existsSync(clip)) throw new Error('Refusing to overwrite an existing normalized track');
  const filter = `crop=${crop[2]}:${crop[3]}:${crop[0]}:${crop[1]},scale=${mediaWidth}:${mediaHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${mediaWidth}:${mediaHeight}:(ow-iw)/2:(oh-ih)/2:color=0x111d30,setsar=1,setpts=N/(${fps}*TB)`;
  run(['-hide_banner', '-nostdin', '-n', '-ss', String(startFrame / fps), '-i', source, '-vf', filter, '-frames:v', String(frames), '-an', '-c:v', 'libx264', '-threads', '3', '-preset', 'fast', '-crf', '17', '-pix_fmt', 'yuv420p', '-r', String(fps), '-movflags', '+faststart', clip], 'normalize-' + (index + 1) + '.log');
  const normalized = probe(clip);
  if (Number(normalized.streams[0].nb_read_frames) !== frames) throw new Error('Normalization changed the frame count');
  matches.push({ matchId: recording.matchId, source, sourceSha256: hash(source), sourceFrames, startFrame, endFrame, frames, duration: frames / fps, crop, models: Object.fromEntries(['A', 'B'].map(seat => [seat, displayModelName(recording.models[seat])])), requestModels: recording.models, turns: recording.turns, winner: recording.winner, clip, clipSha256: hash(clip) });
  console.log('Prepared ' + recording.matchId + ': ' + (frames / fps).toFixed(2) + ' seconds');
}
const totalFrames = Math.max(...matches.map(match => match.frames));
const arial = '/System/Library/Fonts/Supplemental/Arial.ttf';
const bold = '/System/Library/Fonts/Supplemental/Arial Bold.ttf';
const cjk = '/System/Library/Fonts/Hiragino Sans GB.ttc';
for (const font of [arial, bold, cjk]) if (!existsSync(font)) throw new Error('Missing font: ' + font);
const escapePath = path => path.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "'\\''");
const decorations = [], overlays = [], layout = [];
let textIndex = 0;
const text = (value, x, y, size, color = '0xeaf1ff', font = arial) => {
  const file = join(destination, 'title-' + (++textIndex) + '.txt');
  writeFileSync(file, value);
  decorations.push(`drawtext=fontfile='${escapePath(font)}':textfile='${escapePath(file)}':fontsize=${size}:fontcolor=${color}:x=${x}:y=${y}`);
};
decorations.push('drawbox=x=36:y=31:w=6:h=48:color=0x6ae0c2:t=fill');
text('AGNES HARNESS', 58, 27, 36, '0xf2f6ff', bold);
text('宝可梦自主对战', 418, 36, 24, '0xa7bacf', cjk);
text(matches.length + ' 场对局', 1710, 38, 22, '0xa7bacf', cjk);
for (const [index, match] of matches.entries()) {
  const x = gap + (index % columns) * (cellWidth + gap), y = top + Math.floor(index / columns) * (cellHeight + gap);
  const accent = ['0x6ae0c2', '0xa99bff', '0x7cc4ff', '0xffba77'][index % 4];
  decorations.push(`drawbox=x=${x}:y=${y}:w=${cellWidth}:h=${cellHeight}:color=0x111d30:t=fill`);
  decorations.push(`drawbox=x=${x}:y=${y}:w=${cellWidth}:h=3:color=${accent}:t=fill`);
  text('第 ' + String(index + 1).padStart(2, '0') + ' 局 · ' + match.turns + ' 回合', x + inset, y + 17, rows > 2 ? 16 : 20, accent, cjk);
  const pair = match.models.A + '  vs  ' + match.models.B;
  text(pair, x + inset, y + (rows > 2 ? 42 : 51), Math.min(24, Math.floor(mediaWidth / (pair.length * .60))), '0xf2f6ff', bold);
  text(match.matchId, x + inset, y + cellHeight - 29, 14, '0x8098af');
  text('AGH + Jev', x + cellWidth - 115, y + cellHeight - 29, 14, '0x8098af');
  overlays.push({ input: index + 1, x: x + inset, y: y + header });
  layout.push({ matchId: match.matchId, x, y, width: cellWidth, height: cellHeight, media: { x: x + inset, y: y + header, width: mediaWidth, height: mediaHeight } });
}
let chain = `[0:v]${decorations.join(',')}[background]`;
let previous = 'background';
for (const [index, overlay] of overlays.entries()) {
  const next = 'grid' + index;
  chain += `;[${overlay.input}:v]setpts=N/(${fps}*TB)[clip${index}];[${previous}][clip${index}]overlay=${overlay.x}:${overlay.y}:shortest=0:eof_action=repeat:repeatlast=1[${next}]`;
  previous = next;
}
const filterFile = join(destination, 'grid-filter.txt');
writeFileSync(filterFile, chain);
const args = ['-hide_banner', '-nostdin', '-n', '-f', 'lavfi', '-i', `color=c=0x0b1220:s=${width}x${height}:r=${fps}`];
for (const match of matches) args.push('-i', match.clip);
args.push('-filter_complex_threads', '2', '-filter_complex_script', filterFile, '-map', '[' + previous + ']', '-frames:v', String(totalFrames), '-an', '-c:v', 'libx264', '-threads', '4', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(fps), '-movflags', '+faststart', output);
run(args, 'grid-encode.log');
const result = probe(output), stream = result.streams[0];
if (Number(stream.nb_read_frames) !== totalFrames || stream.width !== width || stream.height !== height || stream.r_frame_rate !== '25/1') throw new Error('Unexpected collection frame timeline');
run(['-hide_banner', '-v', 'error', '-nostdin', '-i', output, '-f', 'null', '-'], 'grid-decode.log');
writeFileSync(join(destination, 'grid-verification.json'), JSON.stringify({ width, height, fps, columns, rows, uniqueMatches: matches.length, frames: totalFrames, duration: totalFrames / fps, shortClipPolicy: 'hold-last-frame', endRule: 'Each arena plays once at its original rate, then holds its final frame until the longest track ends.', layout, matches: matches.map(match => ({ ...match, holdStartFrame: match.frames, heldFrames: totalFrames - match.frames })), output: { file: output, ...result, bytes: statSync(output).size, sha256: hash(output), fullDecode: 'passed' } }, null, 2) + '\n');
console.log('Collection verified: ' + output);
