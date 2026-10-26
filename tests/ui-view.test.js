/* 界面计算（ui-view.js）：定位几何 + 语言下拉构建 —— 纯函数，无需 DOM */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadShared } = require('./helpers');

loadShared('shared/dom-utils.js'); // ui-view 的 esc 复用这里的实现
loadShared('content/ui-view.js');
const { clampBall, panelPosition, tipPosition, selBarPosition, targetOptions, esc, BALL_SIZE, PANEL_WIDTH } = globalThis.LF_VIEW;

const VIEW = { w: 1280, h: 800 };

test('尺寸常量与样式表一致（改了 css 记得同步）', () => {
  assert.strictEqual(BALL_SIZE, 46);
  assert.strictEqual(PANEL_WIDTH, 292);
});

test('悬浮球夹取：视口内不动，越界贴边', () => {
  assert.deepStrictEqual(clampBall({ x: 100, y: 200 }, VIEW), { x: 100, y: 200 });
  assert.deepStrictEqual(clampBall({ x: -50, y: -50 }, VIEW), { x: 6, y: 6 });
  assert.deepStrictEqual(clampBall({ x: 9999, y: 9999 }, VIEW), { x: 1280 - 46 - 6, y: 800 - 46 - 6 });
});

test('面板定位：默认在球左侧展开', () => {
  const pos = panelPosition({ x: 1000, y: 300 }, { w: 292, h: 380 }, VIEW);
  assert.deepStrictEqual(pos, { x: 1000 - 292 + 46 + 8, y: 300 });
});

test('面板定位：左边放不下翻到球右侧', () => {
  const pos = panelPosition({ x: 10, y: 300 }, { w: 292, h: 380 }, VIEW);
  assert.strictEqual(pos.x, 10 + 46 + 8);
  assert.strictEqual(pos.y, 300);
});

test('面板定位：纵向不越界（下沿 / 上沿）', () => {
  assert.strictEqual(panelPosition({ x: 1000, y: 700 }, { w: 292, h: 380 }, VIEW).y, 800 - 380 - 10);
  assert.strictEqual(panelPosition({ x: 1000, y: 5 }, { w: 292, h: 380 }, VIEW).y, 10);
});

test('Tooltip：优先上方，放不下翻到下方，横向夹边', () => {
  assert.deepStrictEqual(
    tipPosition({ left: 600, top: 300, width: 100, height: 20 }, { w: 200, h: 60 }, VIEW),
    { x: 550, y: 230 }
  );
  assert.strictEqual(
    tipPosition({ left: 600, top: 5, width: 100, height: 20 }, { w: 200, h: 60 }, VIEW).y,
    5 + 20 + 10
  );
  assert.strictEqual(
    tipPosition({ left: 1270, top: 300, width: 20, height: 20 }, { w: 200, h: 60 }, VIEW).x,
    1280 - 200 - 8
  );
});

test('划词浮条：贴选区上方，越界翻转并夹边', () => {
  assert.deepStrictEqual(
    selBarPosition({ left: 600, top: 300, width: 100, height: 20 }, { w: 120, h: 36 }, VIEW),
    { x: 590, y: 256 }
  );
  assert.strictEqual(
    selBarPosition({ left: 600, top: 10, width: 100, height: 20 }, { w: 120, h: 36 }, VIEW).y,
    38
  );
  // 浮条比视口还宽：至少不能出左边界
  assert.strictEqual(
    selBarPosition({ left: 600, top: 300, width: 0, height: 0 }, { w: 2000, h: 36 }, VIEW).x,
    8
  );
});

test('语言下拉：常用在前 + 分隔线 + 其余', () => {
  const all = [
    { code: 'auto', name: '自动检测' },
    { code: 'zh-CN', name: '中文（简体）' },
    { code: 'en', name: 'English' },
    { code: 'ja', name: '日本語' }
  ];
  const html = targetOptions(all, ['zh-CN', 'en'], 'zh-CN');
  assert.strictEqual(html, [
    '<option value="zh-CN">中文（简体）</option>',
    '<option value="en">English</option>',
    '<option disabled value="__sep__">────────</option>',
    '<option value="ja">日本語</option>'
  ].join(''));
});

test('语言下拉：当前语言不在常用里时置顶，且不重复', () => {
  const all = [
    { code: 'auto', name: '自动' },
    { code: 'zh-CN', name: '中文' },
    { code: 'ja', name: '日本語' }
  ];
  const html = targetOptions(all, ['zh-CN'], 'ja');
  assert.ok(html.startsWith('<option value="ja">日本語</option>'), html);
  assert.strictEqual((html.match(/value="ja"/g) || []).length, 1, '不能重复出现');
  assert.ok(!html.includes('__sep__'), '全部语言都进了常用，不该有分隔线');
});

test('语言下拉：auto 永不出现，无效常用项被丢弃', () => {
  const all = [{ code: 'auto', name: '自动' }, { code: 'en', name: 'English' }];
  const html = targetOptions(all, ['auto', 'nope', 'en'], 'en');
  assert.ok(!html.includes('value="auto"'));
  assert.ok(!html.includes('nope'));
  assert.ok(html.includes('value="en"'));
});

test('语言下拉：自定义语言回落到 label，并对 HTML 转义', () => {
  const all = [
    { code: 'auto', name: '自动' },
    { code: 'xx', name: 'A & B <x>' },
    { code: 'km', label: 'Khmer' }
  ];
  const html = targetOptions(all, [], 'xx');
  assert.ok(html.includes('A &amp; B &lt;x&gt;'), html);
  assert.ok(html.includes('<option value="km">Khmer</option>'), html);
  assert.strictEqual(esc('"\''), '&quot;&#39;');
});
