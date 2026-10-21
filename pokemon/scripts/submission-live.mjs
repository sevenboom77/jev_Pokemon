import './submission-provision.mjs';
if (!process.env.TYPESAFE_API_KEY || process.env.TYPESAFE_API_KEY.startsWith('YOUR_')) {
  throw new Error('带 Jev 对战需要填写 .env 中的 TYPESAFE_API_KEY');
}
await import('../packages/battle-arena/server.mjs');
