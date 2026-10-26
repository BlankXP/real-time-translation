/*
 * BPFlow — 内容脚本的界面计算（纯函数，不碰 DOM）
 * 悬浮球夹取、面板/提示/划词浮条定位、目标语言下拉构建。
 *
 * 为什么单独拎出来：这些是「一串 Math.max/Math.min + 偏移量」的几何运算，
 * 写错一个符号只会表现为「面板跑到屏幕外」，很难靠读代码发现；抽成纯函数才能断言。
 * 约定：所有尺寸/坐标都是 CSS 像素，viewport 由调用方传入（不读 window）。
 */
(function (g) {
  'use strict';

  /** 悬浮球直径（与 ui-css 里的 #lf-ball 尺寸保持一致） */
  const BALL_SIZE = 46;
  /** 快捷面板宽度（与 ui-css 里的 #lf-panel 保持一致） */
  const PANEL_WIDTH = 292;

  /** HTML 转义只有一份实现（shared/dom-utils.js），避免各入口各修一版 */
  const esc = g.LF_DOM.esc;

  /** 悬浮球夹到视口内 */
  function clampBall(pos, view, margin) {
    const m = margin == null ? 6 : margin;
    return {
      x: Math.max(m, Math.min(view.w - BALL_SIZE - m, pos.x)),
      y: Math.max(m, Math.min(view.h - BALL_SIZE - m, pos.y))
    };
  }

  /**
   * 面板定位：默认在球左侧展开；左边放不下就翻到球右侧；纵向不越界。
   * @param {{x:number,y:number}} ball 球左上角
   * @param {{w:number,h:number}} panel 面板尺寸
   * @param {{w:number,h:number}} view 视口尺寸
   */
  function panelPosition(ball, panel, view) {
    const margin = 10;
    const gap = 8;
    let x = ball.x - panel.w + BALL_SIZE + gap;
    if (x < margin) x = Math.min(ball.x + BALL_SIZE + gap, view.w - panel.w - margin);
    let y = ball.y;
    if (y + panel.h > view.h - margin) y = view.h - panel.h - margin;
    if (y < margin) y = margin;
    return { x, y };
  }

  /** Tooltip：优先在锚点上方，放不下翻到下方，横向夹在视口内 */
  function tipPosition(rect, tip, view) {
    const margin = 8;
    const gap = 10;
    let x = rect.left + (rect.width || 0) / 2 - tip.w / 2;
    let y = rect.top - tip.h - gap;
    if (y < margin) y = rect.top + (rect.height || 0) + gap;
    x = Math.max(margin, Math.min(view.w - tip.w - margin, x));
    return { x, y };
  }

  /** 划词浮条：贴着选区上方，放不下翻到下方，横向夹在视口内 */
  function selBarPosition(rect, bar, view) {
    const margin = 8;
    let x = rect.left + (rect.width || 0) / 2 - bar.w / 2;
    let y = rect.top - bar.h - margin;
    if (y < margin) y = rect.top + (rect.height || 0) + margin;
    x = Math.max(margin, Math.min(view.w - bar.w - margin, x));
    if (y < margin) y = margin;
    return { x, y };
  }

  /**
   * 目标语言下拉：常用语言在前、分隔线、其余语言在后。
   * @param {Array<{code:string,name?:string,label?:string}>} all 全部语言
   * @param {string[]} quickLangs 常用语言 code
   * @param {string} current 当前目标语言（不在常用里时置顶）
   */
  function targetOptions(all, quickLangs, current) {
    const langs = Array.isArray(all) ? all : [];
    const byCode = new Map(langs.map((l) => [l.code, l]));
    const quick = (Array.isArray(quickLangs) ? quickLangs : [])
      .filter((c) => c !== 'auto' && byCode.has(c));
    if (current && current !== 'auto' && quick.indexOf(current) === -1) quick.unshift(current);

    const opts = [];
    quick.forEach((c) => {
      const l = byCode.get(c);
      opts.push('<option value="' + esc(c) + '">' + esc(l ? l.name : c) + '</option>');
    });
    const rest = langs.filter((l) => l.code !== 'auto' && quick.indexOf(l.code) === -1);
    if (rest.length) {
      opts.push('<option disabled value="__sep__">────────</option>');
      rest.forEach((l) => opts.push('<option value="' + esc(l.code) + '">' + esc(l.name || l.label) + '</option>'));
    }
    return opts.join('');
  }

  g.LF_VIEW = {
    BALL_SIZE,
    PANEL_WIDTH,
    esc,
    clampBall,
    panelPosition,
    tipPosition,
    selBarPosition,
    targetOptions
  };
})(globalThis);
