/* 共用小工具（shared/dom-utils.js）：转义与消息包装是全项目唯一实现，必须有回归 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadShared } = require('./helpers');

loadShared('shared/dom-utils.js');
const { esc, send } = globalThis.LF_DOM;

test('esc：五个 HTML 元字符都要转义', () => {
  assert.strictEqual(esc('<a href="x">&\'</a>'),
    '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});

test('esc：null / undefined 变空串，数字变字符串', () => {
  assert.strictEqual(esc(null), '');
  assert.strictEqual(esc(undefined), '');
  assert.strictEqual(esc(0), '0');
  assert.strictEqual(esc(''), '');
});

test('esc：中文与普通字符不受影响', () => {
  assert.strictEqual(esc('译文 hello 123'), '译文 hello 123');
});

test('send：正常回调返回值', async () => {
  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage: (msg, cb) => cb({ ok: true, echo: msg.type })
    }
  };
  const r = await send({ type: 'lf:ping' });
  assert.deepStrictEqual(r, { ok: true, echo: 'lf:ping' });
});

test('send：回调没给结果时返回 null（调用方只需判空）', async () => {
  globalThis.chrome = { runtime: { lastError: null, sendMessage: (msg, cb) => cb(undefined) } };
  assert.strictEqual(await send({ type: 'x' }), null);
});

test('send：runtime 同步抛错（扩展已重载）时也返回 null，不冒泡', async () => {
  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage: () => { throw new Error('Extension context invalidated.'); }
    }
  };
  assert.strictEqual(await send({ type: 'x' }), null);
});
