/*
 * BPFlow — 内容脚本主流程
 * 职责：翻译调度与取消 / 悬浮球与快捷面板（Shadow DOM）/ 划词翻译 / 增量翻译 / 站点规则
 */
/* global LF, LF_DEFAULTS, LF_MERGE, LF_SCAN, LF_MARKS, LF_UI_CSS, LF_VIEW, LF_DOM */
/*
 * 依赖 content/scan.js（LF_SCAN）：文本块扫描与脏块收集
 *      content/marks.js（LF_MARKS）：译文落地
 *      content/ui-css.js（LF_UI_CSS）：Shadow DOM 样式
 *      content/ui-view.js（LF_VIEW）：面板/提示/浮条定位与语言下拉构建
 */
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

  /** 增量翻译的脏块集合（MutationObserver 收集，去抖后批量补翻） */
  const dirty = new Set();


  /* ============================== 工具 ============================== */

  const normText = LF_SCAN.textOf;

  // 与设置页 / 弹窗共用同一份实现（shared/dom-utils.js）
  const send = LF_DOM.send;

  function chunk(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  }

  /* ============================== 设置 ============================== */

  async function ensureSettings() {
    // 只取「公开设置」：后台已把 apiKey 剥离到 storage.local，内容脚本永远读不到密钥
    const r = await send({ type: 'lf:getSettings' });
    state.settings = LF_MERGE(LF_DEFAULTS, (r && r.ok && r.settings) ? r.settings : {});
    syncPanelFromSettings();
    return state.settings;
  }

  async function updateSettings(patch) {
    // 读-改-写：浮动面板只改自己关心的字段，不能把整份旧快照盖回去
    // （设置页可能刚改过别的项；旧版这里会把它们一起冲掉）
    const o = await chrome.storage.sync.get('settings');
    state.settings = LF_MERGE(LF_MERGE(LF_DEFAULTS, (o && o.settings) || {}), patch);
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

  /* ============================== 翻译应用 ============================== */

  // 落地逻辑见 content/marks.js（LF_MARKS），这里只绑定当前设置
  function applyTranslation(block, translated) {
    return LF_MARKS.applyTranslation(block, translated, state.settings);
  }

  function reapplyStyles() {
    return LF_MARKS.reapplyStyles(document, state.settings);
  }

  function restore() {
    state.token++;
    state.on = false;
    state.translating = false;
    dirty.clear();
    clearTimeout(moTimer);
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

  /**
   * 翻译主流程。
   * @param {boolean} [silent] 增量补翻：不显示进度条、不弹「未发现文本」
   * @param {?Element[]} [presetBlocks] 只翻这些块（增量路径直接给脏块，避免全页重扫）
   */
  async function translatePage(silent, presetBlocks) {
    if (state.translating) return; // 正在翻译：新内容已进 dirty，等这轮结束再补
    const myToken = ++state.token;
    state.on = true;
    state.translating = true;
    updateBallUI();
    updatePanelState();

    await ensureSettings();
    const settings = state.settings;
    // 夹住范围：导入的脏值（0 / 负数）会让 slice(0, maxUnits) 行为异常（0 块 / 丢掉最后一块）
    const rawUnits = Number((settings.advanced && settings.advanced.maxUnits) || 600);
    const maxUnits = Number.isFinite(rawUnits) ? Math.max(50, Math.min(3000, Math.round(rawUnits))) : 600;
    const minLen = Math.max(1, (settings.advanced && settings.advanced.minTextLength) != null
      ? settings.advanced.minTextLength : 2);

    let list;
    let limited = false;
    if (presetBlocks) {
      list = presetBlocks.slice(0, maxUnits);
    } else {
      const scanned = LF_SCAN.getUnits({ minLen, limit: maxUnits + 1 }).filter((b) => !b.dataset.lfDone);
      limited = scanned.length > maxUnits;
      list = limited ? scanned.slice(0, maxUnits) : scanned;
    }

    const seen = new Set();
    const uniqueTexts = [];
    for (const b of list) {
      const t = normText(b);
      if (t && !seen.has(t)) { seen.add(t); uniqueTexts.push(t); }
    }

    if (!uniqueTexts.length) {
      state.translating = false;
      if (!silent) hideProgress(0.3);
      updateBallUI();
      updatePanelState();
      if (!silent) toast('未发现可翻译的文本');
      return;
    }

    if (!silent) showProgress(0.04, '正在准备翻译…');

    const resultMap = new Map();
    let done = 0;
    let anyOk = false;
    let lastError = null;
    const chunks = chunk(uniqueTexts, 16);
    /*
     * 窗口式并发：同时保持 LANES 批在途。
     * 旧实现「一批全部回来才发下一批」，把后台 runPool 的并发能力锁死在单批之内——
     * 对 batch≥16 的引擎（Bing 20 / DeepL 25 / OpenAI 16）而言一批正好等于一次请求，
     * 整页耗时等于逐批相加（600 块 ≈ 38 次串行请求）。
     * 结果仍按批内下标写入同一 resultMap，不存在乱序；取消令牌在每次 await 前后各校验一次。
     * 车道数不超过用户设置的总并发（并发=1 时退化为原来的完全串行）。
     */
    const rawConc = Number(settings.advanced && settings.advanced.concurrency);
    const conc = Number.isFinite(rawConc) ? Math.max(1, Math.round(rawConc)) : 4;
    const LANES = Math.min(2, conc);
    let cursor = 0;

    const runLane = async (laneIdx) => {
      for (;;) {
        const bi = cursor++;
        if (bi >= chunks.length) return;
        if (state.token !== myToken || !state.on) return; // 已取消
        const c = chunks[bi];
        // 带上车道下标：后台按「车道数 + 下标」分摊并发额度，奇数并发也不会超限
        const r = await send({ type: 'lf:translate', texts: c, lanes: LANES, lane: laneIdx });
        if (state.token !== myToken || !state.on) return;
        if (r && r.ok && Array.isArray(r.results)) {
          anyOk = true;
          c.forEach((t, i) => { if (r.results[i] != null) resultMap.set(t, r.results[i]); });
        } else {
          lastError = (r && r.error) || '网络错误，无法连接翻译服务';
        }
        done += c.length;
        if (!silent) {
          showProgress(Math.min(0.97, 0.05 + 0.92 * (done / uniqueTexts.length)),
            '翻译中 ' + done + ' / ' + uniqueTexts.length);
        }
      }
    };
    await Promise.all(new Array(Math.min(LANES, chunks.length)).fill(0).map((v, i) => runLane(i)));

    for (const b of list) {
      const t = normText(b);
      if (!t) continue;
      applyTranslation(b, resultMap.has(t) ? resultMap.get(t) : null);
    }

    state.translating = false;
    if (!silent) hideProgress(0.5);
    updateBallUI();
    updatePanelState();

    if (!anyOk && lastError) {
      showPanelError(lastError);
      if (!silent) toast('翻译失败：' + lastError);
    } else if (limited) {
      showPanelError('页面内容较多，已翻译前 ' + maxUnits + ' 个文本块');
    } else if (done > 0) {
      hidePanelError();
    }

    // 翻译期间新增的内容已进 dirty 集合，这里补一轮（不再全页重扫）
    if (dirty.size) scheduleDirty();
  }

  /* ============================== 悬停模式 / 划词翻译 ============================== */

  document.addEventListener('mouseover', (e) => {
    const s = state.settings;
    if (!s || s.displayMode !== 'hover') return;
    const el = e.target && e.target.closest ? e.target.closest('.lf-hoverable') : null;
    if (el && el.dataset.lfHoverText) showTooltipFor(el.dataset.lfHoverText, el);
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
    showTooltipAt('正在翻译…', rect);
    const r = await send({ type: 'lf:translate', texts: [text.slice(0, 1500)] });
    if (r && r.ok && r.results && r.results[0] != null) showTooltipAt(r.results[0], rect, 10000);
    else showTooltipAt('⚠ ' + ((r && r.error) || '翻译失败'), rect, 5000);
  }

  /* ============================== Shadow DOM UI ============================== */

  let ui = null; // {host, root, ball, panel, ...}

  const SHADOW_CSS = LF_UI_CSS; // 样式见 content/ui-css.js

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
            <button class="btn ghost" id="lf-btn-live" title="直播字幕：需从工具栏图标 / 右键菜单 / Alt+Shift+L 启动捕获（浏览器安全限制）">直播字幕</button>
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
    const pos = LF_VIEW.clampBall(p, { w: window.innerWidth, h: window.innerHeight }, 6);
    state.ballPos = pos;
    ui.ball.style.left = pos.x + 'px';
    ui.ball.style.top = pos.y + 'px';
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
      if (r && r.ok) {
        hidePanelError();
      } else if (r && r.code === 'needInvocation') {
        // 内容脚本里的点击不构成「唤起扩展」，tabCapture 会拒绝——给出可执行的替代入口，
        // 而不是把浏览器的英文安全报错原样丢给用户
        showPanelError('浏览器安全要求：需先唤起扩展才能捕获页面声音。请点工具栏的 BPFlow 图标 → 开始，或按 Alt+Shift+L / 右键菜单启动');
        toast('请从工具栏图标 / 右键菜单 / Alt+Shift+L 启动直播字幕');
      } else {
        showPanelError((r && r.error) || '启动失败');
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

    const pos = LF_VIEW.selBarPosition(
      rect,
      { w: sb.offsetWidth, h: sb.offsetHeight },
      { w: window.innerWidth, h: window.innerHeight }
    );
    sb.style.left = pos.x + 'px';
    sb.style.top = pos.y + 'px';
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
    const pos = LF_VIEW.panelPosition(
      state.ballPos || defaultBallPos(),
      { w: LF_VIEW.PANEL_WIDTH, h: ui.panel.offsetHeight || 380 },
      { w: window.innerWidth, h: window.innerHeight }
    );
    ui.panel.style.left = pos.x + 'px';
    ui.panel.style.top = pos.y + 'px';
  }

  function syncPanelFromSettings() {
    if (!ui || !state.settings) return;
    const s = state.settings;

    // 语言下拉（构建逻辑见 ui-view.js）
    ui.selTarget.innerHTML = LF_VIEW.targetOptions(
      [].concat(LF.LANGS, s.customLangs || []),
      s.quickLangs || [],
      s.targetLang
    );
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
    ui.engineName.innerHTML = '引擎：<b>' + LF_VIEW.esc(prov ? prov.name : '未配置') + '</b>';

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

  /**
   * 在矩形锚点附近显示提示。
   * @param {string} text
   * @param {?{left:number,top:number,width:number,height:number}} rect 缺省时在视口上方居中
   * @param {number} [timeout] 毫秒；不传则常驻，由调用方 hideTooltip
   */
  function showTooltipAt(text, rect, timeout) {
    if (!ui) return;
    ui.tip.textContent = text;
    ui.tip.classList.remove('hidden');
    const r = rect || { left: window.innerWidth / 2, top: 100, width: 0, height: 0 };
    const pos = LF_VIEW.tipPosition(
      r,
      { w: ui.tip.offsetWidth, h: ui.tip.offsetHeight },
      { w: window.innerWidth, h: window.innerHeight }
    );
    ui.tip.style.left = pos.x + 'px';
    ui.tip.style.top = pos.y + 'px';
    clearTimeout(tipTimer);
    if (timeout) tipTimer = setTimeout(hideTooltip, timeout);
  }

  /** 以元素为锚点显示提示（悬停模式：取块的实时位置，滚动后也贴得住） */
  function showTooltipFor(text, el, timeout) {
    showTooltipAt(text, el ? el.getBoundingClientRect() : null, timeout);
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
  /*
   * 只翻「变动过的块」：MutationObserver 把新增子树 / 文本变化折算成 dirty 块集合，
   * 去抖后只对这批块发请求。旧实现每次都全页重扫（TreeWalker + getComputedStyle +
   * getClientRects），SPA 高频更新时主线程会被反复吃满。
   */

  let moTimer = null;

  function addDirty(block) {
    if (!block || dirty.size >= 500) return; // 上限：极端 SPA 不至于把内存拖爆
    if (!LF_SCAN.isTranslatableBlock(block)) return; // 与整页扫描同一套跳过规则
    dirty.add(block);
  }

  /** 把一批 mutation 折算成脏块（只登记，不翻译） */
  function collectDirty(muts) {
    for (const m of muts) {
      if (m.type === 'characterData') {
        const p = m.target && m.target.parentElement;
        if (!p || !p.closest) continue;
        if (LF_SCAN.isSkipped(p)) continue;
        addDirty(LF_SCAN.findBlockAncestor(p));
        continue;
      }
      for (const n of m.addedNodes) {
        if (n.nodeType === 1) {
          if (n.id === 'lf-ui-host' || n.id === 'lf-video-host' || n.tagName === 'LF-TRANSLATION') continue;
          if (n.hasAttribute && n.hasAttribute('data-lf-skip')) continue;
          if (n.closest && n.closest('#lf-ui-host,[data-lf-skip]')) continue;
          LF_SCAN.collectLeafBlocks(n, dirty, 500);
        } else if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) {
          addDirty(LF_SCAN.findBlockAncestor(n.parentElement));
        }
      }
    }
  }

  function scheduleDirty() {
    if (!state.on) return;
    clearTimeout(moTimer);
    moTimer = setTimeout(() => { moTimer = null; translateDirty(); }, 800);
  }

  /** 补翻脏块：单批最多 60 块，剩下的一轮再补 */
  async function translateDirty() {
    if (!state.on || state.translating || !dirty.size) return;
    const s = state.settings || {};
    const minLen = Math.max(1, (s.advanced && s.advanced.minTextLength) != null ? s.advanced.minTextLength : 2);
    const list = [];
    for (const b of dirty) {
      dirty.delete(b);
      if (!b.isConnected || b.dataset.lfDone) continue;
      if (!LF_SCAN.isTranslatableBlock(b)) continue; // 二次校验：脏集合可能被旧规则塞入过
      const t = normText(b);
      if (!t || t.length < minLen) continue;
      try {
        const st = getComputedStyle(b);
        if (st.display === 'none' || st.visibility === 'hidden') continue;
        if (!b.getClientRects().length) continue;
      } catch (e) { continue; }
      list.push(b);
      if (list.length >= 60) break;
    }
    if (!list.length) {
      if (dirty.size) scheduleDirty();
      return;
    }
    await translatePage(true, list);
    if (dirty.size) scheduleDirty();
  }

  function observeMutations() {
    const mo = new MutationObserver((muts) => {
      if (!state.on) return;
      const before = dirty.size;
      collectDirty(muts);
      // 翻译中也不丢：新块先入 dirty，本轮结束后统一补
      if (dirty.size !== before) scheduleDirty();
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
