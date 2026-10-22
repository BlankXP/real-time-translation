/* 脏块收集（scan.js）：新增节点 → 该翻哪个块 —— 最小 DOM 桩 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadShared } = require('./helpers');

loadShared('content/scan.js');
const { collectLeafBlocks, isTranslatableBlock } = globalThis.LF_SCAN;

// findBlockAncestor 会拿 document.body / documentElement 作边界，给个空对象即可
globalThis.document = {};

const BLOCKS = new Set(['P', 'DIV', 'LI', 'TD', 'TH', 'BLOCKQUOTE', 'FIGCAPTION',
  'DD', 'DT', 'SUMMARY', 'DETAILS', 'FIGURE', 'SECTION', 'ARTICLE', 'ASIDE', 'MAIN']);

function descendants(node) {
  const out = [];
  (node.childNodes || []).forEach((c) => { out.push(c); out.push(...descendants(c)); });
  return out;
}

function mk(tag, children, attrs) {
  const node = {
    tagName: tag.toUpperCase(),
    childNodes: children || [],
    parentElement: null,
    attributes: attrs || {},
    isContentEditable: false,
    textContent: '',
    matches() { return BLOCKS.has(node.tagName); },
    querySelector() { return descendants(node).find((x) => BLOCKS.has(x.tagName)) || null; },
    querySelectorAll() { return descendants(node).filter((x) => BLOCKS.has(x.tagName)); },
    closest(sel) {
      const wantAria = sel.indexOf('[aria-hidden="true"]') !== -1;
      const wantButton = sel.indexOf('button') !== -1;
      let cur = node;
      while (cur) {
        if (wantAria && cur.attributes && cur.attributes['aria-hidden'] === 'true') return cur;
        if (wantButton && cur.tagName === 'BUTTON') return cur;
        cur = cur.parentElement;
      }
      return null;
    }
  };
  (children || []).forEach((c) => { c.parentElement = node; });
  return node;
}

test('新增块级元素：自身就是叶子块', () => {
  const p = mk('p');
  const dirty = new Set();
  collectLeafBlocks(p, dirty);
  assert.deepStrictEqual([...dirty], [p]);
});

test('新增容器：其中每个叶子块都要进脏集合', () => {
  const p1 = mk('p');
  const p2 = mk('p');
  const div = mk('div', [p1, p2]);
  const dirty = new Set();
  collectLeafBlocks(div, dirty);
  assert.deepStrictEqual([...dirty], [p1, p2]);
});

test('在已有段落里新增行内元素：应把外层段落加入脏块', () => {
  const span = mk('span');
  const p = mk('p', [span]);
  const dirty = new Set();
  collectLeafBlocks(span, dirty);
  assert.deepStrictEqual([...dirty], [p], '行内节点必须回溯到所属的叶子块');
});

test('行内元素嵌套：同样回溯到块级祖先', () => {
  const em = mk('em');
  const a = mk('a', [em]);
  const p = mk('p', [a]);
  const dirty = new Set();
  collectLeafBlocks(em, dirty);
  assert.deepStrictEqual([...dirty], [p]);
});

test('没有块级祖先时不报错也不入集合', () => {
  const span = mk('span');
  const dirty = new Set();
  assert.doesNotThrow(() => collectLeafBlocks(span, dirty));
  assert.strictEqual(dirty.size, 0);
});

test('传入非法节点直接忽略', () => {
  const dirty = new Set();
  assert.doesNotThrow(() => collectLeafBlocks(null, dirty));
  assert.doesNotThrow(() => collectLeafBlocks({}, dirty));
  assert.strictEqual(dirty.size, 0);
});

/* ---------- 跳过规则（必须与整页扫描一致） ---------- */

test('aria-hidden 容器里的新增段落不应入脏块', () => {
  const p = mk('p');
  const section = mk('section', [p], { 'aria-hidden': 'true' });
  const dirty = new Set();
  collectLeafBlocks(section, dirty);
  assert.strictEqual(dirty.size, 0, '整页扫描会跳过 aria-hidden，增量也必须跳过');
  assert.strictEqual(isTranslatableBlock(p), false);
});

test('可编辑区域内的新增块不应入脏块', () => {
  const p = mk('p');
  p.isContentEditable = true;
  const dirty = new Set();
  collectLeafBlocks(p, dirty);
  assert.strictEqual(dirty.size, 0);
});

test('容器里混有 aria-hidden 段落时只收可翻的那部分', () => {
  const ok = mk('p');
  const hidden = mk('p');
  const section = mk('section', [hidden], { 'aria-hidden': 'true' });
  const wrap = mk('div', [ok, section]);
  const dirty = new Set();
  collectLeafBlocks(wrap, dirty);
  assert.deepStrictEqual([...dirty], [ok]);
});

/* ---------- 数量上限 ---------- */

test('达到上限后不再收集（容器里有大量段落）', () => {
  const ps = [];
  for (let i = 0; i < 10; i++) ps.push(mk('p'));
  const div = mk('div', ps);
  const dirty = new Set();
  collectLeafBlocks(div, dirty, 3);
  assert.strictEqual(dirty.size, 3, '上限必须生效，否则一次插入就能撑爆脏集合');
});

test('单个叶子块也遵守上限', () => {
  const p = mk('p');
  const dirty = new Set([mk('p'), mk('p')]);
  collectLeafBlocks(p, dirty, 2);
  assert.strictEqual(dirty.size, 2, '集合已满时直接入参不能再加');
});

test('行内回溯分支同样遵守上限', () => {
  const span = mk('span');
  mk('p', [span]); // 建立「span 属于某个 p」的关系
  const dirty = new Set([mk('p'), mk('p')]);
  collectLeafBlocks(span, dirty, 2);
  assert.strictEqual(dirty.size, 2);
  assert.strictEqual(dirty.has(span.parentElement), false, '集合已满时不能再把段落塞进去');
});
