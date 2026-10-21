import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const required = ['AGNES_API_KEY', 'AGNES_BASE_URL', 'GATEWAY_API_KEY', 'GATEWAY_BASE_URL'];
for (const name of required) {
  if (!process.env[name] || process.env[name].startsWith('YOUR_')) throw new Error('请先填写 .env 中的 ' + name);
}
const home = join(root, '.runtime/submission-model-home');
function save(file, data) {
  mkdirSync(resolve(file, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
}
const model = process.env.AGNES_MODEL ?? 'agnes-3.0-flash';
save(join(home, 'profiles/local-dev/configuration.json'), {
  defaultAccountId: 'submission-agnes', accounts: [{ accountId: 'submission-agnes', enabled: true,
    model, baseUrl: process.env.AGNES_BASE_URL, credentialRef: 'secret://submission/agnes' }],
});
save(join(home, 'secrets/submission/agnes'), { kind: 'api-key', value: process.env.AGNES_API_KEY });
save(join(home, 'secrets/claude-gateway/deepseek-flash'), { kind: 'api-key', value: process.env.GATEWAY_API_KEY });
const extraCredential = join(home, 'secrets/submission/gateway.json');
save(extraCredential, { key: process.env.GATEWAY_API_KEY });
const models = JSON.parse(readFileSync(join(root, 'models.example.json'), 'utf8'));
save(join(root, '.runtime/battle-extra-models.json'), models.filter(m => !['agnes', 'deepseek'].includes(m.id)).map(m => ({
  route: m.route, model: m.requestModel, label: m.displayName, api: m.api, reasoning: m.reasoning,
  contextWindow: 128000, maxTokens: 8192, compat: m.compat, credentialPath: extraCredential, upstream: process.env.GATEWAY_BASE_URL,
})));
process.env.BATTLE_MODEL_HOME = home;
process.env.BATTLE_GATEWAY_BASE_URL = process.env.GATEWAY_BASE_URL;
console.log('已准备项目内的独立模型配置。尚未启动模型任务。');
