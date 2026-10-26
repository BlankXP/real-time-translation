/* 在 node 里用最小 chrome 桩跑真实的 background.js，验证密钥迁移链路 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { bootBackground } = require('./helpers');

const boot = bootBackground;

const OLD_SETTINGS = {
  targetLang: 'zh-CN',
  sourceLang: 'auto',
  providers: [
    { id: 'p1', type: 'openai', name: '旧配置', enabled: true, baseUrl: 'https://api.x/v1', model: 'm', apiKey: 'sk-OLD-KEY' },
    { id: 'p2', type: 'bing-free', name: 'Bing', enabled: true, builtin: true }
  ],
  activeProviderId: 'p1',
  voice: { engine: 'openai', openai: { baseUrl: 'https://api.openai.com/v1', model: 'whisper-1', apiKey: 'sk-VOICE' } }
};

test('升级后首次 lf:getSettings：旧密钥先搬到 local，再从 sync 抹掉', async () => {
  const ctx = boot({ sync: { settings: OLD_SETTINGS } });
  const resp = await ctx.send({ type: 'lf:getSettings' });

  assert.ok(resp && resp.ok, '应返回设置');
  assert.ok(!JSON.stringify(resp.settings).includes('sk-OLD-KEY'), '响应里不能有密钥');
  assert.strictEqual(ctx.local['lf:secrets'].providers.p1, 'sk-OLD-KEY', '旧 Key 应迁移到 local');
  assert.strictEqual(ctx.local['lf:secrets'].voice.openai, 'sk-VOICE', '语音 Key 也应迁移');
  assert.ok(!JSON.stringify(ctx.sync.settings).includes('sk-'), 'sync 里不应再有密钥');
  assert.strictEqual(ctx.sync.settings.providers[0].apiKey, undefined);
});

test('迁移后完整设置（含密钥）仍能被后台自己读到并使用', async () => {
  const ctx = boot({ sync: { settings: OLD_SETTINGS } });
  await ctx.send({ type: 'lf:getSettings' });
  const resp = await ctx.send({ type: 'lf:testProvider', providerId: 'p1' });

  assert.ok(resp && resp.ok, '测试连接应成功：' + JSON.stringify(resp));
  const hit = ctx.calls.find((c) => /chat\/completions/.test(c.url));
  assert.ok(hit, '应真的发起了翻译请求');
  assert.strictEqual(hit.opts.headers.Authorization, 'Bearer sk-OLD-KEY', '请求必须带上迁移后的密钥');
});

test('本来就没有密钥时不做多余写入', async () => {
  const clean = JSON.parse(JSON.stringify(OLD_SETTINGS));
  clean.providers[0].apiKey = '';
  delete clean.voice.openai.apiKey;
  const ctx = boot({ sync: { settings: clean } });
  const resp = await ctx.send({ type: 'lf:getSettings' });
  assert.ok(resp && resp.ok);
  assert.deepStrictEqual(ctx.local['lf:secrets'], undefined, '没有密钥就不该写 local');
});

test('本地写入失败：sync 里的旧密钥必须原样保留', async () => {
  const ctx = boot({ sync: { settings: OLD_SETTINGS }, failLocalSet: true });
  const resp = await ctx.send({ type: 'lf:getSettings' });

  assert.ok(resp && resp.ok);
  assert.strictEqual(ctx.sync.settings.providers[0].apiKey, 'sk-OLD-KEY', '本地没写成功就不能删 sync');
  assert.strictEqual(ctx.sync.settings.voice.openai.apiKey, 'sk-VOICE');
  assert.ok(!JSON.stringify(resp.settings).includes('sk-'), '但返回给内容脚本的副本仍不能带密钥');
});

test('本地写入失败后，下次调用会重试迁移', async () => {
  const ctx = boot({ sync: { settings: OLD_SETTINGS }, failLocalSet: true });
  await ctx.send({ type: 'lf:getSettings' });
  assert.strictEqual(ctx.local['lf:secrets'], undefined);

  ctx.flags.failLocalSet = false;          // 存储恢复正常
  const resp = await ctx.send({ type: 'lf:getSettings' });

  assert.ok(resp && resp.ok);
  assert.strictEqual(ctx.local['lf:secrets'].providers.p1, 'sk-OLD-KEY', '重试应把密钥落到本地');
  assert.strictEqual(ctx.sync.settings.providers[0].apiKey, undefined, '成功后才抹掉 sync');
  assert.ok(ctx.flags.localSetCalls >= 2, '应至少尝试过两次写入');
});
