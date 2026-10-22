/* 在 node 里用最小 chrome 桩跑真实的 background.js，验证密钥迁移链路 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

function makeArea(store) {
  return {
    async get(keys) {
      if (keys == null) return Object.assign({}, store);
      if (typeof keys === 'string') return { [keys]: store[keys] };
      if (Array.isArray(keys)) {
        const out = {};
        keys.forEach((k) => { out[k] = store[k]; });
        return out;
      }
      const out = {};
      Object.keys(keys).forEach((k) => { out[k] = k in store ? store[k] : keys[k]; });
      return out;
    },
    async set(obj) { Object.assign(store, JSON.parse(JSON.stringify(obj))); },
    async remove(keys) { (Array.isArray(keys) ? keys : [keys]).forEach((k) => { delete store[k]; }); },
    async clear() { Object.keys(store).forEach((k) => { delete store[k]; }); }
  };
}

function boot(seed) {
  const sync = JSON.parse(JSON.stringify(seed.sync || {}));
  const local = JSON.parse(JSON.stringify(seed.local || {}));
  const session = {};
  const calls = [];           // 记录后台发出的请求，供断言检查 Authorization
  const flags = { failLocalSet: !!seed.failLocalSet, localSetCalls: 0 };
  let onMessage = null;

  const noop = () => {};
  const event = () => ({ addListener: noop, removeListener: noop, hasListener: () => false });

  // local.set 可被切成失败，用于验证「迁移失败时不能抹掉 sync」
  const localArea = makeArea(local);
  const rawLocalSet = localArea.set;
  localArea.set = async (obj) => {
    flags.localSetCalls++;
    if (flags.failLocalSet) throw new Error('QUOTA_BYTES exceeded');
    return rawLocalSet(obj);
  };

  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, AbortController, TextEncoder, TextDecoder,
    fetch: async (url, opts) => {
      calls.push({ url, opts: opts || {} });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: '["ok"]' } }] })
      };
    },
    self: {},
    chrome: {
      storage: {
        sync: makeArea(sync),
        local: localArea,
        session: makeArea(session),
        onChanged: { addListener: noop }
      },
      runtime: {
        id: 'test',
        lastError: null,
        onMessage: { addListener: (fn) => { onMessage = fn; } },
        onInstalled: event(),
        onStartup: event(),
        onConnect: event(),
        sendMessage: noop,
        getURL: (p) => p,
        getManifest: () => ({ version: 'test' }),
        getContexts: async () => []
      },
      action: { onClicked: event(), setTitle: noop },
      commands: { onCommand: event() },
      contextMenus: { removeAll: noop, create: noop, onClicked: event() },
      tabs: { query: async () => [], sendMessage: noop, onRemoved: event(), onUpdated: event() },
      offscreen: { createDocument: async () => {}, closeDocument: async () => {} },
      scripting: { executeScript: async () => {} }
    },
    importScripts: (...files) => {
      files.forEach((f) => {
        const abs = path.resolve(ROOT, 'background', f);
        vm.runInContext(fs.readFileSync(abs, 'utf8'), sandbox, { filename: abs });
      });
    }
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  const bg = path.join(ROOT, 'background', 'background.js');
  vm.runInContext(fs.readFileSync(bg, 'utf8'), sandbox, { filename: bg });

  return { sandbox, sync, local, session, calls, flags, send: (msg) => call(onMessage, msg) };
}

function call(listener, msg) {
  return new Promise((resolve) => {
    let done = false;
    listener(msg, {}, (resp) => { done = true; resolve(resp); });
    setTimeout(() => { if (!done) resolve(null); }, 1500);
  });
}

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
