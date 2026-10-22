/* 语种探测 / 长文本切分 / 缓存键指纹 —— 纯逻辑回归 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadShared } = require('./helpers');

loadShared('shared/langs.js');
loadShared('shared/translate-core.js');

const { splitLongText, joinParts, providerFingerprint, cacheKey } = globalThis.LF_CORE;

test('语种探测：假名优先，含汉字的日语不再判成中文', () => {
  assert.strictEqual(LF.quickDetect('今日はいい天気ですね'), 'ja');
  assert.strictEqual(LF.quickDetect('ありがとうございます'), 'ja');
  assert.strictEqual(LF.quickDetect('今天天气不错，我们出去走走吧'), 'zh-CN');
  assert.strictEqual(LF.quickDetect('오늘 날씨가 좋네요'), 'ko');
  assert.strictEqual(LF.quickDetect('Hello world'), 'en');
  assert.strictEqual(LF.quickDetect('Привет мир'), 'ru');
});

test('长文本切分：每片不超上限且内容不丢', () => {
  const long = '这是一段用于测试的超长中文文本，它包含多个句子。'.repeat(60);
  const parts = splitLongText(long, 450);
  assert.ok(parts.length >= 3);
  parts.forEach((p) => assert.ok(p.length <= 450, '片长 ' + p.length));
  assert.strictEqual(parts.join('').replace(/\s/g, ''), long.replace(/\s/g, ''));
});

test('长文本切分：无标点时硬切', () => {
  const raw = 'x'.repeat(1000);
  const parts = splitLongText(raw, 450);
  parts.forEach((p) => assert.ok(p.length <= 450));
  assert.strictEqual(parts.join(''), raw);
});

test('长文本切分：短文本与无上限时原样返回', () => {
  assert.deepStrictEqual(splitLongText('hi', 450), ['hi']);
  const long = 'a'.repeat(2000);
  assert.strictEqual(splitLongText(long, 0).length, 1);
});

test('英文切分不破坏单词边界内的内容', () => {
  const en = 'This is a fairly long english sentence used for testing. '.repeat(30).trim();
  const parts = splitLongText(en, 450);
  assert.strictEqual(parts.join(' ').replace(/\s+/g, ' ').trim(), en.replace(/\s+/g, ' '));
});

test('译文拼接：CJK 不加空格，拉丁加空格', () => {
  assert.strictEqual(joinParts(['这是第一段。', '这是第二段。']), '这是第一段。这是第二段。');
  assert.strictEqual(joinParts(['Hello world.', 'This is next.']), 'Hello world. This is next.');
  assert.strictEqual(joinParts(['A.', '', 'B.']), 'A. B.');
});

test('缓存键随引擎配置变化（改提示词/地址/账号类型都要失效）', () => {
  const base = { id: 'a', type: 'openai', model: 'm', baseUrl: 'https://x/v1', promptTemplate: '', temperature: 0.1 };
  const key = (p) => cacheKey(p, 'auto', 'zh-CN', 'hello');
  assert.strictEqual(key(base), key(Object.assign({}, base)), '相同配置键应稳定');
  assert.notStrictEqual(key(base), key(Object.assign({}, base, { promptTemplate: '译成{target}' })));
  assert.notStrictEqual(key(base), key(Object.assign({}, base, { baseUrl: 'https://y/v1' })));
  assert.notStrictEqual(key(base), key(Object.assign({}, base, { plan: 'pro' })));
  assert.notStrictEqual(key(base), cacheKey(base, 'auto', 'zh-CN', 'hello2'));
});

test('providerFingerprint 只受影响输出的字段驱动', () => {
  const a = { type: 'deepl', baseUrl: '', model: '', plan: 'free' };
  const b = Object.assign({}, a, { name: '改个名字不影响' });
  assert.strictEqual(providerFingerprint(a), providerFingerprint(b));
  assert.notStrictEqual(providerFingerprint(a), providerFingerprint(Object.assign({}, a, { plan: 'pro' })));
});
