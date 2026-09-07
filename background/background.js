/*
 * BPFlow — Background Service Worker (MV3)
 * 职责：翻译引擎适配 / 批量调度与并发控制 / 译文缓存 / 快捷键 / 右键菜单
 */
/* global LF, LF_DEFAULTS, LF_MERGE, LF_RESOLVE_VOICE, LF_MIGRATE_SETTINGS */
importScripts('../shared/langs.js', '../shared/defaults.js');
/* 注：MV3 Service Worker 默认严格模式 */

/* ============================== 设置 ============================== */

async function getSettings() {
  const o = await chrome.storage.sync.get('settings');
  return LF_MIGRATE_SETTINGS(LF_MERGE(LF_DEFAULTS, (o && o.settings) || {}));
}

async function saveSettingsPatch(patch) {
  const cur = await getSettings();
  const next = LF_MERGE(cur, patch);
  await chrome.storage.sync.set({ settings: next });
  return next;
}

/* ============================== 缓存 ============================== */

let _cache = null;          // Map（LRU，插入序即访问序）
let _cacheSaveTimer = null;

function cacheKey(prov, source, target, text) {
  const id = prov.id + ':' + (prov.model || '') + ':' + source + '>' + target;
  return hashStr(id + '\u0001' + text);
}

function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + '_' + s.length.toString(36);
}

async function loadCache() {
  if (_cache) return _cache;
  try {
    const o = await chrome.storage.local.get('lf:cache');
    _cache = new Map(o && o['lf:cache'] ? o['lf:cache'] : []);
  } catch (e) {
    _cache = new Map();
  }
  return _cache;
}

function scheduleCacheSave() {
  if (_cacheSaveTimer) clearTimeout(_cacheSaveTimer);
  _cacheSaveTimer = setTimeout(flushCache, 1500);
}

async function flushCache() {
  if (!_cache) return;
  const max = (await getSettings()).advanced.maxCache || 800;
  while (_cache.size > max) {
    _cache.delete(_cache.keys().next().value); // 淘汰最旧
  }
  try {
    await chrome.storage.local.set({ 'lf:cache': Array.from(_cache.entries()).slice(-max) });
  } catch (e) { /* 存储满时静默 */ }
}

/* ============================== 引擎适配 ============================== */

const ENGINE_API = {
  'bing-free':   { batch: 20, maxChars: 40000 },
  'google-free': { batch: 1 },
  'mymemory':    { batch: 1, maxChars: 450 },
  'deepl':       { batch: 25, maxChars: 25000 },
  'openai':      { batch: 16, maxChars: 6000 }
};

async function fetchJSON(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 20000);
  try {
    const res = await fetch(url, Object.assign({}, options, { signal: ctrl.signal }));
    let body = null;
    const text = await res.text();
    try { body = JSON.parse(text); } catch (e) { body = text; }
    if (!res.ok) {
      const err = new Error(humanError(res.status, body));
      err.status = res.status;
      throw err;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function humanError(status, body) {
  let detail = '';
  if (body && typeof body === 'object') {
    detail = (body.error && (body.error.message || body.error.type)) || body.message || '';
  } else if (typeof body === 'string' && body.length < 200) {
    detail = body;
  }
  if (status === 401 || status === 403) return 'API Key 无效或未授权（' + (detail || status) + '）';
  if (status === 429) return '请求过于频繁，已被限流，请稍后重试';
  if (status === 404) return '接口地址或模型名不存在（' + (detail || status) + '）';
  if (status >= 500) return '翻译服务暂时不可用（HTTP ' + status + '）';
  return '请求失败：HTTP ' + status + (detail ? ' — ' + detail : '');
}

/* ---------- Bing（免费，Edge 同源接口） ---------- */

let _bingToken = null; // {token, exp}

async function bingToken() {
  const now = Date.now();
  if (_bingToken && _bingToken.exp > now + 30000) return _bingToken.token;
  const res = await fetch('https://edge.microsoft.com/translate/auth');
  if (!res.ok) throw new Error('无法获取 Bing 翻译令牌（HTTP ' + res.status + '）');
  const token = (await res.text()).trim();
  // JWT 有效期约 10 分钟，保守按 8 分钟计
  _bingToken = { token, exp: now + 8 * 60 * 1000 };
  return token;
}

async function callBing(texts, source, target) {
  const token = await bingToken();
  let url = 'https://api-edge.cognitive.microsofttranslator.com/translate?api-version=3.0&to=' + encodeURIComponent(LF.toBing(target));
  if (source && source !== 'auto') url += '&from=' + encodeURIComponent(LF.toBing(source));
  const data = await fetchJSON(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(texts.map((t) => ({ Text: t })))
  });
  if (!Array.isArray(data)) throw new Error('Bing 翻译返回格式异常');
  return data.map((item, i) => (item && item.translations && item.translations[0] && item.translations[0].text) != null
    ? item.translations[0].text : texts[i]);
}

/* ---------- Google（免费公共接口，逐句） ---------- */

async function callGoogle(text, source, target) {
  const sl = (!source || source === 'auto') ? 'auto' : source;
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t'
    + '&sl=' + encodeURIComponent(sl) + '&tl=' + encodeURIComponent(target)
    + '&q=' + encodeURIComponent(text);
  const data = await fetchJSON(url, { method: 'GET' });
  if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error('Google 翻译返回格式异常');
  return data[0].map((seg) => (seg && seg[0]) || '').join('');
}

/* ---------- MyMemory（免费，逐句，不支持 auto） ---------- */

async function callMyMemory(text, source, target) {
  const src = (!source || source === 'auto') ? LF.quickDetect(text) : source;
  const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text)
    + '&langpair=' + encodeURIComponent(src + '|' + target);
  const data = await fetchJSON(url, { method: 'GET' });
  if (data && data.responseData && data.responseData.translatedText) {
    return data.responseData.translatedText;
  }
  throw new Error('MyMemory 翻译失败');
}

/* ---------- DeepL ---------- */

async function callDeepl(prov, texts, source, target) {
  if (!prov.apiKey) throw new Error('请先在设置中填写 DeepL API Key');
  const base = prov.plan === 'pro' ? 'https://api.deepl.com' : 'https://api-free.deepl.com';
  const body = { text: texts, target_lang: LF.toDeepl(target) };
  if (source && source !== 'auto') body.source_lang = LF.toDeepl(source);
  const data = await fetchJSON(base + '/v2/translate', {
    method: 'POST',
    headers: { 'Authorization': 'DeepL-Auth-Key ' + prov.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!data || !Array.isArray(data.translations)) throw new Error('DeepL 返回格式异常');
  return data.translations.map((t, i) => (t && t.text) || texts[i]);
}

/* ---------- OpenAI 兼容（自定义模型） ---------- */

function extractJsonArray(raw) {
  if (Array.isArray(raw)) return raw;
  const s = String(raw || '').trim();
  // 剥掉 ```json 围栏
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1].trim() : s;
  const m = body.match(/\[[\s\S]*\]/);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[0]);
    return Array.isArray(arr) ? arr : null;
  } catch (e) {
    return null;
  }
}

async function callOpenAI(prov, texts, source, target) {
  if (!prov.baseUrl) throw new Error('请先在设置中填写接口地址（Base URL）');
  if (!prov.model) throw new Error('请先在设置中填写模型名称');

  const srcName = (!source || source === 'auto') ? '自动识别的源语言' : LF.langName(source);
  const tgtName = LF.langName(target);

  let sys;
  if (prov.promptTemplate && prov.promptTemplate.trim()) {
    sys = prov.promptTemplate
      .replace(/\{source\}/g, srcName)
      .replace(/\{target\}/g, tgtName)
      .replace(/\{texts\}/g, JSON.stringify(texts));
  } else {
    sys = '你是一个专业的网页翻译引擎。请将用户给出的 JSON 字符串数组中的每段文本从' + srcName + '翻译为' + tgtName
      + '。要求：忠实原意、符合' + tgtName + '表达习惯、保留专有名词与数字格式、不添加任何解释。'
      + '仅输出一个等长的 JSON 字符串数组（' + texts.length + ' 个元素），不要输出其他任何内容。';
  }

  const url = String(prov.baseUrl).replace(/\/+$/, '') + '/chat/completions';
  const data = await fetchJSON(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(prov.apiKey ? { 'Authorization': 'Bearer ' + prov.apiKey } : {})
    },
    body: JSON.stringify({
      model: prov.model,
      temperature: typeof prov.temperature === 'number' ? prov.temperature : 0.1,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: JSON.stringify(texts) }
      ]
    })
  }, 45000);

  const content = data && data.choices && data.choices[0] && data.choices[0].message
    && data.choices[0].message.content;
  const arr = extractJsonArray(content);
  if (!arr || arr.length !== texts.length) {
    // 兜底：按行拆分
    const lines = String(content || '').split(/\n+/).map((s) => s.replace(/^\s*\d+[.、)\]]\s*/, '').trim()).filter(Boolean);
    if (lines.length === texts.length) return lines;
    throw new Error('模型返回的译文数量与输入不一致（期望 ' + texts.length + '，实际 ' + (arr ? arr.length : '?') + '），请更换模型或调整提示词');
  }
  return arr.map((x) => (typeof x === 'string' ? x : x == null ? '' : String(x)));
}

/* ============================== 批量调度 ============================== */

function chunkTexts(texts, batch, maxChars) {
  const chunks = [];
  let cur = [], curLen = 0;
  for (const t of texts) {
    const len = t.length;
    if (cur.length && (cur.length >= batch || (maxChars && curLen + len > maxChars))) {
      chunks.push(cur); cur = []; curLen = 0;
    }
    cur.push(t); curLen += len;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** 并发池执行 */
async function runPool(tasks, limit) {
  const results = new Array(tasks.length);
  let idx = 0;
  const workers = new Array(Math.min(limit, tasks.length)).fill(0).map(async () => {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 核心翻译入口
 * @returns {Promise<{ok:boolean, results:?string[], error:?string, stats:object}>}
 */
async function translateTexts(texts, overrideProvider) {
  const settings = await getSettings();
  const prov = overrideProvider
    || settings.providers.find((p) => p.id === settings.activeProviderId && p.enabled !== false)
    || settings.providers.find((p) => p.enabled !== false);
  if (!prov) return { ok: false, error: '没有可用的翻译引擎，请到设置中启用或配置一个' };

  const source = settings.sourceLang || 'auto';
  const target = settings.targetLang || 'zh-CN';
  const api = ENGINE_API[prov.type] || { batch: 10 };
  const concurrency = Math.max(1, Math.min(8, settings.advanced.concurrency || 4));

  const useCache = settings.advanced.cacheEnabled !== false;
  const cache = useCache ? await loadCache() : null;

  const results = new Array(texts.length);
  const needIdx = [];   // 需要真实请求的下标
  texts.forEach((t, i) => {
    const key = cacheKey(prov, source, target, t);
    const hit = cache && cache.get(key);
    if (hit != null) {
      cache.delete(key); cache.set(key, hit); // LRU 刷新
      results[i] = hit;
    } else {
      needIdx.push(i);
    }
  });

  let fetched = 0, failed = 0;
  if (needIdx.length) {
    const needTexts = needIdx.map((i) => texts[i]);
    const chunks = chunkTexts(needTexts, api.batch, api.maxChars);

    const chunkResults = await runPool(chunks.map((chunk) => async () => {
      try {
        let out;
        if (prov.type === 'bing-free') out = await callBing(chunk, source, target);
        else if (prov.type === 'google-free') out = [await callGoogle(chunk[0], source, target)];
        else if (prov.type === 'mymemory') out = [await callMyMemory(chunk[0], source, target)];
        else if (prov.type === 'deepl') out = await callDeepl(prov, chunk, source, target);
        else if (prov.type === 'openai') out = await callOpenAI(prov, chunk, source, target);
        else throw new Error('未知引擎类型：' + prov.type);
        return { ok: true, out };
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
      }
    }), prov.type === 'openai' ? Math.min(2, concurrency) : concurrency);

    // 按序重建：chunks[i] 与 chunkResults[i] 一一对应
    let firstError = null;
    let cursor = 0;
    chunkResults.forEach((r, ci) => {
      const n = chunks[ci].length;
      for (let k = 0; k < n; k++) {
        const globalIdx = needIdx[cursor + k];
        if (r.ok) {
          const val = r.out[k] != null ? r.out[k] : null;
          results[globalIdx] = val;
          if (val != null) {
            fetched++;
            if (cache) { cache.set(cacheKey(prov, source, target, texts[globalIdx]), val); }
          } else { failed++; }
        } else {
          results[globalIdx] = null;
          failed++;
          if (!firstError) firstError = r.error;
        }
      }
      cursor += n;
    });
    if (cache && fetched) scheduleCacheSave();
    if (fetched === 0 && firstError) {
      return { ok: false, error: firstError, results: null };
    }
  }

  return {
    ok: true,
    results,
    stats: {
      engine: prov.type,
      provider: prov.name,
      model: prov.model || '',
      total: texts.length,
      cacheHits: texts.length - needIdx.length,
      fetched, failed
    }
  };
}

/* ============================== 直播语音翻译 ============================== */

/* 直播中的标签页：存 chrome.storage.session，避免 Service Worker 休眠后状态丢失 */
const LIVE_KEY = 'lf:live';

async function readLive() {
  try {
    const o = await chrome.storage.session.get(LIVE_KEY);
    return (o && o[LIVE_KEY]) || {};
  } catch (e) { return {}; }
}

async function writeLive(map) {
  try { await chrome.storage.session.set({ [LIVE_KEY]: map }); } catch (e) { /* noop */ }
}

async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument();
  if (!has) {
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: '捕获标签页音频，用于直播语音实时转写与翻译字幕'
    });
  }
}

function notifyTab(tabId, msg) {
  try {
    chrome.tabs.sendMessage(tabId, msg, () => { void chrome.runtime.lastError; });
  } catch (e) { /* noop */ }
}

/**
 * 直播链路日志：打到 SW console 并转发到直播页 console（lf:liveLog），
 * 与 offscreen 的 [LF-OFF] 日志在直播页 DevTools 汇聚成完整链路（前缀 [LF-BG]）。
 */
function liveLog(tabId, step, data) {
  let line = '[LF-BG] ' + step;
  if (data !== undefined) {
    line += ' ' + (typeof data === 'string' ? data : JSON.stringify(data));
  }
  console.log(line);
  if (tabId != null) notifyTab(tabId, { type: 'lf:liveLog', line });
}

/* ============================== 直播转写消息（分片结果：一段一段显示、一段一段翻译） ============================== */

/**
 * 解析目标标签页：
 * 优先消息显式传入（弹窗/右键菜单），其次 sender.tab（内容脚本），最后取当前活动标签页。
 */
async function resolveTabId(sender, msg) {
  if (msg && typeof msg.tabId === 'number') return msg.tabId;
  if (sender && sender.tab && sender.tab.id != null) return sender.tab.id;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return (tabs && tabs[0] && tabs[0].id != null) ? tabs[0].id : null;
  } catch (e) { return null; }
}

/** tabCapture 的错误对用户几乎不可读，转换为可执行建议 */
function friendlyCaptureError(raw) {
  const s = String(raw || '');
  if (/not been invoked|activeTab/i.test(s)) {
    return '浏览器安全要求：需先「唤起」扩展才能捕获页面声音。请通过工具栏弹窗、右键菜单或 Alt+Shift+L 启动直播字幕';
  }
  if (/active stream|already captur/i.test(s)) {
    return '本页已有未释放的音频捕获（常见于扩展重载或上一次会话异常退出）。请刷新本页（F5）后重新开启直播字幕';
  }
  if (/Chrome pages|chrome:\/\//i.test(s)) {
    return '浏览器内部页面（chrome:// 等）无法捕获声音，请在普通网页上使用';
  }
  return s;
}

/* 并发启动锁：防止弹窗与快捷键同时触发导致双重捕获（第二次会报 active stream） */
const startingLive = new Set();

/**
 * 针对指定标签页启动直播字幕（含并发锁）。
 * 注意：必须由扩展自身的用户手势链路发起（action 点击 / 右键菜单 / 快捷键），
 * 内容脚本发起的调用不满足 tabCapture 的「唤起」要求。
 */
async function startLiveForTab(tabId) {
  // 并发锁：弹窗与快捷键同时触发时，第二次直接拒绝而不是双重捕获报错
  if (startingLive.has(tabId)) return { ok: false, error: '正在启动直播翻译，请勿重复操作' };
  startingLive.add(tabId);
  try {
    return await startLiveForTabInner(tabId);
  } finally {
    startingLive.delete(tabId);
  }
}

async function startLiveForTabInner(tabId) {
  const live = await readLive();
  if (live[tabId]) return { ok: false, error: '本页直播翻译已在进行中' };

  const settings = await getSettings();
  // 双配置（阿里云百炼 / OpenAI 兼容）→ 解析出运行时扁平配置：
  // 百炼侧按所选模型自动推导 protocol / baseUrl / sampleRate
  let voice = LF_RESOLVE_VOICE(settings.voice);
  liveLog(tabId, '开始启动直播翻译：转写引擎 ' + (voice.engine === 'bailian' ? '阿里云百炼' : 'OpenAI 兼容')
    + ' ' + (voice.baseUrl || '(未配置)')
    + '，protocol=' + (voice.protocol || 'openai') + '，model=' + (voice.model || '(默认)')
    + '，apiKey=' + (voice.apiKey ? '***' + String(voice.apiKey).slice(-4) : '未填写'));
  if (!voice.baseUrl) {
    liveLog(tabId, '启动中止：未配置转写引擎 baseUrl');
    return { ok: false, error: '请先在 设置 → 视频直播 中配置语音转写引擎' };
  }
  // paraformer-v1 / v2 为「录音文件识别」异步接口，只接受公网音频 URL，浏览器端实时链路用不了
  if (voice.protocol === 'paraformer-async') {
    liveLog(tabId, '启动中止：所选模型 ' + voice.model + ' 为异步录音文件转写，需公网音频 URL');
    return {
      ok: false,
      error: '模型 ' + voice.model + ' 走百炼「录音文件识别」异步接口，只接受公网可访问的音频 URL，无法用于浏览器端实时转写。'
        + '请到 设置 → 视频直播 改用 fun-asr-flash-2026-06-15'
    };
  }
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(voice.baseUrl)
    || /^wss?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(voice.baseUrl);
  if (!voice.apiKey && !isLocal) {
    liveLog(tabId, '启动中止：非本地引擎缺少 API Key');
    return { ok: false, error: '语音转写需要 API Key，请到 设置 → 视频直播 填写' };
  }

  await ensureOffscreen();
  liveLog(tabId, 'offscreen 文档就绪');

  let streamId;
  try {
    streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
        const err = chrome.runtime.lastError;
        if (err || !id) reject(new Error((err && err.message) || '无法捕获本页音频'));
        else resolve(id);
      });
    });
    liveLog(tabId, '已获取页面音频捕获授权（MediaStreamId）');
  } catch (e) {
    liveLog(tabId, '音频捕获授权失败：' + ((e && e.message) || String(e)));
    return { ok: false, error: friendlyCaptureError(e && e.message) };
  }

  const r = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'lf:off:start', tabId, streamId, voice },
      (res) => { void chrome.runtime.lastError; resolve(res || null); });
  });
  liveLog(tabId, 'offscreen 捕获结果：' + JSON.stringify(r));
  if (!r || !r.ok) {
    return { ok: false, error: (r && r.error) || '音频捕获失败' };
  }

  live[tabId] = true;
  await writeLive(live);
  notifyTab(tabId, { type: 'lf:liveStarted' });
  liveLog(tabId, '直播翻译已启动 ✓（每 5 秒一片：录音→转写→翻译→上屏，日志见本页 F12 Console）');
  return { ok: true };
}

async function stopLive(tabId) {
  liveLog(tabId, '停止直播翻译');
  const live = await readLive();
  delete live[tabId];
  await writeLive(live);
  try {
    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'lf:off:stop', tabId },
        () => { void chrome.runtime.lastError; resolve(); });
    });
  } catch (e) { /* noop */ }
  notifyTab(tabId, { type: 'lf:liveEnd' });
}

async function toggleLiveForTab(tabId) {
  const live = await readLive();
  if (live[tabId]) {
    await stopLive(tabId);
    return { ok: true, live: false };
  }
  const r = await startLiveForTab(tabId);
  return { ok: r.ok, live: !!r.ok, error: r.error };
}

chrome.tabs.onRemoved.addListener((tabId) => {
  readLive().then((live) => {
    if (live[tabId]) stopLive(tabId);
  });
});

/**
 * SW 冷启动清理：扩展被重载后，storage.session 里的 lf:live 状态会残留，
 * 但承载捕获流的 offscreen 文档已随重载销毁。若检测到这种不一致，直接回收状态，
 * 避免下次启动误判「已在进行中」。
 */
async function cleanupStaleLive() {
  try {
    const live = await readLive();
    const ids = Object.keys(live);
    if (!ids.length) return;
    const hasOffscreen = await chrome.offscreen.hasDocument();
    if (!hasOffscreen) {
      await writeLive({});
      console.log('[LF-BG] 启动清理：回收残留直播状态 ' + ids.join(','));
    }
  } catch (e) { /* noop */ }
}
cleanupStaleLive();

/* ============================== 消息路由 ============================== */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'lf:translate': {
          const texts = (msg.texts || []).filter((t) => typeof t === 'string' && t.trim());
          if (!texts.length) return sendResponse({ ok: true, results: [], stats: { total: 0 } });
          if (texts.length > 2000) texts.length = 2000;
          const r = await translateTexts(texts);
          sendResponse(r);
          break;
        }
        case 'lf:testProvider': {
          const settings = await getSettings();
          const prov = settings.providers.find((p) => p.id === msg.providerId);
          if (!prov) return sendResponse({ ok: false, error: '未找到该引擎' });
          const t0 = Date.now();
          const r = await translateTexts(['Hello! This is a connection test.'], prov);
          const ms = Date.now() - t0;
          if (r.ok && r.results && r.results[0]) {
            sendResponse({ ok: true, sample: r.results[0], ms });
          } else {
            sendResponse({ ok: false, error: (r && r.error) || '测试失败', ms });
          }
          break;
        }
        case 'lf:openOptions':
          chrome.runtime.openOptionsPage();
          sendResponse({ ok: true });
          break;
        case 'lf:cacheStats': {
          const c = await loadCache();
          sendResponse({ ok: true, size: c.size });
          break;
        }
        case 'lf:clearCache':
          _cache = new Map();
          await chrome.storage.local.remove('lf:cache');
          sendResponse({ ok: true });
          break;
        case 'lf:startLive': {
          const tid = await resolveTabId(sender, msg);
          if (tid == null) return sendResponse({ ok: false, error: '找不到当前标签页' });
          sendResponse(await startLiveForTab(tid));
          break;
        }
        case 'lf:toggleLive': {
          const tid = await resolveTabId(sender, msg);
          if (tid == null) return sendResponse({ ok: false, error: '找不到当前标签页' });
          sendResponse(await toggleLiveForTab(tid));
          break;
        }
        case 'lf:stopLive': {
          const tid = await resolveTabId(sender, msg);
          if (tid != null) await stopLive(tid);
          sendResponse({ ok: true });
          break;
        }
        case 'lf:liveStatus': {
          const tid = await resolveTabId(sender, msg);
          const live = await readLive();
          sendResponse({ ok: true, live: tid != null && !!live[tid] });
          break;
        }
        case 'lf:asrResult': {
          // 来自 offscreen：分片转写文本 → 翻译 → 推送到页面滚动字幕（一段一段显示、一段一段翻译）
          const tabId = msg.tabId;
          const text = String(msg.text || '').trim();
          if (!tabId || !text) break;
          liveLog(tabId, '收到转写文本：' + JSON.stringify(text.length > 120 ? text.slice(0, 120) + '…' : text));
          const r = await translateTexts([text.slice(0, 1500)]);
          const translated = (r.ok && r.results && r.results[0] != null) ? r.results[0] : null;
          if (translated != null) {
            liveLog(tabId, '翻译成功（' + ((r.stats && r.stats.cacheHits) ? '缓存命中' : '实时请求，引擎=' + (r.stats && r.stats.engine))
              + '）：' + JSON.stringify(translated.length > 120 ? translated.slice(0, 120) + '…' : translated));
          } else {
            liveLog(tabId, '翻译失败：' + ((r && r.error) || '引擎返回空结果'));
          }
          notifyTab(tabId, { type: 'lf:liveCaption', original: text, translated, speechAt: msg.speechAt });
          sendResponse({ ok: true });
          break;
        }
        case 'lf:off:stopped': {
          // offscreen 侧流已结束（标签页跳转等）
          const live = await readLive();
          delete live[msg.tabId];
          await writeLive(live);
          notifyTab(msg.tabId, { type: 'lf:liveEnd' });
          break;
        }
        case 'lf:off:notice': {
          // offscreen 的运行状态 / 错误提示，转发到页面显示
          notifyTab(msg.tabId, { type: 'lf:liveNotice', level: msg.level || 'info', text: msg.text || '' });
          sendResponse({ ok: true });
          break;
        }
        case 'lf:off:log': {
          // offscreen 的链路日志，转发到页面 console（与 [LF-BG] 汇聚成完整链路）
          notifyTab(msg.tabId, { type: 'lf:liveLog', line: msg.line || '' });
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: '未知消息类型' });
      }
    } catch (e) {
      try { sendResponse({ ok: false, error: e && e.message ? e.message : String(e) }); } catch (e2) { /* noop */ }
    }
  })();
  return true; // 异步 sendResponse
});

/* ============================== 快捷键 / 右键菜单 ============================== */

async function sendToActiveTab(msg) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  if (!tab || !tab.id) return;
  try {
    chrome.tabs.sendMessage(tab.id, msg, () => { void chrome.runtime.lastError; });
  } catch (e) { /* noop */ }
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'translate-page') {
    sendToActiveTab({ type: 'lf:toggle', value: undefined });
    return;
  }
  // 快捷键同样构成扩展「唤起」，可安全启动 tabCapture
  if (command === 'live-captions') {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || tab.id == null) return;
    const r = await toggleLiveForTab(tab.id);
    if (!r.ok && r.error) notifyTab(tab.id, { type: 'lf:liveError', error: r.error });
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  // 初始化默认设置
  const o = await chrome.storage.sync.get('settings');
  if (!o || !o.settings) {
    await chrome.storage.sync.set({ settings: LF_DEFAULTS });
  }
  // 右键菜单：划词翻译 + 直播字幕
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'lf-selection',
      title: 'BPFlow：翻译选中文字',
      contexts: ['selection']
    });
    chrome.contextMenus.create({
      id: 'lf-live',
      title: 'BPFlow：直播字幕翻译（捕获本页声音）',
      contexts: ['page', 'frame', 'video', 'audio']
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id == null) return;
  if (info.menuItemId === 'lf-selection') {
    try {
      chrome.tabs.sendMessage(tab.id, { type: 'lf:selection' }, () => { void chrome.runtime.lastError; });
    } catch (e) { /* noop */ }
  } else if (info.menuItemId === 'lf-live') {
    // 右键菜单点击属于扩展「唤起」，满足 tabCapture 前提
    toggleLiveForTab(tab.id).then((r) => {
      if (!r.ok && r.error) notifyTab(tab.id, { type: 'lf:liveError', error: r.error });
    });
  }
});
