/*
 * BPFlow — 内容脚本
 * 职责：DOM 文本块扫描 / 翻译应用（双语·替换·悬停）/ 悬浮球与快捷面板（Shadow DOM 隔离）
 *       划词翻译 / 增量翻译（MutationObserver）/ 站点规则
 */
/* global LF, LF_DEFAULTS, LF_MERGE */
(() => {
  'use strict';
  if (!window.chrome || !chrome.runtime || !chrome.runtime.id) return;
  if (window.__LF_CONTENT__) return;
  window.__LF_CONTENT__ = true;

  /* ============================== 状态 ============================== */

  const state = {
    settings: null,
    on: false,          // 当前页翻译是否开启
    translating: false,
    token: 0,           // 取消令牌
    ballPos: null,      // {x,y} 悬浮球左上角
    panelOpen: false,
    live: false         // 直播语音翻译进行中
  };

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'KBD', 'SAMP', 'VAR',
    'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'BUTTON', 'SVG', 'CANVAS',
    'IFRAME', 'AUDIO', 'VIDEO', 'IMG', 'META', 'LINK', 'TITLE', 'HEAD',
    'OBJECT', 'TEMPLATE', 'EMBED', 'MAP', 'AREA'
  ]);

  const BLOCK_TAGS = new Set([
    'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TD', 'TH', 'BLOCKQUOTE',
    'FIGCAPTION', 'DD', 'DT', 'SUMMARY', 'DETAILS', 'FIGURE', 'DIV',
    'SECTION', 'ARTICLE', 'ASIDE', 'MAIN'
  ]);
  const BLOCK_SELECTOR = 'p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote,figcaption,dd,dt,summary,details,figure,div,section,article,aside,main';

  /* ============================== 工具 ============================== */

  const $ = (sel, root) => (root || document).querySelector(sel);
  const normText = (el) => String(el.textContent || '').replace(/\s+/g, ' ').trim();

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => { void chrome.runtime.lastError; resolve(res || null); });
      } catch (e) { resolve(null); }
    });
  }

  function chunk(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  }

  /* ============================== 设置 ============================== */

  async function ensureSettings() {
    const o = await chrome.storage.sync.get('settings');
    state.settings = LF_MERGE(LF_DEFAULTS, (o && o.settings) || {});
    syncPanelFromSettings();
    return state.settings;
  }

  async function updateSettings(patch) {
    state.settings = LF_MERGE(state.settings || LF_DEFAULTS, patch);
    await chrome.storage.sync.set({ settings: state.settings });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.settings) return;
    const oldS = changes.settings.oldValue || {};
    const newS = changes.settings.newValue || {};
    state.settings = LF_MERGE(LF_DEFAULTS, newS);
    syncPanelFromSettings();

    const langChanged = oldS.targetLang !== newS.targetLang || oldS.sourceLang !== newS.sourceLang;
    const modeChanged = oldS.displayMode !== newS.displayMode;
    const styleChanged = JSON.stringify(oldS.style || {}) !== JSON.stringify(newS.style || {});
    if (styleChanged) reapplyStyles();
    if (state.on && (langChanged || modeChanged)) retranslate();
  });

  /* ============================== DOM 扫描 ============================== */

  function findBlockAncestor(el) {
    let cur = el;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      if (BLOCK_TAGS.has(cur.tagName) && !cur.querySelector(BLOCK_SELECTOR)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  function getUnits() {
    const s = state.settings || {};
    const minLen = Math.max(1, (s.advanced && s.advanced.minTextLength) != null ? s.advanced.minTextLength : 2);
    const body = document.body;
    if (!body) return [];

    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const val = node.nodeValue;
        if (!val || val.trim().length < minLen) return NodeFilter.FILTER_REJECT;
        const el = node.parentElement;
        if (!el) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
        if (el.closest('[data-lf-skip],lf-translation,lf-original,lf-text,[data-lf-done],#lf-ui-host,#lf-video-host,.ytp-caption-window-container,.bpx-player-subtitle-wrap')) {
          return NodeFilter.FILTER_REJECT;
        }
        if (el.isContentEditable) return NodeFilter.FILTER_REJECT;
        if (el.closest('button,[aria-hidden="true"]')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const blocks = new Map(); // 保持文档顺序
    let node;
    while ((node = walker.nextNode())) {
      const block = findBlockAncestor(node.parentElement);
      if (block && !blocks.has(block)) blocks.set(block, true);
    }

    const out = [];
    for (const b of blocks.keys()) {
      try {
        const st = getComputedStyle(b);
        if (st.display === 'none' || st.visibility === 'hidden') continue;
        if (!b.getClientRects().length) continue;
        if (normText(b).length > 3000) continue; // 超长块跳过，防止请求过大
        out.push(b);
      } catch (e) { /* 节点可能已脱离文档 */ }
    }
    return out;
  }

  /* ============================== 翻译应用 ============================== */

  function makeTranslationEl(text, isError) {
    const el = document.createElement('lf-translation');
    el.setAttribute('data-lf-skip', '1');
    el.className = 'lf-translation' + (isError ? ' lf-error' : '');
    applyStyleTo(el);
    el.textContent = text;
    return el;
  }

  function applyStyleTo(el) {
    const s = (state.settings && state.settings.style) || {};
    if (s.color) el.style.color = s.color; else el.style.removeProperty('color');
    el.style.fontSize = ((s.fontSize || 95) / 100) + 'em';
    if (s.showBadge) el.setAttribute('data-badge', '1');
    else el.removeAttribute('data-badge');
  }

  function reapplyStyles() {
    document.querySelectorAll('lf-translation.lf-translation').forEach(applyStyleTo);
  }

  function applyTranslation(block, translated) {
    const mode = (state.settings && state.settings.displayMode) || 'bilingual';
    block.dataset.lfDone = '1';

    if (translated == null) {
      if (mode === 'bilingual' && !block.nextElementSibling?._lf) {
        const err = makeTranslationEl('⚠ 此段翻译失败', true);
        err._lf = true;
        block.after(err);
        requestAnimationFrame(() => err.classList.add('lf-in'));
      }
      return;
    }

    if (mode === 'bilingual') {
      const next = block.nextElementSibling;
      if (next && next.tagName === 'LF-TRANSLATION') return;
      const el = makeTranslationEl(translated, false);
      block.after(el);
      requestAnimationFrame(() => el.classList.add('lf-in'));
    } else if (mode === 'replace') {
      if (!block.querySelector(':scope > lf-original')) {
        const holder = document.createElement('lf-original');
        holder.setAttribute('data-lf-skip', '1');
        while (block.firstChild) holder.appendChild(block.firstChild);
        block.appendChild(holder);
      }
      if (!block.querySelector(':scope > lf-text')) {
        const t = document.createElement('lf-text');
        t.setAttribute('data-lf-skip', '1');
        t.textContent = translated;
        block.appendChild(t);
      }
      block.classList.add('lf-replaced');
    } else { // hover
      block.dataset.lfHoverText = translated;
      block.classList.add('lf-hoverable');
    }
  }

  function restore() {
    state.token++;
    state.on = false;
    state.translating = false;
    document.querySelectorAll('lf-translation').forEach((el) => el.remove());
    document.querySelectorAll('[data-lf-done]').forEach((b) => {
      b.querySelectorAll(':scope > lf-original').forEach((h) => {
        while (h.firstChild) b.insertBefore(h.firstChild, h);
        h.remove();
      });
      b.querySelectorAll(':scope > lf-text').forEach((t) => t.remove());
      b.classList.remove('lf-replaced', 'lf-hoverable');
      delete b.dataset.lfDone;
      delete b.dataset.lfHoverText;
    });
    hideProgress(0);
    hideTooltip();
    updateBallUI();
    updatePanelState();
  }

  function retranslate() {
    if (!state.on) return;
    restore();
    state.on = true;
    translatePage();
  }

  /* ============================== 翻译主流程 ============================== */

  async function translatePage(silent) {
    const myToken = ++state.token;
    state.on = true;
    state.translating = true;
    updateBallUI();
    updatePanelState();

    await ensureSettings();
    const settings = state.settings;
    const maxUnits = (settings.advanced && settings.advanced.maxUnits) || 600;

    const units = getUnits().filter((b) => !b.dataset.lfDone);
    const limited = units.length > maxUnits;
    const list = limited ? units.slice(0, maxUnits) : units;

    const seen = new Set();
    const uniqueTexts = [];
    for (const b of list) {
      const t = normText(b);
      if (t && !seen.has(t)) { seen.add(t); uniqueTexts.push(t); }
    }

    if (!uniqueTexts.length) {
      state.translating = false;
      hideProgress(0.3);
      updateBallUI();
      updatePanelState();
      if (!silent) toast('未发现可翻译的文本');
      return;
    }

    showProgress(0.04, '正在准备翻译…');

    const resultMap = new Map();
    let done = 0;
    let anyOk = false;
    let lastError = null;
    const chunks = chunk(uniqueTexts, 16);

    for (const c of chunks) {
      if (state.token !== myToken || !state.on) return; // 已取消
      const r = await send({ type: 'lf:translate', texts: c });
      if (state.token !== myToken || !state.on) return;
      if (r && r.ok && Array.isArray(r.results)) {
        anyOk = true;
        c.forEach((t, i) => { if (r.results[i] != null) resultMap.set(t, r.results[i]); });
      } else {
        lastError = (r && r.error) || '网络错误，无法连接翻译服务';
      }
      done += c.length;
      showProgress(Math.min(0.97, 0.05 + 0.92 * (done / uniqueTexts.length)),
        '翻译中 ' + done + ' / ' + uniqueTexts.length);
    }

    for (const b of list) {
      const t = normText(b);
      if (!t) continue;
      applyTranslation(b, resultMap.has(t) ? resultMap.get(t) : null);
    }

    state.translating = false;
    hideProgress(0.5);
    updateBallUI();
    updatePanelState();

    if (!anyOk && lastError) {
      showPanelError(lastError);
      toast('翻译失败：' + lastError);
    } else if (limited) {
      showPanelError('页面内容较多，已翻译前 ' + maxUnits + ' 个文本块');
    } else if (done > 0) {
      hidePanelError();
    }

    // 翻译期间新增的内容稍后补翻（静默，无新内容时不打扰）
    setTimeout(() => { if (state.on && !state.translating && state.token === myToken) translatePage(true); }, 1500);
  }

  /* ============================== 悬停模式 / 划词翻译 ============================== */

  document.addEventListener('mouseover', (e) => {
    const s = state.settings;
    if (!s || s.displayMode !== 'hover') return;
    const el = e.target && e.target.closest ? e.target.closest('.lf-hoverable') : null;
    if (el && el.dataset.lfHoverText) showTooltip(el.dataset.lfHoverText, null, el);
    else hideTooltip();
  }, true);

  document.addEventListener('mouseout', (e) => {
    const to = e.relatedTarget;
    if (to && to.closest && to.closest('.lf-hoverable')) return;
    hideTooltip();
  }, true);

  window.addEventListener('scroll', () => hideTooltip(), { passive: true, capture: true });

  async function handleSelection() {
    const sel = window.getSelection();
    const text = sel ? String(sel).trim() : '';
    if (!sel || text.length < 2 || !sel.rangeCount) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!text || text.length < 2) return;
    showTooltip('正在翻译…', rect);
    const r = await send({ type: 'lf:translate', texts: [text.slice(0, 1500)] });
    if (r && r.ok && r.results && r.results[0] != null) showTooltip(r.results[0], rect, 10000);
    else showTooltip('⚠ ' + ((r && r.error) || '翻译失败'), rect, 5000);
  }

  /* ============================== Shadow DOM UI ============================== */

  let ui = null; // {host, root, ball, panel, ...}

  const SHADOW_CSS = `
    :host { all: initial; font-family: -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: inherit; }

    /* ---- 悬浮球 ---- */
    #lf-ball {
      position: fixed; width: 46px; height: 46px; border-radius: 50%;
      background: linear-gradient(135deg, #5b8cff 0%, #a05cff 100%);
      box-shadow: 0 6px 22px rgba(96, 112, 255, 0.45), inset 0 1px 0 rgba(255,255,255,0.25);
      cursor: pointer; user-select: none; -webkit-user-select: none;
      display: flex; align-items: center; justify-content: center;
      z-index: 2147483600; transition: transform .18s ease, box-shadow .18s ease;
      touch-action: none;
    }
    #lf-ball:hover { transform: scale(1.08); box-shadow: 0 8px 28px rgba(96,112,255,.6), inset 0 1px 0 rgba(255,255,255,.25); }
    #lf-ball.dragging { transition: none; transform: scale(1.02); cursor: grabbing; }
    #lf-ball svg { width: 24px; height: 24px; pointer-events: none; }
    #lf-ball .dot {
      position: absolute; right: 1px; top: 1px; width: 11px; height: 11px; border-radius: 50%;
      border: 2px solid #fff; background: #c3c9d9; pointer-events: none;
    }
    #lf-ball.on .dot { background: #34d399; }
    #lf-ball.working .dot { background: #fbbf24; animation: lf-pulse 1s ease infinite; }
    #lf-ball.working { animation: lf-ring 1.6s ease infinite; }
    @keyframes lf-pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
    @keyframes lf-ring {
      0% { box-shadow: 0 0 0 0 rgba(96,112,255,.55), 0 6px 22px rgba(96,112,255,.45); }
      70% { box-shadow: 0 0 0 14px rgba(96,112,255,0), 0 6px 22px rgba(96,112,255,.45); }
      100% { box-shadow: 0 0 0 0 rgba(96,112,255,0), 0 6px 22px rgba(96,112,255,.45); }
    }

    /* ---- 面板 ---- */
    #lf-panel {
      position: fixed; width: 292px;
      background: rgba(18, 21, 31, 0.96);
      backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
      border: 1px solid rgba(255,255,255,0.09);
      border-radius: 16px;
      box-shadow: 0 18px 60px rgba(0,0,0,0.5);
      color: #e8eaf2; font-size: 13px; line-height: 1.5;
      z-index: 2147483601; overflow: hidden;
      animation: lf-pop .22s cubic-bezier(.2,.9,.3,1.2) both;
    }
    @keyframes lf-pop { from { opacity: 0; transform: translateY(8px) scale(.97); } to { opacity: 1; transform: none; } }
    #lf-panel.hidden { display: none; }

    .head {
      display: flex; align-items: center; gap: 8px;
      padding: 14px 14px 10px;
    }
    .brand { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 14px; letter-spacing: .02em; flex: 1; }
    .brand .logo {
      width: 26px; height: 26px; border-radius: 8px;
      background: linear-gradient(135deg,#5b8cff,#a05cff);
      color: #fff; display: flex; align-items: center; justify-content: center;
      font-size: 13px; font-weight: 700;
    }
    .icon-btn {
      width: 26px; height: 26px; border: none; border-radius: 7px; cursor: pointer;
      background: rgba(255,255,255,0.06); color: #a8b0c4;
      display: flex; align-items: center; justify-content: center; font-size: 14px;
      transition: background .15s;
    }
    .icon-btn:hover { background: rgba(255,255,255,0.12); color: #fff; }

    #lf-panel .body { padding: 2px 14px 14px; display: flex; flex-direction: column; gap: 12px; }

    .field { display: flex; flex-direction: column; gap: 6px; }
    .field > .lbl { font-size: 11px; color: #8a92a8; letter-spacing: .06em; }

    select {
      appearance: none; -webkit-appearance: none;
      background: rgba(255,255,255,0.05) url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23a8b0c4' stroke-width='1.6' fill='none' stroke-linecap='round'/%3E%3C/svg%3E") no-repeat right 10px center;
      border: 1px solid rgba(255,255,255,0.1); border-radius: 9px;
      color: #e8eaf2; padding: 8px 30px 8px 11px; font-size: 13px; cursor: pointer; outline: none;
      width: 100%;
    }
    select:hover { border-color: rgba(255,255,255,0.2); }
    select option { background: #161a26; color: #e8eaf2; }

    .seg { display: flex; background: rgba(255,255,255,0.05); border-radius: 9px; padding: 3px; gap: 3px; }
    .seg button {
      flex: 1; border: none; background: transparent; color: #a8b0c4;
      padding: 6px 0; border-radius: 7px; cursor: pointer; font-size: 12px;
      transition: all .15s;
    }
    .seg button:hover { color: #e8eaf2; }
    .seg button.active {
      background: linear-gradient(135deg, rgba(91,140,255,.9), rgba(160,92,255,.9));
      color: #fff; box-shadow: 0 2px 8px rgba(96,112,255,.35);
    }

    .actions { display: flex; gap: 8px; }
    .btn {
      border: none; border-radius: 10px; padding: 9px 12px; font-size: 13px; font-weight: 500;
      cursor: pointer; transition: all .15s; flex: 1;
    }
    .btn.primary {
      background: linear-gradient(135deg, #5b8cff, #a05cff); color: #fff;
      box-shadow: 0 4px 14px rgba(96,112,255,.35);
    }
    .btn.primary:hover { filter: brightness(1.1); }
    .btn.primary:disabled { opacity: .6; cursor: default; filter: none; }
    .btn.ghost {
      background: rgba(255,255,255,0.06); color: #c9cfdf; border: 1px solid rgba(255,255,255,0.08);
    }
    .btn.ghost:hover { background: rgba(255,255,255,0.12); }
    .btn.ghost.active {
      background: linear-gradient(135deg, rgba(91,140,255,.85), rgba(160,92,255,.85));
      color: #fff; border-color: transparent;
      box-shadow: 0 3px 10px rgba(96,112,255,.3);
    }

    .site-rule {
      display: flex; align-items: center; gap: 8px; font-size: 12px; color: #a8b0c4;
      background: rgba(255,255,255,0.03); border-radius: 9px; padding: 8px 10px; cursor: pointer;
    }
    .site-rule input { accent-color: #6c7cff; width: 14px; height: 14px; cursor: pointer; }

    .foot {
      display: flex; justify-content: space-between; align-items: center;
      padding: 9px 14px; border-top: 1px solid rgba(255,255,255,0.06);
      font-size: 11px; color: #6b7387;
    }
    .foot .engine { color: #8a92a8; }
    .foot .engine b { color: #aab3ff; font-weight: 500; }

    #lf-panel .msg {
      margin: 0 14px 10px; padding: 8px 10px; border-radius: 9px; font-size: 12px;
      background: rgba(248,113,113,0.1); color: #fca5a5; border: 1px solid rgba(248,113,113,0.2);
      display: flex; gap: 6px; align-items: flex-start;
    }
    #lf-panel .msg.hidden { display: none; }

    /* ---- 进度条 ---- */
    #lf-progress {
      position: fixed; left: 0; top: 0; right: 0; height: 3px; z-index: 2147483602;
      background: rgba(99,102,241,0.15); transition: opacity .4s;
    }
    #lf-progress.hidden { opacity: 0; pointer-events: none; }
    #lf-progress .bar {
      height: 100%; width: 0;
      background: linear-gradient(90deg, #5b8cff, #a05cff, #5b8cff);
      background-size: 200% 100%;
      animation: lf-flow 1.4s linear infinite;
      border-radius: 0 2px 2px 0;
      transition: width .3s ease;
    }
    @keyframes lf-flow { from { background-position: 0 0; } to { background-position: 200% 0; } }
    #lf-progress .label {
      position: absolute; top: 9px; left: 50%; transform: translateX(-50%);
      background: rgba(18,21,31,0.92); border: 1px solid rgba(255,255,255,0.09);
      color: #c9cfdf; font-size: 11px; padding: 4px 12px; border-radius: 99px;
      backdrop-filter: blur(10px);
    }

    /* ---- Tooltip ---- */
    #lf-tip {
      position: fixed; max-width: 420px; z-index: 2147483603;
      background: rgba(18,21,31,0.97); border: 1px solid rgba(255,255,255,0.1);
      color: #e8eaf2; font-size: 13px; line-height: 1.6;
      padding: 10px 13px; border-radius: 11px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.45);
      backdrop-filter: blur(14px);
      white-space: pre-wrap; word-break: break-word;
    }
    #lf-tip.hidden { display: none; }

    /* ---- 划词浮条 ---- */
    #lf-selbar {
      position: fixed; z-index: 2147483605;
      background: rgba(18,21,31,0.97);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 12px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.5);
      backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
      padding: 6px;
      display: flex; flex-direction: column; gap: 6px;
      color: #e8eaf2; font-size: 13px;
      animation: lf-pop .16s cubic-bezier(.2,.9,.3,1.2) both;
    }
    #lf-selbar.hidden { display: none; }
    #lf-selbar .sb-row { display: flex; align-items: center; gap: 4px; }
    #lf-selbar .sb-btn {
      border: none; border-radius: 8px; cursor: pointer;
      background: rgba(255,255,255,0.06); color: #d7dcec;
      padding: 6px 12px; font-size: 13px; transition: background .15s;
      display: inline-flex; align-items: center; gap: 4px; white-space: nowrap;
    }
    #lf-selbar .sb-btn:hover { background: rgba(255,255,255,0.13); color: #fff; }
    #lf-selbar .sb-btn.primary { background: linear-gradient(135deg,#5b8cff,#a05cff); color: #fff; }
    #lf-selbar .sb-btn.primary:hover { filter: brightness(1.1); }
    #lf-selbar .sb-btn:disabled { opacity: .65; cursor: default; }
    #lf-selbar .sb-divider { width: 1px; height: 18px; background: rgba(255,255,255,0.12); margin: 0 2px; }
    #lf-selbar .sb-result {
      max-width: 380px; max-height: 280px; overflow-y: auto;
      white-space: pre-wrap; word-break: break-word; line-height: 1.55;
      padding: 6px 8px; font-size: 13px; color: #e8eaf2;
      border-top: 1px solid rgba(255,255,255,0.08);
    }
    #lf-selbar .sb-result.hidden { display: none; }
    #lf-selbar .sb-result.err { color: #fca5a5; }

    /* ---- Toast ---- */
    #lf-toast {
      position: fixed; bottom: 34px; left: 50%; transform: translateX(-50%);
      background: rgba(18,21,31,0.96); border: 1px solid rgba(255,255,255,0.1);
      color: #e8eaf2; font-size: 13px; padding: 9px 18px; border-radius: 16px;
      box-shadow: 0 10px 32px rgba(0,0,0,0.4); z-index: 2147483604;
      backdrop-filter: blur(12px);
      animation: lf-toast-in .25s ease both;
      max-width: min(80vw, 460px); white-space: normal;
      line-height: 1.5; text-align: center; word-break: break-word;
    }
    @keyframes lf-toast-in { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translate(-50%, 0); } }
    #lf-toast.hidden { display: none; }
  `;

  function buildUI() {
    const host = document.createElement('div');
    host.id = 'lf-ui-host';
    host.setAttribute('data-lf-skip', '1');
    document.documentElement.appendChild(host);

    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${SHADOW_CSS}</style>
      <div id="lf-ball" title="BPFlow 实时翻译">
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M3 6.5h9M7.5 4v2.5c0 4.5-2 8-4.5 10M5 12.5c1.5 3 4 5 7 6" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M12.5 20.5l4-11 4 11M14 16.8h5" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span class="dot"></span>
      </div>
      <div id="lf-panel" class="hidden">
        <div class="head">
          <div class="brand"><span class="logo">译</span>BPFlow</div>
          <button class="icon-btn" id="lf-btn-options" title="打开设置">⚙</button>
          <button class="icon-btn" id="lf-btn-close" title="收起">✕</button>
        </div>
        <div class="msg hidden" id="lf-panel-msg"></div>
        <div class="body">
          <div class="field">
            <span class="lbl">翻译至</span>
            <select id="lf-sel-target"></select>
          </div>
          <div class="field">
            <span class="lbl">展示方式</span>
            <div class="seg" id="lf-seg-mode">
              <button data-v="bilingual">双语对照</button>
              <button data-v="replace">替换原文</button>
              <button data-v="hover">悬停查看</button>
            </div>
          </div>
          <div class="actions">
            <button class="btn primary" id="lf-btn-go">翻译本页</button>
            <button class="btn ghost" id="lf-btn-restore">还原</button>
            <button class="btn ghost" id="lf-btn-live" title="捕获本页声音，实时转写并翻译成滚动字幕（适合直播）">直播字幕</button>
          </div>
          <label class="site-rule">
            <input type="checkbox" id="lf-chk-site">
            <span>在本站总是自动翻译</span>
          </label>
        </div>
        <div class="foot">
          <span class="engine" id="lf-engine-name">引擎：—</span>
          <span>Alt+Shift+Y</span>
        </div>
      </div>
      <div id="lf-progress" class="hidden"><div class="bar"></div><span class="label"></span></div>
      <div id="lf-tip" class="hidden"></div>
      <div id="lf-toast" class="hidden"></div>
      <div id="lf-selbar" class="hidden">
        <div class="sb-row">
          <button class="sb-btn primary" id="sb-translate">翻译</button>
          <button class="sb-btn" id="sb-copy">复制原文</button>
          <span class="sb-divider"></span>
          <button class="sb-btn icon" id="sb-close" title="关闭">✕</button>
        </div>
        <div class="sb-result hidden" id="sb-result"></div>
      </div>
    `;

    ui = {
      host, root,
      ball: root.getElementById('lf-ball'),
      panel: root.getElementById('lf-panel'),
      msg: root.getElementById('lf-panel-msg'),
      selTarget: root.getElementById('lf-sel-target'),
      segMode: root.getElementById('lf-seg-mode'),
      btnGo: root.getElementById('lf-btn-go'),
      btnRestore: root.getElementById('lf-btn-restore'),
      btnLive: root.getElementById('lf-btn-live'),
      btnOptions: root.getElementById('lf-btn-options'),
      btnClose: root.getElementById('lf-btn-close'),
      chkSite: root.getElementById('lf-chk-site'),
      engineName: root.getElementById('lf-engine-name'),
      progress: root.getElementById('lf-progress'),
      progressBar: root.querySelector('#lf-progress .bar'),
      progressLabel: root.querySelector('#lf-progress .label'),
      tip: root.getElementById('lf-tip'),
      toastEl: root.getElementById('lf-toast'),
      selbar: root.getElementById('lf-selbar'),
      selTranslate: root.getElementById('sb-translate'),
      selCopy: root.getElementById('sb-copy'),
      selClose: root.getElementById('sb-close'),
      selResult: root.getElementById('sb-result')
    };

    bindBall();
    bindPanel();
    bindSelBar();
    setBallPos(state.ballPos || defaultBallPos());
  }

  function defaultBallPos() {
    return { x: window.innerWidth - 66, y: window.innerHeight - 96 };
  }

  function setBallPos(p) {
    const size = 46;
    const x = Math.max(6, Math.min(window.innerWidth - size - 6, p.x));
    const y = Math.max(6, Math.min(window.innerHeight - size - 6, p.y));
    state.ballPos = { x, y };
    ui.ball.style.left = x + 'px';
    ui.ball.style.top = y + 'px';
  }

  function bindBall() {
    let drag = null;
    ui.ball.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const rect = ui.ball.getBoundingClientRect();
      drag = { sx: e.clientX, sy: e.clientY, ox: rect.left, oy: rect.top, moved: false };
      try { ui.ball.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
    });
    ui.ball.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      drag.moved = true;
      ui.ball.classList.add('dragging');
      setBallPos({ x: drag.ox + dx, y: drag.oy + dy });
    });
    ui.ball.addEventListener('pointerup', () => {
      if (!drag) return;
      const wasDrag = drag.moved;
      drag = null;
      ui.ball.classList.remove('dragging');
      if (!wasDrag) togglePanel();
      else chrome.storage.sync.get('lf:ball').then((o) => {
        const data = o && o['lf:ball'] ? o['lf:ball'] : {};
        data.pos = state.ballPos;
        chrome.storage.sync.set({ 'lf:ball': data });
      }).catch(() => { /* noop */ });
    });
    window.addEventListener('resize', () => { if (state.ballPos) setBallPos(state.ballPos); });
  }

  function bindPanel() {
    ui.btnClose.addEventListener('click', () => togglePanel(false));
    ui.btnOptions.addEventListener('click', () => { send({ type: 'lf:openOptions' }); });
    ui.btnGo.addEventListener('click', () => {
      if (state.translating) return;
      if (state.on) retranslate();
      else translatePage();
    });
    ui.btnRestore.addEventListener('click', () => restore());
    ui.btnLive.addEventListener('click', async () => {
      if (state.live) {
        ui.btnLive.disabled = true;
        await send({ type: 'lf:stopLive' });
        ui.btnLive.disabled = false;
        updateLiveBtn();
        return;
      }
      ui.btnLive.disabled = true;
      ui.btnLive.textContent = '启动中…';
      const r = await send({ type: 'lf:startLive' });
      ui.btnLive.disabled = false;
      if (!(r && r.ok)) {
        toast('⚠ ' + ((r && r.error) || '启动失败'));
      }
      updateLiveBtn();
    });
    ui.selTarget.addEventListener('change', async () => {
      await updateSettings({ targetLang: ui.selTarget.value });
    });
    ui.segMode.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', async () => {
        await updateSettings({ displayMode: b.dataset.v });
      });
    });
    ui.chkSite.addEventListener('change', async () => {
      const rules = Object.assign({}, (state.settings && state.settings.siteRules) || {});
      const host = location.hostname;
      rules[host] = Object.assign({}, rules[host], { auto: ui.chkSite.checked });
      await updateSettings({ siteRules: rules });
    });
  }

  /* ============================== 划词浮条 ============================== */

  function bindSelBar() {
    ui.selTranslate.addEventListener('click', translateSelection);
    ui.selCopy.addEventListener('click', copySelection);
    ui.selClose.addEventListener('click', hideSelBar);

    // 选中文字后弹出浮条（独立于整页翻译开关，受 selectionToolbar 设置控制）
    document.addEventListener('mouseup', (e) => {
      const s = state.settings;
      if (!s || !s.selectionToolbar) return;
      if (e.target && e.target.closest && e.target.closest('#lf-ui-host')) return;
      // 等待选区稳定后再读取
      setTimeout(handleTextSelection, 0);
    }, true);

    // 在浮条之外按下，收起浮条（点按钮不会触发，因按钮在浮条内）
    document.addEventListener('mousedown', (e) => {
      if (e.target && e.target.closest && e.target.closest('#lf-selbar')) return;
      hideSelBar();
    }, true);

    window.addEventListener('scroll', () => hideSelBar(), { passive: true, capture: true });
  }

  function handleTextSelection() {
    const sel = window.getSelection();
    const text = sel ? String(sel).trim() : '';
    const minLen = Math.max(1, (state.settings && state.settings.advanced && state.settings.advanced.minTextLength) || 2);
    if (!sel || !sel.rangeCount || text.length < minLen) { hideSelBar(); return; }
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0 && !rect.top)) { hideSelBar(); return; }
    state.selText = text.slice(0, 1500);
    state.selRect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    showSelBar(state.selRect);
  }

  function showSelBar(rect) {
    if (!ui) return;
    const sb = ui.selbar;
    // 复位到初始态
    ui.selTranslate.disabled = false;
    ui.selTranslate.textContent = '翻译';
    ui.selCopy.textContent = '复制原文';
    ui.selResultText = '';
    ui.selResult.textContent = '';
    ui.selResult.classList.add('hidden');
    ui.selResult.classList.remove('err');
    sb.classList.remove('hidden');

    const w = sb.offsetWidth, h = sb.offsetHeight;
    let x = rect.left + (rect.width || 0) / 2 - w / 2;
    let y = rect.top - h - 8;
    if (y < 8) y = rect.top + (rect.height || 0) + 8;
    x = Math.max(8, Math.min(window.innerWidth - w - 8, x));
    if (y < 8) y = 8;
    sb.style.left = x + 'px';
    sb.style.top = y + 'px';
  }

  function hideSelBar() {
    if (!ui) return;
    ui.selbar.classList.add('hidden');
    state.selText = '';
    state.selRect = null;
  }

  async function translateSelection() {
    const text = state.selText;
    if (!text) return;
    ui.selTranslate.disabled = true;
    ui.selTranslate.textContent = '翻译中…';
    ui.selResult.classList.add('hidden');
    ui.selResult.classList.remove('err');

    const r = await send({ type: 'lf:translate', texts: [text] });
    if (!ui) return;
    ui.selTranslate.disabled = false;
    ui.selTranslate.textContent = '翻译';

    if (r && r.ok && r.results && r.results[0] != null) {
      state.selResultText = r.results[0];
      ui.selResult.textContent = r.results[0];
      ui.selResult.classList.remove('hidden', 'err');
      ui.selCopy.textContent = '复制译文';
    } else {
      ui.selResultText = '';
      ui.selResult.textContent = '⚠ ' + ((r && r.error) || '翻译失败');
      ui.selResult.classList.remove('hidden');
      ui.selResult.classList.add('err');
    }
    // 结果展开后重新定位，避免超出视口
    if (state.selRect) showSelBar(state.selRect);
    else {
      const sel = window.getSelection();
      if (sel && sel.rangeCount) showSelBar(sel.getRangeAt(0).getBoundingClientRect());
    }
  }

  async function copySelection() {
    const text = state.selResultText || state.selText;
    if (!text) return;
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.focus(); ta.select();
        ok = document.execCommand('copy');
        ta.remove();
      } catch (_) { ok = false; }
    }
    toast(ok ? (state.selResultText ? '译文已复制' : '原文已复制') : '复制失败');
  }

  function togglePanel(force) {
    const show = typeof force === 'boolean' ? force : !state.panelOpen;
    state.panelOpen = show;
    if (show) {
      syncPanelFromSettings();
      positionPanel();
    }
    ui.panel.classList.toggle('hidden', !show);
  }

  function positionPanel() {
    const p = state.ballPos || defaultBallPos();
    const pw = 292, ph = ui.panel.offsetHeight || 380;
    let x = p.x - pw + 46 + 8; // 默认在球左侧展开
    if (x < 10) x = Math.min(p.x + 54, window.innerWidth - pw - 10);
    let y = p.y;
    if (y + ph > window.innerHeight - 10) y = window.innerHeight - ph - 10;
    if (y < 10) y = 10;
    ui.panel.style.left = x + 'px';
    ui.panel.style.top = y + 'px';
  }

  function syncPanelFromSettings() {
    if (!ui || !state.settings) return;
    const s = state.settings;

    // 语言下拉
    const all = [].concat(LF.LANGS, s.customLangs || []);
    const quick = (s.quickLangs || []).filter((c) => c !== 'auto' && all.some((l) => l.code === c));
    if (!quick.includes(s.targetLang)) quick.unshift(s.targetLang);
    const rest = all.filter((l) => l.code !== 'auto' && !quick.includes(l.code));
    const opts = [];
    quick.forEach((c) => { const l = all.find((x) => x.code === c); opts.push('<option value="' + esc(c) + '">' + esc(l ? l.name : c) + '</option>'); });
    if (rest.length) {
      opts.push('<option disabled value="__sep__">────────</option>');
      rest.forEach((l) => opts.push('<option value="' + esc(l.code) + '">' + esc(l.name || l.label) + '</option>'));
    }
    ui.selTarget.innerHTML = opts.join('');
    ui.selTarget.value = s.targetLang || 'zh-CN';

    // 模式分段
    ui.segMode.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', b.dataset.v === s.displayMode);
    });

    // 站点规则
    const rule = (s.siteRules || {})[location.hostname];
    ui.chkSite.checked = !!(rule && rule.auto);

    // 引擎名
    const prov = (s.providers || []).find((p) => p.id === s.activeProviderId);
    ui.engineName.innerHTML = '引擎：<b>' + esc(prov ? prov.name : '未配置') + '</b>';

    updatePanelState();
  }

  function updatePanelState() {
    if (!ui) return;
    ui.btnGo.textContent = state.translating ? '翻译中…' : (state.on ? '重新翻译' : '翻译本页');
    ui.btnGo.disabled = state.translating;
    ui.btnRestore.disabled = !state.on && !state.translating;
    updateLiveBtn();
  }

  function updateLiveBtn() {
    if (!ui || !ui.btnLive) return;
    ui.btnLive.textContent = state.live ? '停止直播' : '直播字幕';
    ui.btnLive.classList.toggle('active', !!state.live);
  }

  function updateBallUI() {
    if (!ui) return;
    ui.ball.classList.toggle('on', state.on);
    ui.ball.classList.toggle('working', state.translating);
  }

  function showPanelError(text) {
    if (!ui) return;
    ui.msg.textContent = text;
    ui.msg.classList.remove('hidden');
  }
  function hidePanelError() {
    if (!ui) return;
    ui.msg.classList.add('hidden');
  }

  function showProgress(p, label) {
    if (!ui) return;
    ui.progress.classList.remove('hidden');
    ui.progressBar.style.width = (p * 100).toFixed(1) + '%';
    ui.progressLabel.textContent = label || '';
  }
  function hideProgress(delay) {
    if (!ui) return;
    setTimeout(() => {
      ui.progress.classList.add('hidden');
      ui.progressBar.style.width = '0%';
    }, (delay || 0) * 1000);
  }

  let tipTimer = null;
  function showTooltip(text, rect, elOrTimeout, maybeTimeout) {
    if (!ui) return;
    let rect0 = rect, timeout = 0;
    if (elOrTimeout && typeof elOrTimeout !== 'number') {
      rect0 = elOrTimeout.getBoundingClientRect();
      timeout = maybeTimeout || 0;
    } else if (typeof elOrTimeout === 'number') {
      timeout = elOrTimeout;
    }
    ui.tip.textContent = text;
    ui.tip.classList.remove('hidden');
    const r = rect0 || { left: window.innerWidth / 2, top: 100, width: 0, height: 0 };
    const tw = ui.tip.offsetWidth, th = ui.tip.offsetHeight;
    let x = r.left + (r.width || 0) / 2 - tw / 2;
    let y = r.top - th - 10;
    if (y < 8) y = r.top + (r.height || 0) + 10;
    x = Math.max(8, Math.min(window.innerWidth - tw - 8, x));
    ui.tip.style.left = x + 'px';
    ui.tip.style.top = y + 'px';
    clearTimeout(tipTimer);
    if (timeout) tipTimer = setTimeout(hideTooltip, timeout);
  }
  function hideTooltip() {
    if (!ui) return;
    ui.tip.classList.add('hidden');
  }

  let toastTimer = null;
  function toast(text) {
    if (!ui) return;
    ui.toastEl.textContent = text;
    ui.toastEl.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toastEl.classList.add('hidden'), 3500);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  /* ============================== 消息 ============================== */

  chrome.runtime.onMessage.addListener((msg, sender, resp) => {
    if (!msg || !msg.type) return false;
    switch (msg.type) {
      case 'lf:toggle':
        if (typeof msg.value === 'boolean') {
          if (msg.value) translatePage(); else restore();
        } else {
          if (state.on) restore(); else translatePage();
        }
        resp({ ok: true, on: state.on, translating: state.translating });
        return false;
      case 'lf:status':
        resp({ ok: true, on: state.on, translating: state.translating, host: location.hostname });
        return false;
      case 'lf:selection':
        handleSelection();
        resp({ ok: true });
        return false;
      case 'lf:liveStarted':
        state.live = true;
        updateLiveBtn();
        resp({ ok: true });
        return false;
      case 'lf:liveEnd':
        state.live = false;
        updateLiveBtn();
        resp({ ok: true });
        return false;
      case 'lf:liveError':
        state.live = false;
        updateLiveBtn();
        toast('⚠ ' + (msg.error || '直播翻译已停止'));
        resp({ ok: true });
        return false;
      default:
        return false;
    }
  });

  /* ============================== 增量翻译 ============================== */

  let moTimer = null;
  function observeMutations() {
    const mo = new MutationObserver((muts) => {
      if (!state.on || state.translating) return;
      let relevant = false;
      for (const m of muts) {
        if (m.type === 'characterData') {
          const p = m.target && m.target.parentElement;
          if (p && p.closest && p.closest('[data-lf-skip],[data-lf-done],lf-translation,lf-original,lf-text,#lf-ui-host,#lf-video-host,.ytp-caption-window-container,.bpx-player-subtitle-wrap')) continue;
          relevant = true; break;
        }
        for (const n of m.addedNodes) {
          if (n.nodeType === 1) {
            if (n.id === 'lf-ui-host' || n.id === 'lf-video-host' || n.tagName === 'LF-TRANSLATION') continue;
            if (n.hasAttribute && n.hasAttribute('data-lf-skip')) continue;
            if (n.closest && n.closest('#lf-ui-host,[data-lf-skip]')) continue;
            if (n.textContent && n.textContent.trim()) { relevant = true; break; }
          } else if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) {
            relevant = true; break;
          }
        }
        if (relevant) break;
      }
      if (!relevant) return;
      clearTimeout(moTimer);
      moTimer = setTimeout(() => {
        if (state.on && !state.translating) translatePage(true);
      }, 1000);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }

  /* ============================== 启动 ============================== */

  async function init() {
    await ensureSettings();
    await restoreBallPos();
    const host = location.hostname;
    if ((state.settings.blacklist || []).indexOf(host) !== -1) return; // 黑名单：完全禁用

    buildUI();
    syncPanelFromSettings();

    const rule = (state.settings.siteRules || {})[host];
    if ((rule && rule.auto) || state.settings.autoTranslate) {
      setTimeout(() => { if (!state.on) translatePage(); }, 900);
    }

    observeMutations();
  }

  async function restoreBallPos() {
    try {
      const o = await chrome.storage.sync.get('lf:ball');
      if (o && o['lf:ball'] && o['lf:ball'].pos) state.ballPos = o['lf:ball'].pos;
    } catch (e) { /* noop */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
