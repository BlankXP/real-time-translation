/*
 * BPFlow — DOM 文本块扫描（内容脚本专用，无业务状态）
 * 职责：把页面切成「可翻译的叶子块」、把新增子树折算成叶子块。
 *
 * 为什么要单独一层：扫描规则（哪些标签跳过、哪一层算块、可见性过滤）是整页翻译与
 * 增量翻译共用的，且改动风险高；独立出来便于对照阅读，也让 content.js 只专注流程。
 * 依赖：document / NodeFilter / getComputedStyle（内容脚本环境）。
 */
(function (g) {
  'use strict';

  /** 这些标签内的文本一律不翻 */
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'KBD', 'SAMP', 'VAR',
    'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'BUTTON', 'SVG', 'CANVAS',
    'IFRAME', 'AUDIO', 'VIDEO', 'IMG', 'META', 'LINK', 'TITLE', 'HEAD',
    'OBJECT', 'TEMPLATE', 'EMBED', 'MAP', 'AREA'
  ]);

  /** 可作为「块」的标签 */
  const BLOCK_TAGS = new Set([
    'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TD', 'TH', 'BLOCKQUOTE',
    'FIGCAPTION', 'DD', 'DT', 'SUMMARY', 'DETAILS', 'FIGURE', 'DIV',
    'SECTION', 'ARTICLE', 'ASIDE', 'MAIN'
  ]);

  const BLOCK_SELECTOR = 'p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote,figcaption,dd,dt,summary,details,figure,div,section,article,aside,main';

  /** 本扩展自己注入的节点，以及站点字幕容器 —— 都不参与翻译 */
  const SKIP_SELECTOR = '[data-lf-skip],lf-translation,lf-original,lf-text,[data-lf-done],'
    + '#lf-ui-host,#lf-video-host,.ytp-caption-window-container,.bpx-player-subtitle-wrap';

  /** 单个块的最大字符数：超长块跳过，防止请求过大 */
  const MAX_BLOCK_CHARS = 3000;

  function textOf(el) {
    return String((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
  }

  function isSkipped(el) {
    if (!el || !el.closest) return false;
    return !!el.closest(SKIP_SELECTOR);
  }

  /**
   * 这个元素是否应该参与翻译。
   * 整页扫描（getUnits）与增量补翻（translateDirty）必须共用同一套判定：
   * 否则会出现「整页跳过、增量却翻」的不一致（典型是 aria-hidden 区域与可编辑区）。
   */
  function isTranslatableBlock(el) {
    if (!el) return false;
    if (SKIP_TAGS.has(el.tagName)) return false;
    if (isSkipped(el)) return false;
    if (el.isContentEditable) return false;
    if (el.closest && el.closest('button,[aria-hidden="true"]')) return false;
    return true;
  }

  /**
   * 找到文本节点所属的「叶子块」（含块级标签且内部没有其它块级元素）。
   * @param {Element} el
   * @param {?Map} cache 单次同步扫描内的记忆：同一块下成百上千个文本节点不必重复向上找
   */
  function findBlockAncestor(el, cache) {
    if (!el) return null;
    if (cache && cache.has(el)) return cache.get(el);
    let cur = el;
    let found = null;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      if (BLOCK_TAGS.has(cur.tagName) && !cur.querySelector(BLOCK_SELECTOR)) { found = cur; break; }
      cur = cur.parentElement;
    }
    if (cache) cache.set(el, found);
    return found;
  }

  /**
   * 块是否可用（可见 + 长度合格）。
   * 先查 getClientRects 再查 computedStyle：被 display:none 祖先隐藏的块两者都会判否，
   * 但前者便宜得多，能省掉大量样式解析。
   */
  function isUsableBlock(b) {
    try {
      if (!b.isConnected) return false;
      if (!b.getClientRects().length) return false;
      const st = getComputedStyle(b);
      if (st.display === 'none' || st.visibility === 'hidden') return false;
      return textOf(b).length <= MAX_BLOCK_CHARS;
    } catch (e) { return false; } // 节点可能已脱离文档
  }

  /**
   * 扫描可翻译块。
   * @param {{minLen?: number, limit?: number, root?: Element}} [opts]
   *   minLen 最小文本长度；limit 收够这么多「可见」块就停止遍历（大页面不必白扫整棵 DOM）；
   *   root 只扫这个子树
   * @returns {Element[]} 文档顺序的叶子块
   */
  function getUnits(opts) {
    const o = opts || {};
    const minLen = Math.max(1, Number(o.minLen) || 2);
    const limit = Math.max(0, Math.round(Number(o.limit) || 0));
    const scope = o.root || document.body;
    if (!scope) return [];

    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const val = node.nodeValue;
        if (!val || val.trim().length < minLen) return NodeFilter.FILTER_REJECT;
        const el = node.parentElement;
        if (!el || !isTranslatableBlock(el)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const memo = new Map();   // 只在本次扫描内有效，DOM 同步遍历期间不会变
    const seen = new Set();   // 已考察过的块（含不可见的），避免重复判可见性
    const out = [];
    /*
     * 边遍历边过滤，而不是「先收 limit*2+8 个块、再统一过滤」。
     * 旧写法在不可见块占比高时（折叠面板、隐藏 tab、aria-hidden 骨架屏）收集阶段就被
     * 不可见块占满名额 → 结果永远达不到 limit；而文档顺序每次都一样，于是每次重翻
     * 漏掉的都是同一批块（不是运气问题，是稳定的漏翻）。
     * 这里改为给「考察数」设上限，兼顾大页面的扫描成本。
     */
    const ceiling = limit ? limit * 4 + 64 : 0;
    let examined = 0;
    let node;
    while ((node = walker.nextNode())) {
      const block = findBlockAncestor(node.parentElement, memo);
      if (!block || seen.has(block)) continue;
      seen.add(block);
      examined++;
      if (isUsableBlock(block)) {
        out.push(block);
        if (limit && out.length >= limit) break;
      }
      if (ceiling && examined >= ceiling) break;
    }
    return out;
  }

  /**
   * 把新增子树里的叶子块收集进 out（整块容器下可能有多段）。
   * @param {Element} node 新增节点
   * @param {Set<Element>} out 目标集合
   * @param {number} [cap] 集合上限：所有分支都必须遵守，否则一次批量插入就能撑爆
   */
  function collectLeafBlocks(node, out, cap) {
    if (!node || !node.matches || !out) return;

    /** 统一入口：查上限 + 跳过规则，返回是否成功加入 */
    const push = (el) => {
      if (!el || (cap && out.size >= cap)) return false;
      if (!isTranslatableBlock(el)) return false;
      out.add(el);
      return true;
    };

    if (node.matches(BLOCK_SELECTOR) && !node.querySelector(BLOCK_SELECTOR)) {
      push(node);
      return;
    }
    const list = node.querySelectorAll(BLOCK_SELECTOR);
    if (!list.length) {
      // 新增的是行内元素（span / em / a…）：要翻的是它所在的段落。
      // 漏了这一步，SPA 往已有 <p> 里插一段文本就永远不会被增量翻译扫到。
      push(findBlockAncestor(node));
      return;
    }
    for (let i = 0; i < list.length; i++) {
      if (list[i].querySelector(BLOCK_SELECTOR)) continue;
      if (cap && out.size >= cap) return; // 到上限就收工，别把整棵子树走完
      push(list[i]);
    }
  }

  g.LF_SCAN = {
    BLOCK_SELECTOR,
    MAX_BLOCK_CHARS,
    textOf,
    isSkipped,
    isTranslatableBlock,
    isUsableBlock,
    findBlockAncestor,
    getUnits,
    collectLeafBlocks
  };
})(globalThis);
