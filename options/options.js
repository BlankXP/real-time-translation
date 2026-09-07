/* BPFlow — 设置页逻辑 */
/* global LF, LF_DEFAULTS, LF_MERGE, LF_PRESETS, LF_VOICE_PRESETS,
   LF_BAILIAN_MODELS, LF_BAILIAN_MODEL, LF_MIGRATE_VOICE, LF_MIGRATE_SETTINGS, LF_RESOLVE_VOICE */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  let S = null;            // 当前设置
  let editingId = null;    // 正在编辑的引擎 id（null = 新增）
  let dlgType = 'openai';  // 对话框当前引擎类型

  /* ==================== 基础 ==================== */

  async function load() {
    const o = await chrome.storage.sync.get('settings');
    S = LF_MIGRATE_SETTINGS(LF_MERGE(LF_DEFAULTS, (o && o.settings) || {}));
  }
  async function save() {
    await chrome.storage.sync.set({ settings: S });
  }

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; resolve(r || null); });
      } catch (e) { resolve(null); }
    });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  let toastTimer = null;
  function toast(text, kind) {
    const el = $('toast');
    el.textContent = text;
    el.className = 'toast ' + (kind || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast hidden'; }, 3200);
  }

  function allLangs() {
    return [].concat(LF.LANGS, (S && S.customLangs) || []);
  }

  /* ==================== 导航 ==================== */

  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + btn.dataset.tab));
    });
  });

  /* ==================== Tab 1: 引擎模型 ==================== */

  function providerMeta(p) {
    const meta = LF.ENGINES[p.type] || {};
    if (p.type === 'openai') {
      return esc(p.baseUrl || '未配置接口地址') + (p.model ? ' · <b>' + esc(p.model) + '</b>' : '')
        + (p.apiKey ? ' · 🔑 已配置密钥' : ' · <b style="color:#fbbf24">未配置密钥</b>');
    }
    if (p.type === 'deepl') {
      return (p.plan === 'pro' ? 'Pro 版接口' : '免费版接口')
        + (p.apiKey ? ' · 🔑 已配置密钥' : ' · <b style="color:#fbbf24">未配置密钥</b>');
    }
    return esc(meta.desc || '');
  }

  function renderProviders() {
    const wrap = $('provider-list');
    const enabledCount = S.providers.filter((p) => p.enabled !== false).length;

    wrap.innerHTML = S.providers.map((p) => {
      const meta = LF.ENGINES[p.type] || {};
      const isActive = p.id === S.activeProviderId;
      const isFree = p.type === 'bing-free' || p.type === 'google-free' || p.type === 'mymemory';
      return `
        <div class="provider-card ${isActive ? 'active' : ''} ${p.enabled === false ? 'disabled' : ''}" data-id="${esc(p.id)}">
          <button class="pv-radio" title="设为当前引擎" data-act="use"></button>
          <div class="pv-main">
            <div class="pv-top">
              <span class="pv-name">${esc(p.name)}</span>
              <span class="pv-tag ${isFree ? 'free' : ''}">${esc(meta.tag || p.type)}</span>
              ${isActive ? '<span class="pv-active-tag">当前使用</span>' : ''}
            </div>
            <div class="pv-meta">${providerMeta(p)}</div>
            <div class="pv-test" data-role="test"></div>
          </div>
          <div class="pv-actions">
            <button class="btn ghost mini" data-act="test">测试</button>
            <button class="icon-btn" data-act="edit" title="编辑">
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none"><path d="M11.3 2.2l2.5 2.5L5.5 13H3v-2.5zM9.8 3.7l2.5 2.5" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>
            </button>
            <button class="switch ${p.enabled !== false ? 'on' : ''}" data-act="toggle" title="${p.enabled !== false ? '停用' : '启用'}"><span class="knob"></span></button>
            <button class="icon-btn" data-act="del" title="删除">
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none"><path d="M3 4.5h10M6.5 4V2.8h3V4M5 4.5l.5 9h5l.5-9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
          </div>
        </div>`;
    }).join('');

    // 事件委托
    wrap.querySelectorAll('.provider-card').forEach((card) => {
      const id = card.dataset.id;
      card.addEventListener('click', async (e) => {
        const actBtn = e.target.closest('[data-act]');
        if (!actBtn) return;
        const act = actBtn.dataset.act;
        const p = S.providers.find((x) => x.id === id);
        if (!p) return;

        if (act === 'use') {
          p.enabled = true;
          S.activeProviderId = id;
          await save(); renderProviders();
        } else if (act === 'toggle') {
          const turningOn = p.enabled === false;
          if (!turningOn) {
            const others = S.providers.filter((x) => x.id !== id && x.enabled !== false);
            if (!others.length) return toast('至少需要保留一个启用的引擎', 'err');
            if (S.activeProviderId === id) S.activeProviderId = others[0].id;
          } else if (S.providers.filter((x) => x.enabled !== false).length === 0) {
            S.activeProviderId = id;
          }
          p.enabled = turningOn;
          await save(); renderProviders();
        } else if (act === 'edit') {
          openDialog(p);
        } else if (act === 'del') {
          if (S.providers.length <= 1) return toast('至少需要保留一个引擎', 'err');
          if (!confirm('确定删除引擎「' + p.name + '」吗？')) return;
          S.providers = S.providers.filter((x) => x.id !== id);
          if (S.activeProviderId === id) {
            const first = S.providers.find((x) => x.enabled !== false) || S.providers[0];
            S.activeProviderId = first.id;
          }
          await save(); renderProviders(); toast('已删除');
        } else if (act === 'test') {
          testProvider(id, card.querySelector('[data-role="test"]'));
        }
      });
    });
  }

  async function testProvider(id, lineEl) {
    lineEl.textContent = '正在测试连接…';
    lineEl.className = 'pv-test loading';
    const r = await send({ type: 'lf:testProvider', providerId: id });
    if (!r) {
      lineEl.textContent = '✕ 后台服务不可用（浏览器预览模式下无法测试）';
      lineEl.className = 'pv-test err';
      return;
    }
    if (r.ok) {
      lineEl.textContent = '✓ 连接成功 · ' + r.ms + 'ms · ' + r.sample;
      lineEl.className = 'pv-test ok';
    } else {
      lineEl.textContent = '✕ ' + (r.error || '测试失败');
      lineEl.className = 'pv-test err';
    }
  }

  /* ---------- 引擎对话框 ---------- */

  const dlg = () => $('dlg-provider');

  function openDialog(p) {
    editingId = p ? p.id : null;
    dlgType = p ? p.type : 'openai';
    $('dlg-title').textContent = p ? '编辑引擎' : '添加引擎';
    $('f-name').value = p ? p.name : '';
    $('f-baseurl').value = p ? (p.baseUrl || '') : '';
    $('f-model').value = p ? (p.model || '') : '';
    $('f-apikey').value = p ? (p.apiKey || '') : '';
    $('f-temp').value = p && p.temperature != null ? p.temperature : 0.1;
    $('f-prompt').value = p ? (p.promptTemplate || '') : '';
    $('f-deepl-key').value = p && p.type === 'deepl' ? (p.apiKey || '') : '';

    renderPresets();
    syncDialogType();
    dlg().showModal();
  }

  function renderPresets() {
    $('dlg-presets').innerHTML = LF_PRESETS.map((pr) =>
      '<button type="button" class="preset-chip" data-id="' + esc(pr.id) + '">' + esc(pr.name) + '</button>'
    ).join('');
    $('dlg-presets').querySelectorAll('.preset-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const pr = LF_PRESETS.find((x) => x.id === chip.dataset.id);
        if (!pr) return;
        $('f-baseurl').value = pr.baseUrl;
        $('f-model').value = pr.model;
        $('f-apikey').value = pr.apiKeyHint || $('f-apikey').value;
        if (!$('f-name').value || editingId === null) $('f-name').value = pr.name;
        chip.parentElement.querySelectorAll('.preset-chip').forEach((c) => c.classList.toggle('active', c === chip));
      });
    });
  }

  function syncDialogType() {
    $('dlg-types').querySelectorAll('.type-card').forEach((b) => {
      b.classList.toggle('active', b.dataset.type === dlgType);
    });
    $('dlg-openai-only').classList.toggle('hidden', dlgType !== 'openai');
    $('dlg-deepl-only').classList.toggle('hidden', dlgType !== 'deepl');
  }

  $('dlg-types').addEventListener('click', (e) => {
    const b = e.target.closest('.type-card');
    if (!b) return;
    dlgType = b.dataset.type;
    syncDialogType();
  });

  $('btn-eye').addEventListener('click', () => {
    const inp = $('f-apikey');
    inp.type = inp.type === 'password' ? 'text' : 'password';
    $('btn-eye').textContent = inp.type === 'password' ? '显示' : '隐藏';
  });
  $('btn-eye-2').addEventListener('click', () => {
    const inp = $('f-deepl-key');
    inp.type = inp.type === 'password' ? 'text' : 'password';
    $('btn-eye-2').textContent = inp.type === 'password' ? '显示' : '隐藏';
  });

  $('seg-plan').querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      $('seg-plan').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    });
  });

  $('btn-add-provider').addEventListener('click', () => openDialog(null));
  $('dlg-close').addEventListener('click', () => dlg().close());
  $('dlg-cancel').addEventListener('click', () => dlg().close());

  $('dlg-save').addEventListener('click', async () => {
    const name = $('f-name').value.trim();
    let provider;

    if (dlgType === 'openai') {
      const baseUrl = $('f-baseurl').value.trim().replace(/\/+$/, '');
      const model = $('f-model').value.trim();
      if (!/^https?:\/\/.+/.test(baseUrl)) return toast('请填写合法的接口地址（以 http(s):// 开头）', 'err');
      if (!model) return toast('请填写模型名称', 'err');
      provider = {
        id: editingId || 'p' + Date.now().toString(36),
        type: 'openai',
        name: name || 'AI 模型',
        enabled: true,
        baseUrl,
        model,
        apiKey: $('f-apikey').value.trim(),
        temperature: parseFloat($('f-temp').value) || 0.1,
        promptTemplate: $('f-prompt').value.trim()
      };
    } else if (dlgType === 'deepl') {
      const apiKey = $('f-deepl-key').value.trim();
      if (!apiKey) return toast('请填写 DeepL API Key', 'err');
      provider = {
        id: editingId || 'p' + Date.now().toString(36),
        type: 'deepl',
        name: name || 'DeepL',
        enabled: true,
        apiKey,
        plan: $('seg-plan').querySelector('.active').dataset.plan
      };
    } else {
      const meta = LF.ENGINES[dlgType] || {};
      provider = {
        id: editingId || dlgType + '-' + Date.now().toString(36),
        type: dlgType,
        name: name || (meta.label || dlgType),
        enabled: true,
        builtin: true
      };
    }

    if (editingId) {
      const idx = S.providers.findIndex((p) => p.id === editingId);
      if (idx !== -1) {
        // 保留未在表单中出现的字段（如 enabled）
        provider.enabled = S.providers[idx].enabled !== false;
        S.providers[idx] = provider;
      }
    } else {
      S.providers.push(provider);
    }
    if (S.providers.filter((p) => p.enabled !== false).length === 1) {
      S.activeProviderId = provider.id;
    }
    await save();
    renderProviders();
    buildLangSelects(); // 引擎变化可能影响提示
    dlg().close();
    toast(editingId ? '引擎已更新' : '引擎已添加', 'ok');
  });

  /* ==================== Tab 2: 语言 ==================== */

  function buildLangSelects() {
    const all = allLangs();
    const name = (c) => { const l = all.find((x) => x.code === c); return l ? (l.name || l.label) : c; };
    const opt = (c) => '<option value="' + esc(c) + '">' + esc(name(c)) + '</option>';

    const withAuto = all.filter((l) => l.code !== 'auto');
    $('opt-source').innerHTML = opt('auto') + withAuto.map((l) => opt(l.code)).join('');
    $('opt-target').innerHTML = withAuto.map((l) => opt(l.code)).join('');
    $('opt-source').value = S.sourceLang || 'auto';
    $('opt-target').value = S.targetLang || 'zh-CN';
  }

  function renderLangChips() {
    const all = allLangs().filter((l) => l.code !== 'auto');
    const quick = S.quickLangs || [];
    $('lang-chips').innerHTML = all.map((l) => {
      const on = quick.includes(l.code);
      return '<button class="chip ' + (on ? 'on' : '') + '" data-code="' + esc(l.code) + '">'
        + esc(l.name || l.label) + '<span class="code">' + esc(l.code) + '</span></button>';
    }).join('');
    $('lang-chips').querySelectorAll('.chip').forEach((chip) => {
      chip.addEventListener('click', async () => {
        const code = chip.dataset.code;
        let quick = S.quickLangs || [];
        if (quick.includes(code)) {
          if (quick.length <= 1) return toast('至少保留一个常用语言', 'err');
          quick = quick.filter((c) => c !== code);
        } else {
          quick.push(code);
        }
        S.quickLangs = quick;
        await save(); renderLangChips();
      });
    });
  }

  function renderCustomLangs() {
    const list = S.customLangs || [];
    const wrap = $('custom-lang-list');
    wrap.innerHTML = list.length ? list.map((l) =>
      '<div class="custom-lang-item"><b>' + esc(l.name || l.label) + '</b>'
      + '<span class="code">' + esc(l.code) + '</span>'
      + '<span style="flex:1"></span>'
      + '<button class="icon-btn" data-code="' + esc(l.code) + '" title="删除">✕</button></div>'
    ).join('') : '<div class="hint" style="margin:0 0 6px">暂无自定义语言</div>';
    wrap.querySelectorAll('.icon-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        S.customLangs = (S.customLangs || []).filter((l) => l.code !== btn.dataset.code);
        S.quickLangs = (S.quickLangs || []).filter((c) => c !== btn.dataset.code);
        if (S.targetLang === btn.dataset.code) S.targetLang = 'zh-CN';
        if (S.sourceLang === btn.dataset.code) S.sourceLang = 'auto';
        await save();
        renderCustomLangs(); renderLangChips(); buildLangSelects();
      });
    });
  }

  $('opt-swap').addEventListener('click', async () => {
    let src = S.sourceLang, tgt = S.targetLang;
    if (src === 'auto') src = 'en';
    S.sourceLang = tgt; S.targetLang = src;
    await save(); buildLangSelects();
  });
  $('opt-source').addEventListener('change', async () => { S.sourceLang = $('opt-source').value; await save(); });
  $('opt-target').addEventListener('change', async () => { S.targetLang = $('opt-target').value; await save(); });
  $('opt-auto').addEventListener('change', async () => { S.autoTranslate = $('opt-auto').checked; await save(); });

  $('btn-add-lang').addEventListener('click', async () => {
    const code = $('cl-code').value.trim().toLowerCase();
    const name = $('cl-name').value.trim();
    if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(code)) return toast('语言代码格式不正确，例如：km、zh-TW、pt-BR', 'err');
    if (!name) return toast('请填写显示名称', 'err');
    if (allLangs().some((l) => l.code === code)) return toast('该语言已存在', 'err');
    S.customLangs = (S.customLangs || []).concat([{ code, label: code, name }]);
    $('cl-code').value = ''; $('cl-name').value = '';
    await save();
    renderCustomLangs(); renderLangChips(); buildLangSelects();
    toast('已添加 ' + name, 'ok');
  });

  /* ==================== Tab 3: 显示效果 ==================== */

  function renderDisplay() {
    document.querySelectorAll('.mode-card').forEach((c) => {
      c.classList.toggle('active', c.dataset.mode === S.displayMode);
    });
    const color = (S.style && S.style.color) || '';
    $('opt-color').value = /^#[0-9a-f]{6}$/i.test(color) ? color : '#6a72ff';
    document.querySelectorAll('.swatch').forEach((s) => {
      s.classList.toggle('on', s.dataset.c === color);
    });
    $('opt-fontsize').value = (S.style && S.style.fontSize) || 95;
    $('font-size-val').textContent = $('opt-fontsize').value + '%';
    $('opt-badge').checked = !(S.style && S.style.showBadge === false);
    $('opt-selbar').checked = S.selectionToolbar !== false;
    updatePreview();
  }

  function updatePreview() {
    const t = $('pv-trans');
    const st = S.style || {};
    t.style.color = st.color || '';
    t.style.fontSize = ((st.fontSize || 95) / 100) + 'em';
    t.classList.toggle('no-badge', st.showBadge === false);
  }

  document.querySelectorAll('.mode-card').forEach((c) => {
    c.addEventListener('click', async () => {
      S.displayMode = c.dataset.mode;
      await save(); renderDisplay();
    });
  });

  document.querySelectorAll('.swatch').forEach((s) => {
    s.addEventListener('click', async () => {
      S.style = Object.assign({}, S.style, { color: s.dataset.c });
      await save(); renderDisplay();
    });
  });

  $('opt-color').addEventListener('change', async () => {
    S.style = Object.assign({}, S.style, { color: $('opt-color').value });
    await save(); renderDisplay();
  });

  $('opt-fontsize').addEventListener('input', async () => {
    S.style = Object.assign({}, S.style, { fontSize: parseInt($('opt-fontsize').value, 10) || 95 });
    $('font-size-val').textContent = $('opt-fontsize').value + '%';
    updatePreview();
    clearTimeout($('opt-fontsize')._t);
    $('opt-fontsize')._t = setTimeout(save, 300);
  });

  $('opt-badge').addEventListener('change', async () => {
    S.style = Object.assign({}, S.style, { showBadge: $('opt-badge').checked });
    await save(); updatePreview();
  });

  $('opt-selbar').addEventListener('change', async () => {
    S.selectionToolbar = $('opt-selbar').checked;
    await save();
  });

  /* ==================== Tab 4: 高级设置 ==================== */

  function fillRange(input) {
    const min = parseFloat(input.min), max = parseFloat(input.max), v = parseFloat(input.value);
    input.style.setProperty('--fill', ((v - min) / (max - min) * 100) + '%');
  }

  function renderAdvanced() {
    const a = S.advanced;
    $('opt-concurrency').value = a.concurrency;
    $('concurrency-val').textContent = a.concurrency;
    fillRange($('opt-concurrency'));
    $('opt-minlen').value = a.minTextLength;
    $('opt-maxunits').value = a.maxUnits;
    $('opt-cache').checked = a.cacheEnabled !== false;
    renderSiteLists();
    refreshCacheStats();
  }

  async function refreshCacheStats() {
    const r = await send({ type: 'lf:cacheStats' });
    $('cache-stats').textContent = r && r.ok
      ? '已缓存 ' + r.size + ' 条译文'
      : '已缓存 — 条译文（后台服务休眠中，使用后自动统计）';
  }

  $('opt-concurrency').addEventListener('input', async () => {
    S.advanced.concurrency = parseInt($('opt-concurrency').value, 10) || 4;
    $('concurrency-val').textContent = S.advanced.concurrency;
    fillRange($('opt-concurrency'));
    clearTimeout($('opt-concurrency')._t);
    $('opt-concurrency')._t = setTimeout(save, 300);
  });
  $('opt-minlen').addEventListener('change', async () => {
    S.advanced.minTextLength = Math.max(1, parseInt($('opt-minlen').value, 10) || 2);
    $('opt-minlen').value = S.advanced.minTextLength;
    await save();
  });
  $('opt-maxunits').addEventListener('change', async () => {
    S.advanced.maxUnits = Math.max(50, parseInt($('opt-maxunits').value, 10) || 600);
    $('opt-maxunits').value = S.advanced.maxUnits;
    await save();
  });
  $('opt-cache').addEventListener('change', async () => {
    S.advanced.cacheEnabled = $('opt-cache').checked;
    await save();
  });
  $('btn-clear-cache').addEventListener('click', async () => {
    const r = await send({ type: 'lf:clearCache' });
    toast(r && r.ok ? '缓存已清除' : '后台服务不可用', r && r.ok ? 'ok' : 'err');
    refreshCacheStats();
  });

  /* ---------- 站点规则 ---------- */

  function renderSiteLists() {
    const autoSites = Object.keys(S.siteRules || {}).filter((h) => S.siteRules[h] && S.siteRules[h].auto);
    const black = S.blacklist || [];

    const tagHtml = (list, cls) => list.length
      ? list.map((h) => '<span class="tag ' + cls + '" data-h="' + esc(h) + '">' + esc(h) + '<button title="移除">✕</button></span>').join('')
      : '<span class="empty">暂无</span>';

    $('auto-site-list').innerHTML = tagHtml(autoSites, 'auto');
    $('black-site-list').innerHTML = tagHtml(black, 'black');

    const bind = (wrapId, isAuto) => {
      $(wrapId).querySelectorAll('.tag button').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const h = btn.parentElement.dataset.h;
          if (isAuto) {
            const rules = Object.assign({}, S.siteRules);
            delete rules[h];
            S.siteRules = rules;
          } else {
            S.blacklist = S.blacklist.filter((x) => x !== h);
          }
          await save(); renderSiteLists();
        });
      });
    };
    bind('auto-site-list', true);
    bind('black-site-list', false);
  }

  function normalizeHost(v) {
    return String(v || '').trim().toLowerCase()
      .replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  }

  $('btn-add-auto-site').addEventListener('click', async () => {
    const h = normalizeHost($('site-auto-input').value);
    if (!h || !h.includes('.')) return toast('请输入有效的域名，例如 example.com', 'err');
    const rules = Object.assign({}, S.siteRules);
    rules[h] = Object.assign({}, rules[h], { auto: true });
    S.siteRules = rules;
    $('site-auto-input').value = '';
    await save(); renderSiteLists();
  });
  $('btn-add-black-site').addEventListener('click', async () => {
    const h = normalizeHost($('site-black-input').value);
    if (!h || !h.includes('.')) return toast('请输入有效的域名，例如 example.com', 'err');
    if (!S.blacklist.includes(h)) S.blacklist = S.blacklist.concat([h]);
    $('site-black-input').value = '';
    await save(); renderSiteLists();
  });

  /* ---------- 导入导出 ---------- */

  $('btn-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'bpflow-settings.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  $('btn-import').addEventListener('click', () => $('file-import').click());
  $('file-import').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const data = JSON.parse(String(reader.result));
        if (!data || !Array.isArray(data.providers)) throw new Error('格式不正确');
        S = LF_MIGRATE_SETTINGS(LF_MERGE(LF_DEFAULTS, data));
        await save();
        renderAll();
        toast('设置已导入', 'ok');
      } catch (err) {
        toast('导入失败：' + err.message, 'err');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  $('btn-reset').addEventListener('click', async () => {
    if (!confirm('确定恢复全部默认设置吗？引擎配置与站点规则都会被重置（API Key 将丢失）。')) return;
    S = JSON.parse(JSON.stringify(LF_DEFAULTS));
    await save();
    renderAll();
    toast('已恢复默认设置', 'ok');
  });

  /* ==================== Tab 5: 视频直播 ==================== */

  const VOICE_LANGS = [
    ['auto', '自动检测'], ['en', '英语'], ['zh', '中文'], ['ja', '日语'], ['ko', '韩语'],
    ['de', '德语'], ['fr', '法语'], ['es', '西班牙语'], ['ru', '俄语'], ['pt', '葡萄牙语'],
    ['it', '意大利语'], ['vi', '越南语'], ['th', '泰语'], ['id', '印尼语'], ['ar', '阿拉伯语'], ['hi', '印地语']
  ];

  function renderVideoTab() {
    $('opt-video').checked = S.videoSubtitle.enabled !== false;
    $('opt-video-bi').checked = S.videoSubtitle.bilingual !== false;

    // 旧版单套配置 → 双配置迁移后统一按新结构渲染
    const v = (S.voice = LF_MIGRATE_VOICE(S.voice) || LF_MIGRATE_VOICE(LF_DEFAULTS.voice));
    const engine = v.engine === 'openai' ? 'openai' : 'bailian';
    const bl = v.bailian || {};
    const oa = v.openai || {};

    $('v-seg-engine').querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', b.dataset.v === engine);
    });
    $('v-bailian-block').classList.toggle('hidden', engine !== 'bailian');
    $('v-openai-block').classList.toggle('hidden', engine !== 'openai');

    /* ---------- 阿里云百炼 ---------- */
    const models = LF_BAILIAN_MODELS;
    const sel = $('v-bl-model');
    if (!sel.dataset.built) {
      sel.innerHTML = '<optgroup label="普通模型（非实时）">'
        + models.map((m) => '<option value="' + esc(m.id) + '">' + esc(m.id) + '</option>').join('')
        + '</optgroup>';
      sel.dataset.built = '1';
    }
    const model = LF_BAILIAN_MODEL(bl.model);
    sel.value = model.id;
    // 自动推导的接口地址（只读展示）+ 模型说明
    $('v-bl-baseurl').value = model.baseUrl;
    const asyncModel = model.protocol === 'paraformer-async';
    $('v-bl-note').textContent = (model.note || '') + '，采样率 ' + model.sampleRate + 'Hz';
    $('v-bl-note').className = asyncModel ? 'hint warn' : 'hint';
    $('v-bl-baseurl-hint').textContent = asyncModel
      ? '⚠ ' + model.id + ' 走「录音文件识别」异步接口，只接受公网可访问的音频 URL，无法用于本扩展的浏览器端实时转写；请改用 fun-asr-flash-2026-06-15'
      : '非实时：请求路径 /services/aigc/multimodal-generation/generation';
    $('v-bl-baseurl-hint').className = asyncModel ? 'hint warn' : 'hint';
    $('v-bl-baseurl-custom').value = String(bl.baseUrl || '').trim() === '' ? '' : String(bl.baseUrl);
    $('v-bl-apikey').value = bl.apiKey || '';

    /* ---------- OpenAI 兼容 ---------- */
    $('v-oa-baseurl').value = oa.baseUrl || '';
    $('v-oa-model').value = oa.model || '';
    $('v-oa-apikey').value = oa.apiKey || '';
    $('v-presets').innerHTML = LF_VOICE_PRESETS.map((p) =>
      '<button type="button" class="preset-chip'
      + (p.baseUrl === oa.baseUrl && p.model === oa.model ? ' active' : '')
      + '" data-id="' + esc(p.id) + '">' + esc(p.name) + '</button>'
    ).join('');
    $('v-presets').querySelectorAll('.preset-chip').forEach((chip) => {
      chip.addEventListener('click', async () => {
        const p = LF_VOICE_PRESETS.find((x) => x.id === chip.dataset.id);
        if (!p) return;
        S.voice = LF_MIGRATE_VOICE(Object.assign({}, S.voice, {
          openai: { baseUrl: p.baseUrl, model: p.model, apiKey: (S.voice.openai || {}).apiKey || '' }
        }));
        await save();
        renderVideoTab();
      });
    });

    // 同步画面开关 + 同步延迟滑杆（0.5s 步进，0-30s，显示为「关闭 / x.xs」）
    $('v-syncvideo').checked = !!v.syncVideo;
    const delayMs = Math.max(0, Math.min(30000, v.playbackDelayMs || 0));
    $('v-delay').value = String(Math.round(delayMs / 500) / 2);
    $('v-delay-val').textContent = delayMs ? (Math.round(delayMs / 100) / 10) + ' 秒' : '关闭';
    // 画面延迟微调滑杆（±3s，0.25s 步进，显示为「±0 / -1.25s / +0.5s」）
    const trimMs = Math.max(-3000, Math.min(3000, v.videoDelayTrimMs || 0));
    $('v-vtrim').value = String(Math.round(trimMs / 250) * 0.25);
    const trimS = Math.round(trimMs / 100) / 10;
    $('v-vtrim-val').textContent = trimMs ? (trimMs > 0 ? '+' : '') + trimS + 's' : '±0';
    if (!$('v-lang').options.length) {
      $('v-lang').innerHTML = VOICE_LANGS.map((l) =>
        '<option value="' + esc(l[0]) + '">' + esc(l[1]) + '</option>').join('');
    }
    $('v-lang').value = v.lang || 'auto';
  }

  /** voice 局部更新（自动补迁移，保证两侧配置始终完整） */
  function patchVoice(patch) {
    S.voice = LF_MIGRATE_VOICE(Object.assign({}, S.voice, patch));
  }

  $('v-seg-engine').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    patchVoice({ engine: b.dataset.v === 'openai' ? 'openai' : 'bailian' });
    await save(); renderVideoTab();
  });

  $('v-bl-model').addEventListener('change', async () => {
    const cur = (S.voice && S.voice.bailian) || {};
    patchVoice({ bailian: Object.assign({}, cur, { model: $('v-bl-model').value }) });
    await save(); renderVideoTab();
  });
  // 自定义接口地址（专属端点）：留空表示按模型自动推导
  $('v-bl-baseurl-custom').addEventListener('change', async () => {
    const cur = (S.voice && S.voice.bailian) || {};
    const val = $('v-bl-baseurl-custom').value.trim().replace(/\/+$/, '');
    if (val && val.includes('{WorkspaceId}')) {
      toast('请把 {WorkspaceId} 替换为真实业务空间 ID', 'err');
    }
    patchVoice({ bailian: Object.assign({}, cur, { baseUrl: val }) });
    await save(); renderVideoTab();
  });
  $('v-bl-apikey').addEventListener('change', async () => {
    const cur = (S.voice && S.voice.bailian) || {};
    patchVoice({ bailian: Object.assign({}, cur, { apiKey: $('v-bl-apikey').value.trim() }) });
    await save();
  });

  $('v-oa-baseurl').addEventListener('change', async () => {
    const cur = (S.voice && S.voice.openai) || {};
    patchVoice({ openai: Object.assign({}, cur, { baseUrl: $('v-oa-baseurl').value.trim().replace(/\/+$/, '') }) });
    await save(); renderVideoTab();
  });
  $('v-oa-model').addEventListener('change', async () => {
    const cur = (S.voice && S.voice.openai) || {};
    patchVoice({ openai: Object.assign({}, cur, { model: $('v-oa-model').value.trim() }) });
    await save(); renderVideoTab();
  });
  $('v-oa-apikey').addEventListener('change', async () => {
    const cur = (S.voice && S.voice.openai) || {};
    patchVoice({ openai: Object.assign({}, cur, { apiKey: $('v-oa-apikey').value.trim() }) });
    await save();
  });
  $('v-syncvideo').addEventListener('change', async () => {
    S.voice = Object.assign({}, S.voice, { syncVideo: $('v-syncvideo').checked });
    await save();
  });
  // 画面延迟微调：拖动实时更新标签，松手保存
  $('v-vtrim').addEventListener('input', () => {
    const s = parseFloat($('v-vtrim').value) || 0;
    $('v-vtrim-val').textContent = s ? (s > 0 ? '+' : '') + s + 's' : '±0';
  });
  $('v-vtrim').addEventListener('change', async () => {
    const s = parseFloat($('v-vtrim').value) || 0;
    S.voice = Object.assign({}, S.voice, { videoDelayTrimMs: Math.round(s * 1000) });
    await save();
  });
  // 同步延迟：拖动实时更新标签，松手保存
  $('v-delay').addEventListener('input', () => {
    const s = parseFloat($('v-delay').value) || 0;
    $('v-delay-val').textContent = s ? s + ' 秒' : '关闭';
  });
  $('v-delay').addEventListener('change', async () => {
    const s = parseFloat($('v-delay').value) || 0;
    S.voice = Object.assign({}, S.voice, { playbackDelayMs: Math.round(s * 1000) });
    await save();
  });

  $('opt-video').addEventListener('change', async () => {
    S.videoSubtitle = Object.assign({}, S.videoSubtitle, { enabled: $('opt-video').checked });
    await save();
  });
  $('opt-video-bi').addEventListener('change', async () => {
    S.videoSubtitle = Object.assign({}, S.videoSubtitle, { bilingual: $('opt-video-bi').checked });
    await save();
  });
  $('v-lang').addEventListener('change', async () => {
    S.voice = LF_MIGRATE_VOICE(Object.assign({}, S.voice, { lang: $('v-lang').value }));
    await save();
  });
  /** 密钥显示/隐藏切换（百炼与 OpenAI 两套各自独立） */
  [['v-bl-eye', 'v-bl-apikey'], ['v-oa-eye', 'v-oa-apikey']].forEach((pair) => {
    const btn = $(pair[0]);
    if (!btn) return;
    btn.addEventListener('click', () => {
      const inp = $(pair[1]);
      inp.type = inp.type === 'password' ? 'text' : 'password';
      btn.textContent = inp.type === 'password' ? '显示' : '隐藏';
    });
  });

  /* ==================== 总渲染 / 启动 ==================== */

  function renderAll() {
    renderProviders();
    buildLangSelects();
    renderLangChips();
    renderCustomLangs();
    $('opt-auto').checked = !!S.autoTranslate;
    renderDisplay();
    renderVideoTab();
    renderAdvanced();
  }

  async function init() {
    if (window.__LF_PREVIEW__) $('preview-badge').classList.remove('hidden');
    try {
      const m = chrome.runtime.getManifest();
      $('ver').textContent = m.version;
      $('about-ver').textContent = m.version;
    } catch (e) { /* noop */ }

    await load();
    renderAll();

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !changes.settings) return;
      S = LF_MERGE(LF_DEFAULTS, changes.settings.newValue || {});
      if (!dlg().open) renderAll();
    });
  }

  document.addEventListener('DOMContentLoaded', init, { once: true });
})();
