/* 直播分片的有序交付 —— 纯逻辑回归 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadSlice } = require('./helpers');

const { createOrderedPipe } = loadSlice(
  'offscreen/offscreen.js',
  'function createOrderedPipe',
  'function createWavRecorder',
  ['createOrderedPipe']
);

function makePipe() {
  const out = [];
  const pipe = createOrderedPipe((text, at) => out.push({ text, at }));
  return { out, pipe };
}

test('顺序完成时按序立即交付', () => {
  const { out, pipe } = makePipe();
  pipe.settle(1, 'aaa', 100);
  pipe.settle(2, 'bbb', 200);
  assert.deepStrictEqual(out, [{ text: 'aaa', at: 100 }, { text: 'bbb', at: 200 }]);
});

test('后一片先完成时压住，等前一片到达再连放', () => {
  const { out, pipe } = makePipe();
  pipe.settle(2, 'second', 200);
  pipe.settle(3, 'third', 300);
  assert.strictEqual(out.length, 0, '缺 1 号时不能放行');
  pipe.settle(1, 'first', 100);
  assert.deepStrictEqual(out.map((x) => x.text), ['first', 'second', 'third']);
  assert.strictEqual(pipe.waiting(), 0);
});

test('空文本占位：静音/失败/被丢弃的片不能卡住后面的片', () => {
  const { out, pipe } = makePipe();
  pipe.settle(2, 'keep', 200);
  pipe.settle(1, '', 100);
  assert.deepStrictEqual(out, [{ text: 'keep', at: 200 }]);
  assert.strictEqual(pipe.waiting(), 0);
});

test('缺号时后续保持等待，补齐后恢复', () => {
  const { out, pipe } = makePipe();
  pipe.settle(1, 'one', 100);
  pipe.settle(3, 'three', 300);
  assert.deepStrictEqual(out.map((x) => x.text), ['one']);
  assert.strictEqual(pipe.waiting(), 1);
  pipe.settle(2, 'two', 200);
  assert.deepStrictEqual(out.map((x) => x.text), ['one', 'two', 'three']);
});

test('reset 清空等待队列（停止直播时）', () => {
  const { out, pipe } = makePipe();
  pipe.settle(2, 'orphan', 200);
  assert.strictEqual(pipe.waiting(), 1);
  pipe.reset();
  assert.strictEqual(pipe.waiting(), 0);
  pipe.settle(1, 'fresh', 100);
  assert.deepStrictEqual(out.map((x) => x.text), ['fresh']);
});
