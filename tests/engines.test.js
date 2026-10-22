/* 引擎适配层：加载顺序 / 错误文案 / JSON 抠取 / 分发 —— 用 stub fetch 覆盖请求分支 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadShared } = require('./helpers');

// 与 background.js 的 importScripts 顺序保持一致：顺序错了这里会先炸
loadShared('shared/langs.js');
loadShared('shared/defaults.js');
loadShared('shared/translate-core.js');
loadShared('background/engines.js');

const { callEngine, humanError, extractJsonArray, API } = globalThis.LF_ENGINES;

test('按 Service Worker 的加载顺序可正常挂载模块', () => {
  assert.ok(globalThis.LF && globalThis.LF_DEFAULTS);
  assert.ok(globalThis.LF_CORE && typeof globalThis.LF_CORE.cacheKey === 'function');
  assert.ok(globalThis.LF_ENGINES && typeof globalThis.LF_ENGINES.callEngine === 'function');
});

/** 用固定响应替换全局 fetch（每个用例后自动还原） */
function withFetch(payload, status, fn) {
  const prev = globalThis.fetch;
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  globalThis.fetch = async () => ({
    ok: !status || (status >= 200 && status < 300),
    status: status || 200,
    text: async () => body
  });
  try {
    return fn();
  } finally {
    globalThis.fetch = prev;
  }
}

test('humanError 把常见状态码翻成可执行提示', () => {
  assert.match(humanError(401, { error: { message: 'bad key' } }), /API Key 无效/);
  assert.match(humanError(403, {}), /API Key 无效/);
  assert.match(humanError(429, {}), /请求过于频繁/);
  assert.match(humanError(404, {}), /接口地址或模型名不存在/);
  assert.match(humanError(503, {}), /暂时不可用/);
  assert.match(humanError(400, 'boom'), /HTTP 400 — boom/);
});

test('extractJsonArray 容忍围栏与前后废话', () => {
  assert.deepStrictEqual(extractJsonArray(['a', 'b']), ['a', 'b']);
  assert.deepStrictEqual(extractJsonArray('["a","b"]'), ['a', 'b']);
  assert.deepStrictEqual(extractJsonArray('```json\n["a","b"]\n```'), ['a', 'b']);
  assert.deepStrictEqual(extractJsonArray('好的，结果如下：\n["a","b"]\n以上。'), ['a', 'b']);
  assert.strictEqual(extractJsonArray('not json'), null);
  assert.strictEqual(extractJsonArray('{"a":1}'), null);
});

test('callEngine 按类型分发（google / mymemory 单条包装）', async () => {
  await withFetch([[[ '你好', 'hello', null, null, 1 ]], null, 'en'], 200, async () => {
    const out = await callEngine({ type: 'google-free' }, ['hello'], 'auto', 'zh-CN');
    assert.deepStrictEqual(out, ['你好']);
  });

  await withFetch({ responseData: { translatedText: '你好世界' } }, 200, async () => {
    const out = await callEngine({ type: 'mymemory' }, ['hello world'], 'en', 'zh-CN');
    assert.deepStrictEqual(out, ['你好世界']);
  });
});

test('callEngine 未知类型直接报错', async () => {
  await assert.rejects(() => callEngine({ type: 'nope' }, ['x'], 'auto', 'zh-CN'), /未知引擎类型/);
});

test('DeepL 缺 Key 时给出可执行提示（不发请求）', async () => {
  await assert.rejects(
    () => callEngine({ type: 'deepl', plan: 'free', apiKey: '' }, ['x'], 'auto', 'zh-CN'),
    /请先在设置中填写 DeepL API Key/
  );
});

test('OpenAI 兼容：远程 http 地址被拒绝，不发请求', async () => {
  await assert.rejects(
    () => callEngine({ type: 'openai', baseUrl: 'http://api.example.com/v1', model: 'm' }, ['x'], 'auto', 'zh-CN'),
    /必须使用 https/
  );
});

test('OpenAI 兼容：局域网 http 地址可用（与设置页校验规则一致）', async () => {
  const payload = { choices: [{ message: { content: '["局域网"]' } }] };
  await withFetch(payload, 200, async () => {
    const out = await callEngine(
      { type: 'openai', baseUrl: 'http://192.168.1.9:8080/v1', model: 'm' },
      ['lan'], 'auto', 'zh-CN'
    );
    assert.deepStrictEqual(out, ['局域网']);
  });
});

test('OpenAI 兼容：正常返回等长数组', async () => {
  const payload = { choices: [{ message: { content: '["甲","乙"]' } }] };
  await withFetch(payload, 200, async () => {
    const out = await callEngine(
      { type: 'openai', baseUrl: 'https://api.x/v1', model: 'm', temperature: 0 },
      ['a', 'b'], 'auto', 'zh-CN'
    );
    assert.deepStrictEqual(out, ['甲', '乙']);
  });
});

test('OpenAI 兼容：数量不一致时按行兜底，仍不一致才报错', async () => {
  await withFetch({ choices: [{ message: { content: '1. 甲\n2. 乙' } }] }, 200, async () => {
    const out = await callEngine(
      { type: 'openai', baseUrl: 'https://api.x/v1', model: 'm' }, ['a', 'b'], 'auto', 'zh-CN'
    );
    assert.deepStrictEqual(out, ['甲', '乙']);
  });
  await withFetch({ choices: [{ message: { content: '只有一行' } }] }, 200, async () => {
    await assert.rejects(
      () => callEngine({ type: 'openai', baseUrl: 'https://api.x/v1', model: 'm' }, ['a', 'b'], 'auto', 'zh-CN'),
      /译文数量与输入不一致/
    );
  });
});

test('各引擎上限表齐备（调度层依赖它切批）', () => {
  ['bing-free', 'google-free', 'mymemory', 'deepl', 'openai'].forEach((t) => {
    assert.ok(API[t] && API[t].batch >= 1, '缺少引擎配置：' + t);
  });
});
