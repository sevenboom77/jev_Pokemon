import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const directory = resolve(process.argv[2] ?? 'output/playwright/recording-chat-20261004');
const master = join(directory, 'master.webm');
const metadata = JSON.parse(readFileSync(join(directory, 'recording.json'), 'utf8'));
if (!metadata.autonomousTaskVerified) throw new Error('Only export a verified complete recorded match');
const files = ['AGNES-vs-DeepSeek-Synced.mp4', 'AGH-AGNES.mp4', 'AGH-DeepSeek.mp4', 'Pokemon-Battle.mp4'];
// All outputs retain every original frame, including setup and final summaries.
// The clock comes from the same master frame; no independent timing correction.
const filter = [
  '[0:v]split=6[master][a][b][battle][clocka][clockbattle]',
  '[clocka]crop=600:64:1960:0[ca]',
  '[a]crop=1280:792:0:0[abase]',
  '[abase][ca]overlay=680:0[agnes]',
  '[b]crop=1280:792:1280:0[deepseek]',
  '[battle]crop=1152:748:704:844,pad=1152:812:0:64:color=0x0e1725[bbase]',
  '[clockbattle]crop=600:64:1960:0[cb]',
  '[bbase][cb]overlay=552:0[pokemon]',
].join(';');
const args = ['-hide_banner','-nostdin','-n','-i',master,'-filter_complex_threads','2','-filter_complex',filter];
const labels = ['master','agnes','deepseek','pokemon'];
for (let i = 0; i < files.length; i++) args.push('-map','['+labels[i]+']','-an','-c:v','libx264','-threads','3','-preset','fast','-crf','21','-pix_fmt','yuv420p','-r','25','-movflags','+faststart',join(directory,files[i]));
const encoded = spawnSync('ffmpeg',args,{stdio:'inherit'});
if (encoded.status !== 0) throw new Error('Video encoding failed');
const probe = name => {
  const result = spawnSync('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_name,width,height,r_frame_rate,nb_frames,start_time,duration','-of','json',join(directory,name)],{encoding:'utf8'});
  if (result.status !== 0) throw new Error('Cannot inspect ' + name);
  return JSON.parse(result.stdout);
};
const videos = Object.fromEntries(files.map(name=>[name,{...probe(name),bytes:statSync(join(directory,name)).size,sha256:createHash('sha256').update(readFileSync(join(directory,name))).digest('hex')}]));
const base = videos[files[0]].streams[0];
for (const video of Object.values(videos)) {
  const stream = video.streams[0];
  if (stream.nb_frames !== base.nb_frames || stream.start_time !== base.start_time || stream.duration !== base.duration || stream.r_frame_rate !== '25/1') throw new Error('Exports have diverging frame timelines');
}
const proof = { matchId:metadata.matchId,models:metadata.models,autonomousTaskVerified:true,source:'Live original AGH conversation tabs and live simulator animation',synchronization:'All three crops come from a single master. Identical frame count, start time, duration and 25 fps.',offsetFrames:{AGNES:0,DeepSeek:0,Pokemon:0},videos };
writeFileSync(join(directory,'video-verification.json'),JSON.stringify(proof,null,2)+'\n');
console.log(JSON.stringify({matchId:metadata.matchId,frames:base.nb_frames,duration:base.duration,files},null,2));
