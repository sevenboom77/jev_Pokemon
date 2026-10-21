import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT } from './battle-env.mjs';

const inputFile = process.argv[2];
if (!inputFile) throw new Error('Usage: node scripts/battle-batch.mjs schedule.json');
const input = JSON.parse(readFileSync(inputFile, 'utf8'));
const config = await fetch('http://127.0.0.1:8795/api/config').then(r => r.json());
if (!config.ready) throw new Error('Battle service is not ready.');
const response = await fetch('http://127.0.0.1:8795/api/batch', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-battle-token': config.adminToken },
  body: JSON.stringify({ pairs: input.pairs, jev: input.jev !== false, suite: input.suite ?? 'evaluation' }),
});
const result = await response.json();
if (!response.ok) throw new Error('Batch rejected: ' + (result.message ?? result.error));
const manifest = { submittedAt: new Date().toISOString(), concurrency: result.concurrency,
  pairs: input.pairs, suite: input.suite ?? 'evaluation', jev: input.jev !== false, ids: result.ids,
  pages: result.ids.map(id => 'http://127.0.0.1:8795/?match=' + id),
};
const file = join(ROOT, 'evidence/batch-' + randomUUID().slice(0, 8) + '.json');
writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ ...manifest, manifestFile: file, schedule: 'http://127.0.0.1:8795/api/schedule' }, null, 2));
