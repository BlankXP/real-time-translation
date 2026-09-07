/* BPFlow — Popup 逻辑 */
/* global LF, LF_DEFAULTS, LF_MERGE */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    previewBadge: $('preview-badge'),
    btnOptions: $('btn-options'),
    toggleCard: $('toggle-card'),
    btnToggle: $('btn-toggle'),
    toggleSub: $('toggle-sub'),
    selSource: $('sel-source'),
    selTarget: $('sel-target'),
    btnSwap: $('btn-swap'),
    segMode: $('seg-mode'),
    selEngine: $('sel-engine'),
    engineHint: $('engine-hint'),
    btnManage: $('btn-manage'),
    pageHint: $('page-hint'),
    liveCard: $('live-card'),
    btnLive: $('btn-live'),
    liveSub: $('live-sub'),
    ver: $('ver')
  };

  const state = { settings: null, tab: null, pageOn: false, pageAvailable: true, live: false, liveErr: '' };

  /* ---------- 与后台通信 ---------- */

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; resolve(r || null); });
      } catch (e) { resolve(null); }
    });
  }

  async function refreshLiveState() {
    if (window.__LF_PREVIEW__ || !state.tab || state.tab.id == null) return;
    const r = await send({ type: 'lf:liveStatus', tabId: state.tab.id });
    state.live = !!(r && r.live);
    syncLiveUI();
  }

  function syncLiveUI() {
    els.liveCard.classList.toggle('on', !!state.live);
    els.btnLive.textContent = state.live ? '停止' : '开始';
    els.liveSub.textContent = state.liveErr
      || (state.live ? '正在转写本页声音…' : '捕获本页声音 → 实时转写翻译');
  }

  /* ---------- 初始化 ---------- */

  async function init() {
    if (window.__LF_PREVIEW__) els.previewBadge.classList.remove('hidden');

    try { els.ver.textContent = chrome.runtime.getManifest().version; } catch (e) { /* noop */ }

    const o = await chrome.storage.sync.get('settings');
    state.settings = LF_MERGE(LF_DEFAULTS, (o && o.settings) || {});

    // 当前标签页与翻译状态
    if (window.__LF_PREVIEW__) {
      state.pageAvailable = true; // 预览模式：仅展示交互
    } else {
      try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      state.tab = tabs && tabs[0];
      if (state.tab && state.tab.id != null) {
        const status = await new Promise((resolve) => {
          try {
            chrome.tabs.sendMessage(state.tab.id, { type: 'lf:status' }, (r) => {
              void chrome.runtime.lastError;
              resolve(r || null);
            });
          } catch (e) { resolve(null); }
        });
        if (status && status.ok) {
          state.pageOn = status.on;
          state.pageAvailable = true;
        } else {
          state.pageAvailable = false;
        }
      } else {
        state.pageAvailable = false;
      }
    } catch (e) {
      state.pageAvailable = false;
    }
    }

    buildLangSelects();
    buildEngineSelect();
    syncUI();
    await refreshLiveState();

    if (!state.pageAvailable) {
      els.btnToggle.disabled = true;
      els.pageHint.classList.remove('hidden');
    }

    bindEvents();

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !changes.settings) return;
      state.settings = LF_MERGE(LF_DEFAULTS, changes.settings.newValue || {});
      syncUI();
    });
  }

  /* ---------- 下拉构建 ---------- */

  function buildLangSelects() {
    const all = [].concat(LF.LANGS, state.settings.customLangs || []);
    const name = (c) => { const l = all.find((x) => x.code === c); return l ? (l.name || l.label) : c; };
    const opt = (c) => '<option value="' + esc(c) + '">' + esc(name(c)) + '</option>';

    // 源语言：auto + 全部
    els.selSource.innerHTML = all.map((l) => opt(l.code)).join('');

    // 目标语言：常用优先，其余折叠在后面
    const quick = (state.settings.quickLangs || []).filter((c) => c !== 'auto' && all.some((l) => l.code === c));
    if (!quick.includes(state.settings.targetLang)) quick.unshift(state.settings.targetLang);
    const rest = all.filter((l) => l.code !== 'auto' && !quick.includes(l.code));
    let html = quick.map(opt).join('');
    if (rest.length) {
      html += '<option disabled value="__sep__">────────</option>' + rest.map((l) => opt(l.code)).join('');
    }
    els.selTarget.innerHTML = html;
  }

  function buildEngineSelect() {
    const enabled = (state.settings.providers || []).filter((p) => p.enabled !== false);
    els.selEngine.innerHTML = enabled.map((p) =>
      '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>'
    ).join('');
    if (!enabled.some((p) => p.id === state.settings.activeProviderId) && enabled.length) {
      state.settings.activeProviderId = enabled[0].id;
    }
    const prov = enabled.find((p) => p.id === state.settings.activeProviderId);
    if (prov) {
      const meta = LF.ENGINES[prov.type] || {};
      els.engineHint.innerHTML = esc(meta.desc || '') + (prov.model ? ' · <b>' + esc(prov.model) + '</b>' : '');
    } else {
      els.engineHint.textContent = '尚未启用任何引擎，请到设置中配置';
    }
  }

  /* ---------- UI 同步 ---------- */

  function syncUI() {
    const s = state.settings;
    els.selSource.value = s.sourceLang || 'auto';
    els.selTarget.value = s.targetLang || 'zh-CN';
    els.selEngine.value = s.activeProviderId || '';
    els.segMode.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', b.dataset.v === s.displayMode);
    });
    els.btnToggle.setAttribute('aria-checked', String(!!state.pageOn));
    els.toggleCard.classList.toggle('on', !!state.pageOn);
    els.toggleSub.textContent = state.pageOn
      ? '本页已开启 · 点击还原原文'
      : '点击开启，再次点击还原';
  }

  /* ---------- 事件 ---------- */

  async function patch(diff) {
    state.settings = LF_MERGE(state.settings, diff);
    await chrome.storage.sync.set({ settings: state.settings });
  }

  function sendToTab(msg) {
    return new Promise((resolve) => {
      if (!state.tab || state.tab.id == null) return resolve(null);
      try {
        chrome.tabs.sendMessage(state.tab.id, msg, (r) => {
          void chrome.runtime.lastError;
          resolve(r || null);
        });
      } catch (e) { resolve(null); }
    });
  }

  function bindEvents() {
    els.btnOptions.addEventListener('click', () => {
      try { chrome.runtime.openOptionsPage(); } catch (e) { /* noop */ }
    });
    els.btnManage.addEventListener('click', (e) => {
      e.preventDefault();
      try { chrome.runtime.openOptionsPage(); } catch (e2) { /* noop */ }
    });

    els.btnToggle.addEventListener('click', async () => {
      if (!state.pageAvailable) return;
      const target = !state.pageOn;
      const r = await sendToTab({ type: 'lf:toggle', value: target });
      if (r && r.ok) {
        state.pageOn = !!r.on;
      } else {
        state.pageOn = target; // 乐观更新
      }
      syncUI();
    });

    els.btnLive.addEventListener('click', async () => {
      if (window.__LF_PREVIEW__) { state.live = !state.live; syncLiveUI(); return; }
      els.btnLive.disabled = true;
      // 弹窗由「点击工具栏图标」唤起，满足 tabCapture 对用户手势的要求
      const r = await send({ type: 'lf:toggleLive', tabId: state.tab ? state.tab.id : undefined });
      els.btnLive.disabled = false;
      if (r && r.ok) {
        state.live = !!r.live;
        state.liveErr = '';
      } else {
        state.live = false;
        state.liveErr = (r && r.error) || '启动失败，请检查 设置 → 视频直播 中的语音转写引擎';
      }
      syncLiveUI();
    });

    els.selSource.addEventListener('change', () => patch({ sourceLang: els.selSource.value }));
    els.selTarget.addEventListener('change', () => patch({ targetLang: els.selTarget.value }));
    els.selEngine.addEventListener('change', () => patch({ activeProviderId: els.selEngine.value }));

    els.btnSwap.addEventListener('click', async () => {
      const s = state.settings;
      let src = s.sourceLang;
      let tgt = s.targetLang;
      if (src === 'auto') src = 'en'; // 无法与 auto 交换，退化为 en
      await patch({ sourceLang: tgt, targetLang: src });
      syncUI();
    });

    els.segMode.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => patch({ displayMode: b.dataset.v }));
    });
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  document.addEventListener('DOMContentLoaded', init, { once: true });
})();
