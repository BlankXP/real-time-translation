/* 调度层：并发池的错误隔离、内容脚本车道数与总并发的关系 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { bootBackground } = require('./helpers');

/** google-free：batch=1，16 条文本 = 16 个分片，正好用来看池子的实际并发 */
const GOOGLE_SETTINGS = {
  providers: [{ id: 'g', type: 'google-free', name: 'Google', enabled: true, builtin: true }],
  activeProviderId: 'g',
  advanced: { concurrency: 4, cacheEnabled: false }
};

const OPENAI_SETTINGS = {
  providers: [{ id: 'o', type: 'openai', name: 'AI 模型', enabled: true, baseUrl: 'https://api.x/v1', model: 'm' }],
  activeProviderId: 'o',
  advanced: { concurrency: 2, cacheEnabled: false }
};

/** Google 逐句接口的响应形态：data[0] 是分段数组，每段首元素是译文 */
function googleOk() {
  return { ok: true, status: 200, text: async () => JSON.stringify([[['译']]]) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('runPool：单个任务抛错只留空槽位，不拖死同批其它任务', async () => {
  const ctx = bootBackground({ sync: { settings: GOOGLE_SETTINGS } });
  assert.strictEqual(typeof ctx.sandbox.runPool, 'function', 'runPool 应能在 SW 作用域内取到');

  const out = await ctx.sandbox.runPool([
    async () => 'a',
    async () => { throw new Error('boom'); },
    async () => 'c',
    async () => { throw new Error('boom2'); },
    async () => 'e'
  ], 2);

  assert.deepStrictEqual(Array.from(out), ['a', null, 'c', null, 'e']);
});

test('runPool：任务数为 0 时不启动 worker，也不报错', async () => {
  const ctx = bootBackground({ sync: { settings: GOOGLE_SETTINGS } });
  const out = await ctx.sandbox.runPool([], 4);
  assert.deepStrictEqual(Array.from(out), []);
});

test('单车道：单请求用满用户并发（4 条同时在飞）', async () => {
  const ctx = bootBackground({
    sync: { settings: GOOGLE_SETTINGS },
    fetch: async () => { await sleep(15); return googleOk(); }
  });
  const texts = Array.from({ length: 16 }, (_, i) => 'text ' + i);
  const r = await ctx.send({ type: 'lf:translate', texts, lanes: 1 });

  assert.ok(r && r.ok, '应成功：' + JSON.stringify(r && r.error));
  assert.strictEqual(r.results.length, 16);
  assert.strictEqual(ctx.fetchStats.maxInflight, 4, '并发应等于设置值 4');
});

test('双车道：总并发不被窗口并发放大（2×2 仍是 4）', async () => {
  const ctx = bootBackground({
    sync: { settings: GOOGLE_SETTINGS },
    fetch: async () => { await sleep(15); return googleOk(); }
  });
  const texts = Array.from({ length: 16 }, (_, i) => 'text ' + i);
  // 内容脚本窗口并发时，两批会同时到达后台：后台按车道数把池子减半
  const [r1, r2] = await Promise.all([
    ctx.send({ type: 'lf:translate', texts, lanes: 2 }),
    ctx.send({ type: 'lf:translate', texts, lanes: 2 })
  ]);

  assert.ok(r1 && r1.ok && r2 && r2.ok);
  // 两批各 2 并发 → 峰值 4，而不是 8
  assert.strictEqual(ctx.fetchStats.maxInflight, 4, '峰值并发应仍为设置值 4');
});

test('双车道 + 奇数并发：峰值恰好等于设置值 3', async () => {
  const odd = JSON.parse(JSON.stringify(GOOGLE_SETTINGS));
  odd.advanced.concurrency = 3;
  const ctx = bootBackground({
    sync: { settings: odd },
    fetch: async () => { await sleep(15); return googleOk(); }
  });
  const texts = Array.from({ length: 16 }, (_, i) => 'text ' + i);
  // 车道 0 分到 2 条、车道 1 分到 1 条 → 峰值 3，既不浪费也不越界
  const [r1, r2] = await Promise.all([
    ctx.send({ type: 'lf:translate', texts, lanes: 2, lane: 0 }),
    ctx.send({ type: 'lf:translate', texts, lanes: 2, lane: 1 })
  ]);

  assert.ok(r1 && r1.ok && r2 && r2.ok);
  assert.strictEqual(ctx.fetchStats.maxInflight, 3);
});

test('并发=1 时窗口车道不会把峰值顶到 2', async () => {
  const one = JSON.parse(JSON.stringify(GOOGLE_SETTINGS));
  one.advanced.concurrency = 1;
  const ctx = bootBackground({
    sync: { settings: one },
    fetch: async () => { await sleep(10); return googleOk(); }
  });
  const texts = Array.from({ length: 4 }, (_, i) => 'text ' + i);
  await ctx.send({ type: 'lf:translate', texts, lanes: 1 });
  assert.strictEqual(ctx.fetchStats.maxInflight, 1, '并发=1 必须严格串行');
});

test('分片全失败：返回 ok:false 且带原因，而不是静默成功', async () => {
  const ctx = bootBackground({
    sync: { settings: OPENAI_SETTINGS },
    fetch: async () => { throw new TypeError('Failed to fetch'); }
  });
  const r = await ctx.send({ type: 'lf:translate', texts: ['hello'] });

  assert.strictEqual(r.ok, false, '全部失败不能返回 ok:true');
  assert.ok(r.error, '必须带可读原因，否则 UI 只剩一句"翻译失败"');
});

test('部分分片失败：成功的结果照常返回，失败槽位为 null', async () => {
  let n = 0;
  const ctx = bootBackground({
    sync: { settings: GOOGLE_SETTINGS },
    fetch: async () => {
      n++;
      if (n % 2 === 0) throw new TypeError('Failed to fetch');
      return googleOk();
    }
  });
  const texts = Array.from({ length: 4 }, (_, i) => 'text ' + i);
  const r = await ctx.send({ type: 'lf:translate', texts, lanes: 1 });

  assert.ok(r.ok, '还有成功的分片时整体仍算成功');
  assert.ok(r.results.some((x) => x === '译'), '成功的分片要有译文');
  assert.ok(r.results.some((x) => x === null), '失败的分片应为 null');
});
