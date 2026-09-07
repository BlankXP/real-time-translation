/*
 * BPFlow — 视频 / 直播字幕模块（内容脚本）
 * 职责：
 *   1. 视频字幕实时翻译：观察 YouTube / Bilibili 字幕 DOM，接管通用 HTML5 <track> CC，
 *      译文叠加为播放器内双语字幕层（复用 background 翻译引擎与缓存）
 *   2. 直播滚动字幕：接收 background 推送的语音转写 + 翻译结果（lf:live* 消息），
 *      渲染滚动字幕条与「直播翻译中」徽标
 */
/* global LF_DEFAULTS, LF_MERGE */
(() => {
  'use strict';
  if (!window.chrome || !chrome.runtime || !chrome.runtime.id) return;
  if (window.__LF_VIDEO__) return;
  window.__LF_VIDEO__ = true;

  /* ============================== 状态 ============================== */

  const state = {
    settings: null,
    site: null,          // 'youtube' | 'bilibili' | 'generic'
    anchor: null,        // 覆盖层锚定的播放器/容器
    ui: null,            // { host, root, stack, line, orig, trans, badge }
    playerTimer: null,   // 播放器轮询
    subTimer: null,      // 字幕容器等待轮询
    obs: null,           // 字幕 MutationObserver
    ttTimer: null,       // 通用 textTrack 扫描
    ro: null,            // ResizeObserver
    lastOrig: '',        // 上一条已渲染的字幕原文
    clearTimer: null,
    hideStyle: null,     // 隐藏原生字幕的 <style>
    live: false,
  };

  /** 各站点字幕选择器（container 用于观察，line 用于取文本） */
  const SUBS = {
    youtube:   { container: '.ytp-caption-window-container', line: '.ytp-caption-segment', native: '.ytp-caption-window-container' },
    bilibili:  { container: '.bpx-player-subtitle-wrap', line: '.bpx-player-subtitle-line-text, .bilibili-player-video-subtitle-text', native: '.bpx-player-subtitle-wrap' }
  };

  /** 各站点播放器选择器（覆盖层锚定用；未命中自动走「视频父级」通用回退） */
  const PLAYER_SEL = {
    youtube:  '.html5-video-player',
    bilibili: '.bpx-player-video-wrap, .bilibili-player-video-container',
    twitch:   '.video-player__container, .video-player',
    douyu:    '.layout-Player-video, #player',
    huya:     '#player-yy, #player',
    douyin:   '.basicPlayer, #player'
  };

  /* ============================== 基础工具 ============================== */

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => { void chrome.runtime.lastError; resolve(res || null); });
      } catch (e) { resolve(null); }
    });
  }

  async function loadSettings() {
    const o = await chrome.storage.sync.get('settings');
    state.settings = LF_MERGE(LF_DEFAULTS, (o && o.settings) || {});
    return state.settings;
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.settings) return;
    state.settings = LF_MERGE(LF_DEFAULTS, changes.settings.newValue || {});
    applyEnabled();
  });

  function videoEnabled() {
    const vs = state.settings && state.settings.videoSubtitle;
    return !!(vs && vs.enabled !== false);
  }

  function bilingual() {
    const vs = state.settings && state.settings.videoSubtitle;
    return !vs || vs.bilingual !== false;
  }

  /* ============================== 站点 / 播放器识别 ============================== */

  function detectSite() {
    if (document.querySelector('.html5-video-player')) return 'youtube';
    if (document.querySelector(PLAYER_SEL.bilibili)) return 'bilibili';
    const h = location.hostname;
    if (/(^|\.)youtube\.com$/.test(h)) return 'youtube';
    if (/(^|\.)bilibili\.com$/.test(h)) return 'bilibili';
    // 主流直播平台（无 CC 字幕可观察，字幕走语音识别链路；选择器用于覆盖层锚定）
    if (/(^|\.)twitch\.tv$/.test(h)) return 'twitch';
    if (/(^|\.)douyu\.com$/.test(h)) return 'douyu';
    if (/(^|\.)huya\.com$/.test(h)) return 'huya';
    if (/(^|\.)douyin\.com$/.test(h)) return 'douyin';
    return 'generic';
  }

  function findPlayer(site) {
    // 已知站点：优先用专属选择器（未命中继续走通用回退，播放器晚加载也能兜住）
    const sel = PLAYER_SEL[site];
    if (sel) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    // 通用回退：主视频（面积最大者）最近的「已定位且足够大」的父级
    const v = findMainVideo();
    if (!v) return null;
    let p = v.parentElement;
    while (p && p !== document.body) {
      const st = getComputedStyle(p);
      if (st.position !== 'static' && p.clientWidth > 200 && p.clientHeight > 120) return p;
      p = p.parentElement;
    }
    const parent = v.parentElement || document.body;
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    return parent;
  }

  /* ============================== 字幕翻译 ============================== */

  const transCache = new Map(); // 原文 -> 译文（会话级小缓存；跨请求缓存由 background 负责）

  async function translateLine(text) {
    if (transCache.has(text)) return transCache.get(text);
    const r = await send({ type: 'lf:translate', texts: [text] });
    if (r && r.ok && r.results && r.results[0] != null) {
      transCache.set(text, r.results[0]);
      if (transCache.size > 300) transCache.delete(transCache.keys().next().value);
      return r.results[0];
    }
    return null;
  }

  function handleSubtitleText(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t || t === state.lastOrig) return;
    state.lastOrig = t;
    clearTimeout(state.clearTimer);
    hideNativeCaptions();
    renderCurrent(t, null);

    translateLine(t).then((tr) => {
      if (state.lastOrig !== t) return; // 该行已被更新的字幕顶替
      if (tr == null) renderCurrent(t, '⚠ 翻译失败', true);
      else renderCurrent(t, tr);
    });
  }

  function clearCurrentSoon() {
    clearTimeout(state.clearTimer);
    state.clearTimer = setTimeout(() => {
      if (state.ui) state.ui.line.classList.add('hidden');
      state.lastOrig = '';
    }, 400);
  }

  /* ---------- YouTube / Bilibili：DOM 观察 ---------- */

  function observeDomSubtitles(site) {
    const conf = SUBS[site];
    if (!conf || state.obs) return;

    const attach = (container) => {
      state.obs = new MutationObserver(() => {
        const lines = document.querySelectorAll(conf.line);
        if (!lines.length) { clearCurrentSoon(); return; }
        const texts = [];
        lines.forEach((l) => { const t = (l.textContent || '').trim(); if (t) texts.push(t); });
        if (texts.length) handleSubtitleText(texts.join(' '));
        else clearCurrentSoon();
      });
      state.obs.observe(container, { childList: true, subtree: true, characterData: true });
    };

    const container = document.querySelector(conf.container);
    if (container) { attach(container); return; }

    // 字幕容器可能要等用户开启 CC 后才出现，低频轮询等待
    clearInterval(state.subTimer);
    state.subTimer = setInterval(() => {
      if (!videoEnabled()) { clearInterval(state.subTimer); state.subTimer = null; return; }
      const c = document.querySelector(conf.container);
      if (c) { clearInterval(state.subTimer); state.subTimer = null; attach(c); }
    }, 1200);
  }

  /* ---------- 通用 HTML5：textTrack cuechange ---------- */

  function hookGenericTracks() {
    const scan = () => {
      document.querySelectorAll('video').forEach((v) => {
        const tts = v.textTracks;
        if (!tts || v.__lfTT) return;
        v.__lfTT = true;
        const hook = () => {
          for (let i = 0; i < tts.length; i++) {
            const tt = tts[i];
            if (tt.__lfCue) continue;
            tt.__lfCue = true;
            tt.addEventListener('cuechange', () => onCueChange(tt));
          }
        };
        hook();
        tts.addEventListener && tts.addEventListener('addtrack', hook);
        v.addEventListener('loadedmetadata', hook);
      });
    };
    scan();
    clearInterval(state.ttTimer);
    state.ttTimer = setInterval(scan, 2000);
  }

  function onCueChange(tt) {
    if (!videoEnabled()) return;
    if (tt.mode === 'disabled') return;
    if (tt.mode === 'showing') {
      try { tt.mode = 'hidden'; } catch (e) { /* noop */ } // 由我们的覆盖层接管，避免原文重复
    }
    const cues = tt.activeCues;
    if (!cues || !cues.length) { clearCurrentSoon(); return; }
    const parts = [];
    for (let i = 0; i < cues.length; i++) parts.push(cues[i].text || '');
    handleSubtitleText(parts.join(' ').replace(/<[^>]+>/g, ' '));
  }

  /* ============================== 覆盖层 UI（Shadow DOM） ============================== */

  const OVERLAY_CSS = `
    :host { all: initial; font-family: -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: inherit; }

    .wrap {
      position: absolute; left: 0; right: 0;
      bottom: var(--lf-bottom, 76px);
      display: flex; flex-direction: column; align-items: center; gap: 6px;
      pointer-events: none;
    }

    /* ---- 视频字幕（当前行） ---- */
    .line {
      max-width: 86%;
      background: rgba(8, 10, 16, 0.62);
      backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
      border-radius: 10px;
      padding: 8px 14px;
      text-align: center;
      animation: lf-vin .18s ease both;
    }
    .line.hidden { display: none; }
    .line .orig {
      font-size: calc(var(--lf-fs, 20px) * 0.78);
      color: #dfe3ee; opacity: 0.78; margin-bottom: 2px;
    }
    .line .orig.hidden { display: none; }
    .line .trans {
      font-size: var(--lf-fs, 20px); font-weight: 600; color: #fff;
      text-shadow: 0 1px 2px rgba(0,0,0,0.8);
      word-break: break-word;
    }
    .line .trans.err { color: #fca5a5; font-weight: 400; font-size: calc(var(--lf-fs, 20px) * 0.8); }

    /* ---- 直播滚动字幕 ---- */
    .stack {
      display: flex; flex-direction: column; align-items: center; gap: 4px;
      max-width: 86%;
    }
    .stack .sl {
      background: rgba(8, 10, 16, 0.55);
      border-radius: 8px;
      padding: 5px 12px;
      text-align: center;
      animation: lf-vin .18s ease both;
    }
    .stack .sl .so {
      font-size: calc(var(--lf-fs, 20px) * 0.66);
      color: #c7cddd; opacity: 0.8;
    }
    .stack .sl .so.hidden { display: none; }
    .stack .sl .st.hidden { display: none; }
    .stack .sl .st {
      font-size: calc(var(--lf-fs, 20px) * 0.86);
      font-weight: 600; color: #fff;
      text-shadow: 0 1px 2px rgba(0,0,0,0.8);
      word-break: break-word;
    }
    .stack .sl.err .st { color: #fca5a5; font-weight: 400; }
    .stack .sl.hint .st {
      font-weight: 400; color: #c7cddd; opacity: 0.8;
      font-size: calc(var(--lf-fs, 20px) * 0.72);
    }
    .stack .sl.old { opacity: 0.55; }
    .stack .sl.old .st { font-size: calc(var(--lf-fs, 20px) * 0.72); }

    /* ---- 直播徽标 ---- */
    .badge {
      position: absolute; top: 12px; right: 12px;
      display: flex; align-items: center; gap: 7px;
      background: rgba(8, 10, 16, 0.75);
      border: 1px solid rgba(255, 255, 255, 0.14);
      color: #fff; font-size: 12px; letter-spacing: 0.02em;
      padding: 5px 6px 5px 11px;
      border-radius: 99px;
      pointer-events: auto;
      backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
    }
    .badge.hidden { display: none; }
    .badge .pulse {
      width: 8px; height: 8px; border-radius: 50%;
      background: #f43f5e; animation: lf-blink 1.2s ease infinite;
    }
    .badge button {
      border: none; background: rgba(255,255,255,0.12); color: #fff;
      width: 18px; height: 18px; border-radius: 50%;
      cursor: pointer; font-size: 10px;
      display: flex; align-items: center; justify-content: center;
    }
    .badge button:hover { background: rgba(255,255,255,0.25); }

    @keyframes lf-vin { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
    @keyframes lf-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
  `;

  function ensureOverlay(anchor, fixed) {
    if (state.ui && state.ui.host.isConnected) return state.ui;
    document.querySelectorAll('#lf-video-host').forEach((n) => n.remove());

    const host = document.createElement('div');
    host.id = 'lf-video-host';
    host.setAttribute('data-lf-skip', '1');
    host.style.position = fixed ? 'fixed' : 'absolute';
    host.style.inset = '0';
    host.style.pointerEvents = 'none';
    host.style.zIndex = '2147483000';

    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${OVERLAY_CSS}</style>
      <div class="wrap">
        <div class="stack" id="lv-stack"></div>
        <div class="line hidden" id="lv-line">
          <div class="orig hidden" id="lv-orig"></div>
          <div class="trans" id="lv-trans"></div>
        </div>
      </div>
      <div class="badge hidden" id="lv-badge">
        <span class="pulse"></span>直播翻译中
        <button id="lv-stop" title="停止直播翻译">✕</button>
      </div>
    `;

    state.anchor = anchor;
    if (!fixed && getComputedStyle(anchor).position === 'static') anchor.style.position = 'relative';
    anchor.appendChild(host);

    state.ui = {
      host, root,
      stack: root.getElementById('lv-stack'),
      line: root.getElementById('lv-line'),
      orig: root.getElementById('lv-orig'),
      trans: root.getElementById('lv-trans'),
      badge: root.getElementById('lv-badge'),
      stop: root.getElementById('lv-stop')
    };
    state.ui.stop.addEventListener('click', () => { send({ type: 'lf:stopLive' }); });
    // 直播进行中重建覆盖层时（播放器重渲染可能销毁旧覆盖层），徽标保持可见
    if (state.live) state.ui.badge.classList.remove('hidden');

    sizeFont();
    if (state.ro) state.ro.disconnect();
    try {
      state.ro = new ResizeObserver(sizeFont);
      state.ro.observe(anchor);
    } catch (e) { /* noop */ }
    window.addEventListener('resize', sizeFont, { passive: true });

    return state.ui;
  }

  function sizeFont() {
    if (!state.ui) return;
    const h = (state.anchor && state.anchor.clientHeight) || window.innerHeight || 360;
    const fs = Math.max(14, Math.min(34, Math.round(h * 0.042)));
    const bottom = Math.max(56, Math.round(h * 0.14));
    state.ui.host.style.setProperty('--lf-fs', fs + 'px');
    state.ui.host.style.setProperty('--lf-bottom', bottom + 'px');
  }

  function renderCurrent(orig, trans, isError) {
    if (!state.ui) return;
    const { line, orig: o, trans: t } = state.ui;
    if (!orig && !trans) { line.classList.add('hidden'); return; }
    line.classList.remove('hidden');
    if (bilingual()) { o.classList.remove('hidden'); o.textContent = orig; }
    else o.classList.add('hidden');
    t.classList.toggle('err', !!isError);
    t.textContent = trans != null ? trans : '…';
  }

  /* ============================== 原生字幕隐藏 / 恢复 ============================== */

  function hideNativeCaptions() {
    if (state.hideStyle || !state.site || !SUBS[state.site]) return;
    const sel = SUBS[state.site].native;
    const st = document.createElement('style');
    st.setAttribute('data-lf-skip', '1');
    st.textContent = sel + '{visibility:hidden!important}';
    document.documentElement.appendChild(st);
    state.hideStyle = st;
  }

  function restoreNativeCaptions() {
    if (state.hideStyle) { state.hideStyle.remove(); state.hideStyle = null; }
  }

  /* ============================== 直播字幕 ============================== */

  function liveAnchor() {
    const site = detectSite();
    return findPlayer(site) || document.body;
  }

  function showLiveBadge() {
    const anchor = liveAnchor();
    ensureOverlay(anchor, anchor === document.body);
    if (!state.ui) return;
    state.ui.stack.innerHTML = '';
    state.ui.badge.classList.remove('hidden');
  }

  function hideLiveBadge() {
    if (state.ui) state.ui.badge.classList.add('hidden');
  }

  /** 创建直播字幕行 DOM（.so 原文 + .st 译文两个子节点） */
  function makeLiveRow() {
    const row = document.createElement('div');
    row.className = 'sl';
    const so = document.createElement('div');
    so.className = 'so';
    const st = document.createElement('div');
    st.className = 'st';
    row.appendChild(so);
    row.appendChild(st);
    return row;
  }

  /**
   * 渲染直播字幕行：一条字幕（分片转写结果）一行，
   * 整段显示 + 整段翻译（一段一段）。
   * 提示行（isHint）：独立成行，文本放主文本槽。
   */
  function renderLiveLine(original, translated, isError, isHint) {
    const anchor = liveAnchor();
    ensureOverlay(anchor, anchor === document.body);
    if (!state.ui) return;
    const stack = state.ui.stack;

    // 每条字幕独立成行
    const row = makeLiveRow();
    stack.appendChild(row);

    row.className = 'sl' + (isError ? ' err' : '') + (isHint ? ' hint' : '');

    const so = row.firstChild;
    const st = row.lastChild;
    if (isHint) {
      // 提示/错误信息直接放主文本槽，原文槽隐藏
      so.classList.add('hidden');
      so.textContent = '';
      st.classList.remove('hidden');
      st.textContent = original || '';
    } else {
      so.textContent = original || '';
      so.classList.toggle('hidden', !bilingual());
      if (translated != null) {
        st.classList.remove('hidden');
        st.textContent = translated;
      } else {
        // 无译文：显示占位并标红（isError）
        st.classList.remove('hidden');
        st.textContent = '…';
      }
    }

    // 最多保留 3 行，旧的先行淘汰
    while (stack.children.length > 3) {
      stack.removeChild(stack.firstChild);
    }
    Array.prototype.forEach.call(stack.children, (el, i, arr) => {
      el.classList.toggle('old', i < arr.length - 1);
    });
  }

  /* ============================== 画面同步（视频延迟覆盖层） ============================== */
  /*
   * 原理：页面播放器的 <video> 元素调用 captureStream() 获取其媒体流（解码帧，
   * 非屏幕像素——不受遮挡影响、无回环），MediaRecorder 以 1 秒分片录制，
   * 分片在队列中滞留 N 秒后喂给 MediaSource，由覆盖层 <video> 延迟重放。
   * 覆盖层精确覆盖原视频矩形（原视频保持播放，仅被遮住；控制条在其上层仍可用）。
   * 声音由 offscreen 的 DelayNode 同步延迟；字幕按 speechAt+N 定时 —— 三者对齐。
   */

  const sync = {
    active: false,
    delayMs: 0,
    anchor: null, host: null, video: null,   // 覆盖层宿主与视频
    srcVideo: null, stream: null, rec: null, // 原视频与其媒体流、录制器
    queue: [],        // [{at, data}] 已录制、尚未放行的分片
    appendQueue: [],  // 待追加进 MSE 的分片
    appending: false,
    ms: null, sb: null, url: '',
    mime: '', appended: 0, appendRetries: 0,
    recStartWall: 0,  // 录制起点的墙钟时间（实测画面延迟 = now - (recStartWall + currentTime)）
    videoBps: 2500000, // 录制码率（按源分辨率动态设定）
    findRetries: 0,    // 「未找到视频元素」重试计数（日志节流用）
    pumpTimer: null, evictTimer: null, posTimer: null, stallTimer: null, retryTimer: null,
    ro: null
  };

  /**
   * 选取 Recorder 与 MSE 均支持的视频编码（webm 容器）。
   * VP8 优先：软编码速度显著快于 VP9，长时间实时编码更稳（VP9 过载丢帧会引发卡顿）。
   */
  function pickSyncMime() {
    const cands = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'];
    for (const m of cands) {
      try {
        if (MediaRecorder.isTypeSupported(m) && MediaSource.isTypeSupported(m)) return m;
      } catch (e) { /* noop */ }
    }
    return '';
  }

  /**
   * 深度查找 video 元素：light DOM 直查未命中时，递归 open Shadow Root 与同源 iframe。
   * 背景：不少站点（如 Bilibili 新版播放器 bwp-video / bilibili-player）把 <video>
   * 封装在自定义元素的 Shadow DOM 里，document.querySelectorAll('video') 拿不到；
   * closed Shadow Root 与跨域 iframe 无法访问，由调用方的重试与提示兜底。
   * @param {Document|ShadowRoot} root 起始根节点
   * @param {number} depth 递归深度（防深嵌套失控）
   * @returns {HTMLVideoElement[]}
   */
  function deepFindVideos(root, depth) {
    const out = [];
    if (depth > 5 || !root) return out;
    let all;
    try { all = root.querySelectorAll('*'); } catch (e) { return out; }
    for (let i = 0; i < all.length && out.length < 20; i++) {
      const el = all[i];
      if (el.tagName === 'VIDEO') { out.push(el); continue; }
      // open Shadow Root 宿主（bwp-video 等自定义元素）：进其内部继续找
      if (el.shadowRoot) {
        for (const v of deepFindVideos(el.shadowRoot, depth + 1)) {
          if (out.length >= 20) break;
          out.push(v);
        }
      }
      // 同源 iframe（跨域 contentDocument 为 null，自然跳过）
      if (el.tagName === 'IFRAME' && el.contentDocument) {
        for (const v of deepFindVideos(el.contentDocument, depth + 1)) {
          if (out.length >= 20) break;
          out.push(v);
        }
      }
    }
    return out;
  }

  /** 深查结果缓存（限频：light DOM 无视频时最多每 2 秒全量深查一次，避免大页面反复遍历） */
  const deepVideos = { at: 0, list: [] };

  /** 找页面主视频元素（面积最大者，即直播播放器；含 Shadow DOM / 同源 iframe 内的视频） */
  function findMainVideo() {
    let vids = Array.from(document.querySelectorAll('video'));
    if (!vids.length) {
      // light DOM 无 video：深查 Shadow DOM / 同源 iframe（限频 2s）
      const now = Date.now();
      if (now - deepVideos.at > 2000) {
        deepVideos.at = now;
        deepVideos.list = deepFindVideos(document, 0);
      }
      vids = deepVideos.list;
    }
    if (!vids.length) return null;
    let best = null, bestArea = 0;
    for (const v of vids) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea && r.width > 100) { best = v; bestArea = area; }
    }
    return best || vids[0];
  }

  /** 覆盖层视频对齐原视频矩形（相对宿主坐标系） */
  function positionSyncVideo() {
    if (!sync.active || !sync.host || !sync.srcVideo || !sync.video) return;
    try {
      const vr = sync.srcVideo.getBoundingClientRect();
      const hr = sync.host.getBoundingClientRect();
      const v = sync.video;
      v.style.left = (vr.left - hr.left) + 'px';
      v.style.top = (vr.top - hr.top) + 'px';
      v.style.width = vr.width + 'px';
      v.style.height = vr.height + 'px';
    } catch (e) { /* noop */ }
  }

  /** 确保 MSE 与 SourceBuffer 就绪（懒初始化，返回 Promise） */
  function ensureSyncMSE() {
    if (sync.sb) return Promise.resolve();
    if (!sync.ms) {
      sync.ms = new MediaSource();
      sync.url = URL.createObjectURL(sync.ms);
      sync.video.src = sync.url;
      sync.ms.addEventListener('sourceopen', () => {
        try {
          sync.sb = sync.ms.addSourceBuffer(sync.mime || 'video/webm');
          sync.sb.mode = 'segments';
        } catch (e) {
          console.log('[LF-SYNC] addSourceBuffer 失败：' + ((e && e.message) || e));
        }
      }, { once: true });
      sync.video.play().catch(() => { /* noop */ });
    }
    return new Promise((resolve) => {
      const t0 = Date.now();
      const check = () => {
        if (sync.sb || !sync.active || Date.now() - t0 > 5000) resolve();
        else setTimeout(check, 100);
      };
      check();
    });
  }

  /**
   * 追加一个分片到 SourceBuffer。
   * 关键：分片永不丢弃——SourceBuffer 正在更新（常见于 evict 的 remove 进行中）时
   * appendBuffer 会抛 InvalidStateError，若吞掉该分片将造成时间戳跳变 + 编码参考链
   * 断裂（后续 P 帧找不到参考帧 → 画面撕裂花屏）。此处返回 'retry' 由调用方重新入队。
   * @returns {Promise<'ok'|'retry'|'skip'>}
   */
  function appendSyncOne(blob) {
    return new Promise((resolve) => {
      const sb = sync.sb;
      if (!sb || !sync.active) { resolve('skip'); return; }
      // 正在更新：等 updateend 后重试（1 秒安全阀）
      if (sb.updating) {
        const onUpdateEnd = () => { sb.removeEventListener('updateend', onUpdateEnd); resolve('retry'); };
        sb.addEventListener('updateend', onUpdateEnd);
        setTimeout(() => { sb.removeEventListener('updateend', onUpdateEnd); resolve('retry'); }, 1000);
        return;
      }
      let settled = false;
      const finish = (r) => {
        if (settled) return;
        settled = true;
        sb.removeEventListener('updateend', finish);
        sb.removeEventListener('error', finish);
        resolve(r);
      };
      sb.addEventListener('updateend', () => finish('ok'));
      sb.addEventListener('error', () => finish('retry'));
      setTimeout(() => finish('retry'), 3000); // 异常卡住时重试，不丢分片
      blob.arrayBuffer().then((buf) => {
        try { sb.appendBuffer(buf); }
        catch (e) {
          // 抛错（updating 竞态等）：重试而非丢弃，避免撕裂
          finish('retry');
        }
      }).catch(() => finish('retry'));
    });
  }

  /** 串行消费追加队列（'retry' 的分片回到队首，等下一轮泵再试） */
  async function drainSyncAppends() {
    if (sync.appending || !sync.appendQueue.length) return;
    sync.appending = true;
    try {
      while (sync.appendQueue.length && sync.active) {
        await ensureSyncMSE();
        if (!sync.sb) break;
        const blob = sync.appendQueue.shift();
        const r = await appendSyncOne(blob);
        if (r === 'retry') {
          sync.appendQueue.unshift(blob); // 放回队首，保持顺序
          sync.appendRetries = (sync.appendRetries || 0) + 1;
          if (sync.appendRetries === 20 || sync.appendRetries % 200 === 0) {
            console.log('[LF-SYNC] appendBuffer 持续重试中（已 ' + sync.appendRetries + ' 次，分片未丢弃）');
          }
          break; // 本轮结束，等 pumpTimer 下个 tick 再试
        }
        sync.appended++;
      }
    } finally {
      sync.appending = false;
    }
  }

  /** 定时泵：放行滞留满 N 秒的分片进 MSE（150ms 间隔，降低一次放行多片的突发） */
  function pumpSyncQueue() {
    if (!sync.active) return;
    const now = Date.now();
    while (sync.queue.length && now - sync.queue[0].at >= sync.delayMs) {
      sync.appendQueue.push(sync.queue.shift().data);
    }
    drainSyncAppends();
  }

  /**
   * 定期回收已播放的缓冲（防 SourceBuffer 撑满）。
   * 与追加协调：追加队列为空时才执行 remove（remove 期间 updating 会阻塞 appendBuffer，
   * 虽有重试兜底，仍以不竞争为上）；删除幅度温和，保留最近 5 秒已播数据。
   */
  function evictSyncBuffer() {
    const sb = sync.sb;
    if (!sb || sb.updating || sync.appendQueue.length || sync.appending) return; // 追加优先
    if (!sync.video || !sync.video.currentTime) return;
    try { sb.remove(0, Math.max(0, sync.video.currentTime - 5)); } catch (e) { /* noop */ }
  }

  /**
   * stall 看门狗：覆盖层视频缓冲耗尽定格（readyState 低）且缓冲已有新数据 →
   * 跳到缓冲尾部附近恢复播放（丢 <1 秒内容，优于无限定格）；
   * 播放持续落后缓冲尾部（帧率抖动累积）→ 短时 1.02 倍速追赶，追上后回 1.0。
   */
  function watchSyncStall() {
    const v = sync.video;
    if (!sync.active || !v || !v.buffered || !v.buffered.length) return;
    const end = v.buffered.end(v.buffered.length - 1);
    if (v.readyState <= 2 && end - v.currentTime > 1.5) {
      // 缓冲就绪但播放停滞：跳到尾部前 0.3 秒恢复
      try {
        v.currentTime = Math.max(v.buffered.start(v.buffered.length - 1), end - 0.3);
        console.log('[LF-SYNC] stall 恢复：跳至 ' + v.currentTime.toFixed(1) + 's（缓冲尾部 ' + end.toFixed(1) + 's）');
      } catch (e) { /* noop */ }
    } else if (v.readyState >= 3 && end - v.currentTime > 2.5) {
      if (v.playbackRate === 1) {
        v.playbackRate = 1.02; // 微速追赶，避免停顿累积
        console.log('[LF-SYNC] 播放落后缓冲 ' + (end - v.currentTime).toFixed(1) + 's，1.02x 追赶中');
      }
    } else if (v.playbackRate !== 1) {
      v.playbackRate = 1; // 追上了，恢复正常速
    }
  }

  /** 视频轨道结束（换清晰度/换元素）→ 重建同步链路（保留当前实际队列延迟） */
  function rebuildSync() {
    if (!sync.active) return;
    console.log('[LF-SYNC] 视频轨道结束（换源/换清晰度），2 秒后重建画面同步');
    const delay = sync.delayMs; // 已含 trim 的实际队列延迟，重建时沿用
    stopSyncVideo();
    sync.retryTimer = setTimeout(() => {
      if (state.live) startSyncVideo(delay);
    }, 2000);
  }

  /**
   * 启动画面同步：captureStream → MediaRecorder(1s 分片) → N 秒队列 → MSE 覆盖层重放。
   * @param {number} baseDelayMs 基础延迟毫秒数（= playbackDelayMs）
   * @param {number} [trimMs] 画面延迟微调（videoDelayTrimMs，±3s）：
   *                          画面链路固有延迟比声音链路多，负值让画面提前补偿
   */
  function startSyncVideo(baseDelayMs, trimMs) {
    // 队列延迟 = 基础延迟 + 微调；下限 1s（MSE 1 秒分片的最小可行缓冲）
    const delayMs = Math.max(1000, baseDelayMs + (trimMs || 0));
    if (sync.active || !(delayMs > 0)) return;
    const v = findMainVideo();
    if (!v) {
      // 深查也未见（closed Shadow Root / 跨域 iframe / 尚未加载）：日志节流，避免每 2 秒刷屏
      sync.findRetries = (sync.findRetries || 0) + 1;
      if (sync.findRetries <= 3 || sync.findRetries % 15 === 0) {
        console.log('[LF-SYNC] 未找到视频元素（第 ' + sync.findRetries + ' 次，可能位于受保护的播放器内或尚未加载），'
          + '2 秒后重试；声音与字幕不受影响');
      }
      sync.retryTimer = setTimeout(() => { if (state.live) startSyncVideo(baseDelayMs, trimMs); }, 2000);
      return;
    }
    sync.findRetries = 0;
    let stream = null;
    try {
      const cap = v.captureStream || v.webkitCaptureStream;
      if (!cap) throw new Error('浏览器不支持 captureStream');
      stream = cap.call(v);
    } catch (e) {
      console.log('[LF-SYNC] captureStream 失败（视频可能受保护）：' + ((e && e.message) || e));
      return;
    }
    const track = stream && stream.getVideoTracks()[0];
    if (!track) {
      console.log('[LF-SYNC] 视频流无视频轨，2 秒后重试');
      sync.retryTimer = setTimeout(() => { if (state.live) startSyncVideo(baseDelayMs, trimMs); }, 2000);
      return;
    }

    sync.active = true;
    sync.delayMs = delayMs;
    sync.srcVideo = v;
    sync.stream = stream;
    sync.mime = pickSyncMime();
    sync.recStartWall = Date.now();

    // 覆盖层宿主：挂在原视频的父元素、紧随其后插入。
    // 关键：不靠 z-index 压制（Twitch 等站点的控制条 z-index 为 auto/0，若覆盖层用更高
    // z-index 会视觉遮挡控制条）；同层级下 DOM 顺序后者绘制在上——紧随原视频即可盖住它，
    // 而控制条等后续兄弟元素仍在覆盖层之上。z-index 与原视频取同值（同值时 DOM 序决胜）。
    const anchor = v.parentElement || liveAnchor();
    const fixed = false; // 挂在视频父级内，无需 fixed
    const host = document.createElement('div');
    host.id = 'lf-sync-host';
    host.setAttribute('data-lf-skip', '1');
    host.style.position = 'absolute';
    host.style.inset = '0';
    try {
      const vz = getComputedStyle(v).zIndex;
      if (vz && vz !== 'auto') host.style.zIndex = vz; // 同值 + DOM 序在后 → 必盖住原视频
    } catch (e) { /* noop */ }
    host.style.pointerEvents = 'none';
    host.style.overflow = 'hidden';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        video { position: absolute; object-fit: contain; background: #000; }
      </style>
      <video id="sv" muted autoplay playsinline></video>
    `;
    anchor.insertBefore(host, v.nextSibling);
    sync.anchor = anchor;
    sync.host = host;
    sync.video = root.getElementById('sv');

    // 轨道结束（换源）→ 重建
    track.addEventListener('ended', rebuildSync);

    // 仅录制视频轨（声音由 offscreen 延迟回放，避免双声）
    const vOnly = new MediaStream();
    vOnly.addTrack(track);
    // 码率按源分辨率动态设定：1080p≈8Mbps / 720p≈3.5Mbps（覆盖 60fps 高运动画面，
    // 码率不足会产生块效应——高运动场景的"撕裂感"多源于此）；上限 10Mbps
    const vw = v.videoWidth || 1280, vh = v.videoHeight || 720;
    sync.videoBps = Math.min(10000000, Math.max(2500000, Math.round(vw * vh * 3.8)));
    try {
      sync.rec = sync.mime
        ? new MediaRecorder(vOnly, { mimeType: sync.mime, videoBitsPerSecond: sync.videoBps })
        : new MediaRecorder(vOnly);
    } catch (e) {
      console.log('[LF-SYNC] MediaRecorder 创建失败：' + ((e && e.message) || e));
      stopSyncVideo();
      return;
    }
    sync.rec.ondataavailable = (e) => {
      if (e.data && e.data.size && sync.active) sync.queue.push({ at: Date.now(), data: e.data });
    };
    sync.rec.start(1000); // 每秒一片（首片含容器头，可独立喂 MSE）

    // 泵 / 缓冲回收 / stall 看门狗 / 位置跟随
    sync.pumpTimer = setInterval(pumpSyncQueue, 150);
    sync.evictTimer = setInterval(evictSyncBuffer, 15000);
    sync.stallTimer = setInterval(watchSyncStall, 1000);
    positionSyncVideo();
    try {
      sync.ro = new ResizeObserver(positionSyncVideo);
      sync.ro.observe(v);
      if (anchor !== document.body) sync.ro.observe(anchor);
    } catch (e) { /* noop */ }
    window.addEventListener('resize', positionSyncVideo);
    document.addEventListener('fullscreenchange', positionSyncVideo);
    sync.posTimer = setInterval(positionSyncVideo, 2000); // 兜底轮询

    const trimInfo = (trimMs || 0) ? '，微调 ' + ((trimMs > 0 ? '+' : '') + (trimMs / 1000) + 's') : '';
    console.log('[LF-SYNC] 画面同步已启动：画面队列延迟 ' + (delayMs / 1000) + 's' + trimInfo
      + '（声音延迟 ' + (baseDelayMs / 1000) + 's；对照口型可调「画面延迟微调」）');
  }

  /** 停止画面同步并清理（原视频全程未被修改，移除覆盖层即恢复） */
  function stopSyncVideo() {
    clearTimeout(sync.retryTimer);
    sync.findRetries = 0; // 重置「未找到视频」重试计数（下次启动从头计）
    if (!sync.active) return;
    sync.active = false;
    clearInterval(sync.pumpTimer); clearInterval(sync.evictTimer); clearInterval(sync.posTimer);
    clearInterval(sync.stallTimer);
    if (sync.ro) { try { sync.ro.disconnect(); } catch (e) { /* noop */ } sync.ro = null; }
    window.removeEventListener('resize', positionSyncVideo);
    document.removeEventListener('fullscreenchange', positionSyncVideo);
    try { if (sync.rec && sync.rec.state !== 'inactive') sync.rec.stop(); } catch (e) { /* noop */ }
    try { if (sync.video && sync.video.playbackRate !== 1) sync.video.playbackRate = 1; } catch (e) { /* noop */ }
    try { if (sync.sb) sync.sb.abort(); } catch (e) { /* noop */ }
    try { if (sync.ms) sync.ms.endOfStream(); } catch (e) { /* noop */ }
    if (sync.url) { try { URL.revokeObjectURL(sync.url); } catch (e) { /* noop */ } }
    if (sync.host) { try { sync.host.remove(); } catch (e) { /* noop */ } }
    sync.host = null; sync.video = null; sync.srcVideo = null; sync.stream = null;
    sync.rec = null; sync.ms = null; sync.sb = null; sync.url = '';
    sync.queue = []; sync.appendQueue = []; sync.appending = false; sync.appended = 0; sync.appendRetries = 0;
    console.log('[LF-SYNC] 画面同步已停止');
  }

  /* ============================== 字幕定时上屏（同步延迟对齐） ============================== */

  const pendingCaptions = []; // { timer }：等待展示时刻的字幕

  /** 清空待展示字幕（启停直播时调用） */
  function clearPendingCaptions() {
    pendingCaptions.forEach((e) => clearTimeout(e.timer));
    pendingCaptions.length = 0;
  }

  /**
   * 处理一条直播字幕：若开了同步延迟，按「语音发生时刻 + 延迟」定时上屏；
   * 无延迟或时刻已过则立即上屏。运行提示（liveNotice）不参与定时。
   * 每条字幕（分片转写结果）独立成行：整段显示、整段翻译。
   */
  function handleLiveCaption(msg) {
    const N = (state.settings && state.settings.voice && state.settings.voice.playbackDelayMs) || 0;
    const render = () => {
      console.log('[LF-LIVE] 字幕上屏：original=' + JSON.stringify(msg.original)
        + ' translated=' + JSON.stringify(msg.translated));
      // 无译文（translated=null）标红占位
      renderLiveLine(msg.original, msg.translated, msg.translated == null, false);
    };
    if (!(N > 0)) { render(); return; }
    const wait = (msg.speechAt || Date.now()) + N - Date.now();
    if (wait <= 0) { render(); return; }
    const entry = { timer: null };
    entry.timer = setTimeout(() => {
      const i = pendingCaptions.indexOf(entry);
      if (i >= 0) pendingCaptions.splice(i, 1);
      render();
    }, wait);
    pendingCaptions.push(entry);
    console.log('[LF-LIVE] 字幕延迟排队：' + Math.round(wait) + 'ms 后上屏（对齐 ' + (N / 1000) + 's 同步延迟）');
  }

  /* ============================== 消息 ============================== */

  chrome.runtime.onMessage.addListener((msg, sender, resp) => {
    if (!msg || !msg.type) return false;
    switch (msg.type) {
      case 'lf:liveStarted':
        state.live = true;
        clearPendingCaptions();
        console.log('[LF-LIVE] liveStarted：覆盖层与徽标已就绪，等待音频分片…');
        showLiveBadge();
        renderLiveLine('正在监听本页声音，稍候出现字幕…', null, false, true);
        // 开启「同步画面」且有延迟时，启动视频延迟覆盖层（修改设置需重开直播生效）
        {
          const vv = (state.settings && state.settings.voice) || {};
          if (vv.syncVideo && (vv.playbackDelayMs || 0) > 0) {
            startSyncVideo(vv.playbackDelayMs, vv.videoDelayTrimMs || 0);
          }
        }
        resp({ ok: true });
        return false;
      case 'lf:liveCaption':
        state.live = true;
        handleLiveCaption(msg); // 内部按「语音时刻 + 同步延迟」定时上屏
        resp({ ok: true });
        return false;
      case 'lf:liveLog':
        // 全链路调试日志（background [LF-BG] / offscreen [LF-OFF] 转发而来）
        console.log('%c' + (msg.line || ''), 'color:#38bdf8');
        // 同时聚合到 window.__LF_LIVE_LOG__，方便在控制台整体导出排查
        (window.__LF_LIVE_LOG__ = window.__LF_LIVE_LOG__ || []).push(msg.line || '');
        if (window.__LF_LIVE_LOG__.length > 500) window.__LF_LIVE_LOG__.shift();
        resp({ ok: true });
        return false;
      case 'lf:liveNotice':
        // 转写/转码的运行状态与错误提示，直接显示在字幕区，避免"只有徽标没有字"
        console.log('[LF-LIVE] 运行提示(' + (msg.level || 'info') + ')：' + (msg.text || ''));
        renderLiveLine(msg.text || '', null, msg.level === 'error', true);
        resp({ ok: true });
        return false;
      case 'lf:liveEnd':
        state.live = false;
        console.log('[LF-LIVE] liveEnd：直播翻译已停止');
        stopSyncVideo();          // 移除视频延迟覆盖层（原画面即刻恢复）
        clearPendingCaptions();   // 丢弃未到展示时刻的字幕
        hideLiveBadge();
        resp({ ok: true });
        return false;
      default:
        return false;
    }
  });

  /* ============================== 启停 ============================== */

  function start() {
    state.site = detectSite();
    clearInterval(state.playerTimer);
    state.playerTimer = setInterval(() => {
      if (!videoEnabled()) { clearInterval(state.playerTimer); state.playerTimer = null; return; }
      const p = findPlayer(state.site);
      if (p) ensureOverlay(p, false);
    }, 1000);

    const p0 = findPlayer(state.site);
    if (p0) ensureOverlay(p0, false);

    if (state.site === 'generic') hookGenericTracks();
    else observeDomSubtitles(state.site);
  }

  function stop() {
    clearInterval(state.playerTimer); state.playerTimer = null;
    clearInterval(state.subTimer); state.subTimer = null;
    clearInterval(state.ttTimer); state.ttTimer = null;
    if (state.obs) { state.obs.disconnect(); state.obs = null; }
    if (state.ro) { state.ro.disconnect(); state.ro = null; }
    restoreNativeCaptions();
    state.lastOrig = '';
    // 直播进行中时保留覆盖层（徽标/滚动字幕还在用）
    if (state.ui && !state.live) { state.ui.host.remove(); state.ui = null; state.anchor = null; }
  }

  function applyEnabled() {
    if (videoEnabled()) start();
    else stop();
  }

  /* ============================== 调试钩子 ============================== */

  /** 画面同步状态（隔离世界内可调）：window.__LF_SYNC_DEBUG__() */
  window.__LF_SYNC_DEBUG__ = () => JSON.stringify({
    active: sync.active,
    delayMs: sync.delayMs,
    queued: sync.queue.length,
    appending: sync.appendQueue.length,
    appended: sync.appended,
    appendRetries: sync.appendRetries, // appendBuffer 冲突重试次数（非零属正常，分片未丢）
    videoBps: sync.videoBps,
    pendingCaptions: pendingCaptions.length,
    // 实测画面延迟：now - (录制起点 + 播放位置) = 分片滞留 + 链路固有延迟（分片/MSE/解码）
    // 与声音延迟相减即「画面-声音」偏差，可直接作为「画面延迟微调」的参考值
    measuredVideoDelayMs: (sync.active && sync.video && sync.recStartWall)
      ? Math.round(Date.now() - (sync.recStartWall + sync.video.currentTime * 1000))
      : null,
    overlayVideo: sync.video ? {
      readyState: sync.video.readyState,
      paused: sync.video.paused,
      currentTime: +sync.video.currentTime.toFixed(1),
      buffered: (sync.video.buffered && sync.video.buffered.length)
        ? [+(sync.video.buffered.start(0)).toFixed(1), +(sync.video.buffered.end(0)).toFixed(1)]
        : null
    } : null,
    srcVideo: sync.srcVideo ? {
      readyState: sync.srcVideo.readyState,
      paused: sync.srcVideo.paused,
      currentTime: +sync.srcVideo.currentTime.toFixed(1)
    } : null
  });

  /* ============================== 初始化 ============================== */

  async function init() {
    await loadSettings();
    if ((state.settings.blacklist || []).indexOf(location.hostname) !== -1) return;
    if (videoEnabled()) start();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
