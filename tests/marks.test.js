/* 译文落地（marks.js）：三种展示模式的 DOM 契约 —— 最小 DOM 桩，不引入依赖 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadShared } = require('./helpers');

loadShared('content/marks.js');
const { applyTranslation, applyStyleTo } = globalThis.LF_MARKS;

/**
 * 极简 Element 桩：只实现 marks.js 用到的 API。
 * 宁可桩小、断言少，也不要引 jsdom 把「测的是桩」当成「测的是浏览器」。
 */
function createEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    childNodes: [],
    parentNode: null,
    dataset: {},
    attributes: {},
    textContent: '',
    style: {
      _p: {},
      set color(v) { this._p.color = v; },
      get color() { return this._p.color; },
      set fontSize(v) { this._p.fontSize = v; },
      get fontSize() { return this._p.fontSize; },
      removeProperty(k) { delete this._p[k]; }
    },
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      contains(c) { return this._s.has(c); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); }
    },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return this.attributes[k]; },
    removeAttribute(k) { delete this.attributes[k]; },
    appendChild(node) {
      if (node.parentNode) node.parentNode.removeChild(node);
      node.parentNode = el;
      el.childNodes.push(node);
      return node;
    },
    removeChild(node) {
      const i = el.childNodes.indexOf(node);
      if (i >= 0) el.childNodes.splice(i, 1);
      node.parentNode = null;
      return node;
    },
    get firstChild() { return el.childNodes[0] || null; },
    get nextElementSibling() {
      if (!el.parentNode) return null;
      const arr = el.parentNode.childNodes;
      return arr[arr.indexOf(el) + 1] || null;
    },
    after(node) {
      const arr = el.parentNode.childNodes;
      const i = arr.indexOf(el);
      if (node.parentNode) node.parentNode.removeChild(node);
      node.parentNode = el.parentNode;
      arr.splice(i + 1, 0, node);
    },
    querySelector(sel) {
      if (sel === ':scope > lf-original') return el.childNodes.find((c) => c.tagName === 'LF-ORIGINAL') || null;
      if (sel === ':scope > lf-text') return el.childNodes.find((c) => c.tagName === 'LF-TEXT') || null;
      return null;
    }
  };
  // 真实 DOM 里 className 与 classList 是同一份数据，桩必须保持同步
  let classStr = '';
  Object.defineProperty(el, 'className', {
    get() { return classStr; },
    set(v) {
      classStr = String(v || '');
      el.classList._s = new Set(classStr.split(/\s+/).filter(Boolean));
    }
  });
  return el;
}

/** 造一个「父容器 + 目标块（含一段原文）」 */
function makeBlock() {
  globalThis.document = { createElement: (t) => createEl(t) };
  globalThis.requestAnimationFrame = (fn) => { fn(); return 0; };
  const parent = createEl('div');
  const block = createEl('p');
  block.appendChild(createEl('span'));
  block.textContent = 'Hello world';
  parent.appendChild(block);
  return { parent, block };
}

const SETTINGS = { displayMode: 'bilingual', style: { fontSize: 95, showBadge: true } };

test('双语模式：块后插入 lf-translation，并标记已翻译', () => {
  const { parent, block } = makeBlock();
  applyTranslation(block, '你好，世界', SETTINGS);

  assert.strictEqual(block.dataset.lfDone, '1');
  assert.strictEqual(parent.childNodes.length, 2, '应在块后插入一条译文');
  const el = parent.childNodes[1];
  assert.strictEqual(el.tagName, 'LF-TRANSLATION');
  assert.strictEqual(el.textContent, '你好，世界');
  assert.strictEqual(el.getAttribute('data-lf-skip'), '1');
  assert.ok(el.classList.contains('lf-in'), '应播放进入动画');
  assert.ok(el.classList.contains('lf-translation'));
});

test('双语模式：已有译文时不重复插入', () => {
  const { parent, block } = makeBlock();
  applyTranslation(block, '第一次', SETTINGS);
  applyTranslation(block, '第二次', SETTINGS);
  assert.strictEqual(parent.childNodes.length, 2);
  assert.strictEqual(parent.childNodes[1].textContent, '第一次');
});

test('双语模式：翻译失败插占位并标红', () => {
  const { parent, block } = makeBlock();
  applyTranslation(block, null, SETTINGS);
  const el = parent.childNodes[1];
  assert.match(el.textContent, /翻译失败/);
  assert.ok(el.classList.contains('lf-error'));
});

test('替换模式：原文收进 lf-original，译文放 lf-text，可重复调用不叠加', () => {
  const { block } = makeBlock();
  const settings = { displayMode: 'replace', style: { fontSize: 95 } };
  applyTranslation(block, '你好', settings);

  assert.ok(block.classList.contains('lf-replaced'));
  const holder = block.querySelector(':scope > lf-original');
  const text = block.querySelector(':scope > lf-text');
  assert.ok(holder && text, '应生成 lf-original / lf-text');
  assert.strictEqual(holder.childNodes.length, 1, '原 span 应被收进 holder');
  assert.strictEqual(holder.getAttribute('data-lf-skip'), '1');
  assert.strictEqual(text.textContent, '你好');

  applyTranslation(block, '你好（更新）', settings);
  assert.strictEqual(block.querySelector(':scope > lf-text').textContent, '你好', '已存在时不再插入');
});

test('悬停模式：只挂 data 属性与 class，不改 DOM 结构', () => {
  const { parent, block } = makeBlock();
  applyTranslation(block, '译文', { displayMode: 'hover', style: {} });
  assert.strictEqual(block.dataset.lfHoverText, '译文');
  assert.ok(block.classList.contains('lf-hoverable'));
  assert.strictEqual(parent.childNodes.length, 1, '不应插入任何节点');
});

test('applyStyleTo：颜色 / 字号 / 徽标跟随设置', () => {
  const el = createEl('lf-translation');
  applyStyleTo(el, { style: { color: '#6a72ff', fontSize: 120, showBadge: false } });
  assert.strictEqual(el.style.color, '#6a72ff');
  assert.strictEqual(el.style.fontSize, '1.2em');
  assert.strictEqual(el.getAttribute('data-badge'), undefined);

  applyStyleTo(el, { style: { showBadge: true } });
  assert.strictEqual(el.style.color, undefined, '关掉颜色后应移除内联色');
  assert.strictEqual(el.style.fontSize, '0.95em', '缺省字号 95%');
  assert.strictEqual(el.getAttribute('data-badge'), '1');
});
