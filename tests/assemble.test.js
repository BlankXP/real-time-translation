/* 调度层记账：长文跨片聚合 / 部分失败判废 / 缓存命中 —— 纯函数 + 端到端各一层 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadShared, bootBackground } = require('./helpers');

loadShared('shared/translate-core.js');
const { assembleResults } = globalThis.LF_CORE;

/* ---------- 纯函数层 ---------- */

test('单条单片的普通情况', () => {
  const r = assembleResults({
    units: [{ idx: 0, part: 0, total: 1 }],
    chunkSizes: [1],
    chunkResults: [{ ok: true, out: ['甲'] }],
    count: 1
  });
  assert.deepStrictEqual(r.values, ['甲']);
  assert.strictEqual(r.fetched, 1);
  assert.strictEqual(r.failed, 0);
  assert.strictEqual(r.firstError, null);
});

test('长文切片跨分片：按序拼回一条（CJK 不加空格）', () => {
  // 一条原文切成 3 片，第 2、3 片落在同一个分片里（模拟 chunkTexts 的打包结果）
  const r = assembleResults({
    units: [
      { idx: 0, part: 0, total: 3 },
      { idx: 0, part: 1, total: 3 },
      { idx: 0, part: 2, total: 3 }
    ],
    chunkSizes: [1, 2],
    chunkResults: [
      { ok: true, out: ['第一段。'] },
      { ok: true, out: ['第二段。', '第三段。'] }
    ],
    count: 1
  });
  assert.deepStrictEqual(r.values, ['第一段。第二段。第三段。']);
  assert.strictEqual(r.fetched, 1, '一条原文只算一次 fetched');
  assert.strictEqual(r.failed, 0);
});

test('任一片缺失 → 整条判废（绝不拼半截译文）', () => {
  const r = assembleResults({
    units: [
      { idx: 0, part: 0, total: 3 },
      { idx: 0, part: 1, total: 3 },
      { idx: 0, part: 2, total: 3 }
    ],
    chunkSizes: [1, 2],
    // 第二个分片只回了 1 条：第 3 片是 undefined
    chunkResults: [{ ok: true, out: ['第一段。'] }, { ok: true, out: ['第二段。'] }],
    count: 1
  });
  assert.deepStrictEqual(r.values, [null]);
  assert.strictEqual(r.fetched, 0);
  assert.strictEqual(r.failed, 1);
});

test('某个分片整体失败：只影响它覆盖的原文，其余照常返回', () => {
  const r = assembleResults({
    units: [
      { idx: 0, part: 0, total: 1 },
      { idx: 1, part: 0, total: 1 }
    ],
    chunkSizes: [1, 1],
    chunkResults: [
      { ok: true, out: ['甲'] },
      { ok: false, error: 'Bing 返回条数与输入不一致（期望 1，实际 0）' }
    ],
    count: 2
  });
  assert.deepStrictEqual(r.values, ['甲', null]);
  assert.strictEqual(r.fetched, 1);
  assert.strictEqual(r.failed, 1);
  assert.match(r.firstError, /条数与输入不一致/);
});

test('失败槽位是 null（并发池错误隔离）时给出可读兜底原因', () => {
  const r = assembleResults({
    units: [{ idx: 0, part: 0, total: 1 }],
    chunkSizes: [1],
    chunkResults: [null],
    count: 1
  });
  assert.deepStrictEqual(r.values, [null]);
  assert.ok(!/^null$/.test(String(r.firstError)));
  assert.match(r.firstError, /未返回原因/);
});

test('firstError 只保留第一条失败原因', () => {
  const r = assembleResults({
    units: [{ idx: 0, part: 0, total: 1 }, { idx: 1, part: 0, total: 1 }],
    chunkSizes: [1, 1],
    chunkResults: [{ ok: false, error: '先失败的' }, { ok: false, error: '后失败的' }],
    count: 2
  });
  assert.strictEqual(r.firstError, '先失败的');
});

test('units 未覆盖到的下标保持 null（防御脏输入）', () => {
  const r = assembleResults({
    units: [{ idx: 0, part: 0, total: 1 }],
    chunkSizes: [1],
    chunkResults: [{ ok: true, out: ['甲'] }],
    count: 2
  });
  assert.deepStrictEqual(r.values, ['甲', null]);
  assert.strictEqual(r.failed, 1);
});

/* ---------- 端到端：真的走 lf:translate ---------- */

const GOOGLE_SETTINGS = (cacheEnabled) => ({
  providers: [{ id: 'g', type: 'google-free', name: 'Google', enabled: true, builtin: true }],
  activeProviderId: 'g',
  advanced: { concurrency: 2, cacheEnabled: !!cacheEnabled }
});

function googleOk() {
  return { ok: true, status: 200, text: async () => JSON.stringify([[['译']]]) };
}

test('缓存命中：第二次相同文本不再发请求，且结果一致', async () => {
  const ctx = bootBackground({
    sync: { settings: GOOGLE_SETTINGS(true) },
    fetch: async () => googleOk()
  });

  const first = await ctx.send({ type: 'lf:translate', texts: ['hello'] });
  assert.ok(first.ok);
  const callsAfterFirst = ctx.calls.length;
  assert.ok(callsAfterFirst > 0, '首次应真实请求');

  const second = await ctx.send({ type: 'lf:translate', texts: ['hello'] });
  assert.strictEqual(ctx.calls.length, callsAfterFirst, '命中缓存后不应再发请求');
  assert.strictEqual(second.stats.cacheHits, 1);
  assert.deepStrictEqual(second.results, first.results);
});

test('超长文本：切成多片请求，最终仍合成一条结果', async () => {
  const ctx = bootBackground({
    sync: { settings: GOOGLE_SETTINGS(false) },
    fetch: async () => googleOk()
  });

  // google-free 单条上限 1000 字符 → 这段会被切成 3 片左右
  const long = '这是一段用于测试长文本切分的句子。'.repeat(100);
  assert.ok(long.length > 1000);
  const r = await ctx.send({ type: 'lf:translate', texts: [long] });

  assert.ok(r.ok, '应成功：' + r.error);
  assert.strictEqual(r.results.length, 1, '一条原文只产出一条译文');
  assert.strictEqual(r.stats.fetched, 1);
  assert.ok(ctx.calls.length >= 2, '长文应被切成多片请求，实际 ' + ctx.calls.length);
  assert.strictEqual(r.results[0], '译'.repeat(ctx.calls.length), '各片译文按序拼接');
});
