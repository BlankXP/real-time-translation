/*
 * BPFlow — Background Service Worker (MV3)
 * 职责：批量调度与并发控制 / 译文缓存 / 直播会话 / 快捷键 / 右键菜单
 * 引擎适配在 engines.js，纯函数（缓存键、分片）在 shared/translate-core.js
 */
/* global LF_DEFAULTS, LF_MERGE, LF_RESOLVE_VOICE, LF_MIGRATE_SETTINGS,
   LF_SPLIT_SECRETS, LF_APPLY_SECRETS, LF_MERGE_SECRETS, LF_VALIDATE_ENDPOINT, LF_CORE, LF_ENGINES */
importScripts('../shared/langs.js', '../shared/defaults.js', '../shared/translate-core.js', 'engines.js');
/* 注：MV3 Service Worker 默认严格模式 */

const { cacheKey, chunkTexts, splitLongText, laneConcurrency, assembleResults } = LF_CORE;

/* ============================== 设置 ============================== */

/*
 * 存储分层：
 *   chrome.storage.sync['settings']  —— 公开设置（语言/样式/引擎名/站点规则…）
 *   chrome.storage.local['lf:secrets'] —— 只放 API Key，不参与账号同步
 * 内容脚本/弹窗只拿公开设置，永远看不到密钥。
 */
const SECRET_KEY = 'lf:secrets';

let _secrets = null;        // 内存缓存，local 变更时失效
let _secretsMigrated = false;

async function readSecrets() {
  if (_secrets) return _secrets;
  try {
    const o = await chrome.storage.local.get(SECRET_KEY);
    _secrets = LF_MERGE_SECRETS({}, (o && o[SECRET_KEY]) || {});
  } catch (e) {
    _secrets = LF_MERGE_SECRETS();
  }
  return _secrets;
}

async function readPublicSettings() {
  const o = await chrome.storage.sync.get('settings');
  return LF_MIGRATE_SETTINGS(LF_MERGE(LF_DEFAULTS, (o && o.settings) || {}));
}

/** 老版本把 API Key 存在 sync 里：一次性搬到 local，并从 sync 抹掉 */
async function migrateSecretsOnce(pub) {
  if (_secretsMigrated) return pub;
  const split = LF_SPLIT_SECRETS(pub);
  if (!split.hadKeys) { _secretsMigrated = true; return pub; }
  const secrets = LF_MERGE_SECRETS(await readSecrets(), split.secrets);
  try {
    // 顺序很关键：本地没落盘就绝不从 sync 删，否则用户的 Key 会被彻底抹掉。
    // 失败时保持 _secretsMigrated 为 false，下次调用再试。
    await chrome.storage.local.set({ [SECRET_KEY]: secrets });
  } catch (e) {
    console.log('[LF-BG] 密钥迁移失败，保留 sync 中的旧值稍后重试：' + ((e && e.message) || e));
    return pub;
  }
  _secrets = secrets;
  try { await chrome.storage.sync.set({ settings: split.pub }); } catch (e) { /* 下次启动会再清一次，无副作用 */ }
  _secretsMigrated = true;
  console.log('[LF-BG] 已把 API Key 从 storage.sync 迁移到本地（不再随 Chrome 账号同步）');
  return split.pub;
}

/** 完整设置（含密钥）：仅供后台自己使用 */
async function getSettings() {
  const pub = await migrateSecretsOnce(await readPublicSettings());
  return LF_APPLY_SECRETS(pub, await readSecrets());
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[SECRET_KEY]) _secrets = null;
});

/* ============================== 缓存 ============================== */

let _cache = null;          // Map（LRU，插入序即访问序）
let _cacheSaveTimer = null;

/* 缓存键 / 分片等纯函数见 shared/translate-core.js（LF_CORE） */

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
  // 双保险：导入校验已是第一道闸，这里再夹一次 —— maxCache<=0 时
  // `while (size > max)` 在空 Map 上恒真（delete(undefined) 不改变 size），会卡死 SW。
  const raw = (await getSettings()).advanced.maxCache;
  const n = Number(raw);
  const max = Number.isFinite(n) ? Math.max(50, Math.min(5000, Math.round(n))) : 800;
  let guard = _cache.size + 1;
  while (_cache.size > max && guard-- > 0) {
    const oldest = _cache.keys().next().value;
    if (oldest === undefined) break; // 空缓存兜底，绝不空转
    _cache.delete(oldest); // 淘汰最旧
  }
  try {
    await chrome.storage.local.set({ 'lf:cache': Array.from(_cache.entries()).slice(-max) });
  } catch (e) { /* 存储满时静默 */ }
}

/* ============================== 批量调度 ============================== */

/**
 * 并发池执行。
 * 任务级错误隔离：单个任务抛错只留一个 null 槽位，绝不让 worker 提前退出、
 * 更不能让 Promise.all 整池 reject —— 否则「一个分片 4xx」会把同批其余分片的结果全丢掉。
 * 调用方必须按 `if (!r)` 判空（见 translateTexts 的回填循环）。
 */
async function runPool(tasks, limit) {
  const results = new Array(tasks.length);
  let idx = 0;
  const workers = new Array(Math.min(limit, tasks.length)).fill(0).map(async () => {
    while (idx < tasks.length) {
      const i = idx++;
      try {
        results[i] = await tasks[i]();
      } catch (e) {
        results[i] = null;
        console.log('[LF-BG] 并发任务失败（槽位 ' + i + '）：' + ((e && e.message) || String(e)));
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 核心翻译入口
 * @param {string[]} texts
 * @param {?object} overrideProvider 指定引擎（「测试连接」用）
 * @param {{bypassCache?: boolean, lanes?: number, lane?: number}} [opts]
 *   bypassCache：测试连接必须绕缓存，否则会假成功
 *   lanes / lane：调用方同时在途的批数与本请求所在车道（内容脚本窗口并发）。
 *   总并发按车道分摊，避免峰值翻倍
 * @returns {Promise<{ok:boolean, results:?string[], error:?string, stats:object}>}
 */
async function translateTexts(texts, overrideProvider, opts) {
  const settings = await getSettings();
  const prov = overrideProvider
    || settings.providers.find((p) => p.id === settings.activeProviderId && p.enabled !== false)
    || settings.providers.find((p) => p.enabled !== false);
  if (!prov) return { ok: false, error: '没有可用的翻译引擎，请到设置中启用或配置一个' };

  const source = settings.sourceLang || 'auto';
  const target = settings.targetLang || 'zh-CN';
  const api = LF_ENGINES.API[prov.type] || { batch: 10 };
  const concurrency = Math.max(1, Math.min(8, settings.advanced.concurrency || 4));
  // 单请求内部并发 = 全局并发 / 在途车道数（内容脚本一次只发一批时 lanes=1，行为与旧版一致）
  // lane 是该请求所在的车道下标：余数分给前几条车道，保证各车道之和恰好等于用户设置值
  const perLane = laneConcurrency(concurrency, opts && opts.lanes, opts && opts.lane);

  const useCache = !(opts && opts.bypassCache) && settings.advanced.cacheEnabled !== false;
  const cache = useCache ? await loadCache() : null;

  const results = new Array(texts.length);
  const needIdx = [];   // 需要真实请求的下标
  texts.forEach((t, i) => {
    if (cache) {
      const key = cacheKey(prov, source, target, t);
      const hit = cache.get(key);
      if (hit != null) {
        cache.delete(key); cache.set(key, hit); // LRU 刷新
        results[i] = hit;
        return;
      }
    }
    needIdx.push(i);
  });

  let fetched = 0, failed = 0;
  if (needIdx.length) {
    // 超长文本先按句切分，再按 (待翻文本下标, 第几片) 记账
    const units = [];
    needIdx.forEach((origIdx, pos) => {
      const t = texts[origIdx];
      const parts = (api.maxChars && t.length > api.maxChars) ? splitLongText(t, api.maxChars) : [t];
      parts.forEach((p, pi) => units.push({ idx: pos, part: pi, total: parts.length, text: p }));
    });
    const chunks = chunkTexts(units.map((u) => u.text), api.batch, api.maxChars);

    const chunkResults = await runPool(chunks.map((chunk) => async () => {
      try {
        const out = await LF_ENGINES.callEngine(prov, chunk, source, target);
        return { ok: true, out };
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
      }
    }), prov.type === 'openai' ? Math.min(2, perLane) : perLane);

    // 汇编（长文多片聚合、任一片缺失即判废）在纯函数里，见 shared/translate-core.js
    const asm = assembleResults({
      units,
      chunkSizes: chunks.map((c) => c.length),
      chunkResults,
      count: needIdx.length
    });
    fetched = asm.fetched;
    failed = asm.failed;

    needIdx.forEach((origIdx, pos) => {
      const val = asm.values[pos];
      results[origIdx] = val;
      // 切分后的原文整体入缓存：同一段长文下次直接命中，不再重复切分请求
      if (val != null && cache) cache.set(cacheKey(prov, source, target, texts[origIdx]), val);
    });

    if (cache && fetched) scheduleCacheSave();
    if (fetched === 0 && asm.firstError) {
      return { ok: false, error: asm.firstError, results: null };
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

/**
 * 同一标签页的字幕任务串行执行。
 * offscreen 已按分片序号顺序发送，但每条翻译耗时不同——并发执行会让后一片先翻完、
 * 先推给页面，字幕就倒序了。这里按 tabId 排成 Promise 链，顺序与分片顺序一致。
 */
const asrChains = new Map();

function queueAsr(tabId, task) {
  const prev = asrChains.get(tabId) || Promise.resolve();
  const next = prev.then(task, task).catch((e) => {
    console.log('[LF-BG] 字幕任务异常：' + ((e && e.message) || String(e)));
  });
  asrChains.set(tabId, next);
  next.then(() => { if (asrChains.get(tabId) === next) asrChains.delete(tabId); });
  return next;
}

async function readLive() {
  try {
    const o = await chrome.storage.session.get(LIVE_KEY);
    return (o && o[LIVE_KEY]) || {};
  } catch (e) { return {}; }
}

async function writeLive(map) {
  try { await chrome.storage.session.set({ [LIVE_KEY]: map }); } catch (e) { /* noop */ }
}

/**
 * 是否已存在 offscreen 文档。
 * 优先 runtime.getContexts（Chrome 116+，与 tabCapture→offscreen 链路要求的版本一致），
 * 不用 chrome.offscreen.hasDocument()——该方法在不同 Chrome 版本上可用性不一致
 * （官方文档标注 Chrome 150+），低版本直接是 TypeError。
 */
async function hasOffscreenDocument() {
  try {
    if (chrome.runtime.getContexts) {
      const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (ctx && ctx.length) return true;
    }
  } catch (e) { /* noop */ }
  // 兜底：offscreen 文档是 SW 的 client，按扩展内 URL 前缀匹配
  try {
    const clients = await self.clients.matchAll();
    const prefix = chrome.runtime.getURL('offscreen/');
    return clients.some((c) => c.url.indexOf(prefix) === 0);
  } catch (e) { return false; }
}

async function ensureOffscreen() {
  const has = await hasOffscreenDocument();
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

/**
 * tabCapture 的错误对用户几乎不可读 → 转成可执行建议 + 机器可读 code。
 * code 供内容脚本判断是否要显示「先唤起扩展」的引导。
 */
function captureErrorInfo(raw) {
  const s = String(raw || '');
  if (/not been invoked|activeTab/i.test(s)) {
    return {
      code: 'needInvocation',
      error: '浏览器安全要求：需先「唤起」扩展才能捕获页面声音。请点工具栏的 BPFlow 图标 → 开始，或按 Alt+Shift+L / 右键菜单启动'
    };
  }
  if (/active stream|already captur/i.test(s)) {
    return {
      code: 'busy',
      error: '本页已有未释放的音频捕获（常见于扩展重载或上一次会话异常退出）。请刷新本页（F5）后重新开启直播字幕'
    };
  }
  if (/Chrome pages|chrome:\/\//i.test(s)) {
    return { code: 'internalPage', error: '浏览器内部页面（chrome:// 等）无法捕获声音，请在普通网页上使用' };
  }
  return { code: 'unknown', error: s };
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
    // 日志会经 lf:liveLog 转发到直播页 console：不打印 Key 的任何片段，
    // 只要「有没有配 / 多长」就够定位问题（用户截图排障时不会顺带泄露末四位）
    + '，apiKey=' + (voice.apiKey ? '已配置（' + String(voice.apiKey).length + ' 字符）' : '未填写'));
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
  // 接口地址安全校验：远程必须 https，否则 Key 与录音数据会明文外发
  const ep = LF_VALIDATE_ENDPOINT(voice.baseUrl);
  if (!ep.ok) {
    liveLog(tabId, '启动中止：接口地址不合规（' + ep.error + '）');
    return { ok: false, error: '语音转写接口地址不安全：' + ep.error };
  }
  if (!voice.apiKey && !ep.local) {
    liveLog(tabId, '启动中止：非本地引擎缺少 API Key');
    return { ok: false, error: '语音转写需要 API Key，请到 设置 → 视频直播 填写' };
  }

  await ensureOffscreen();
  liveLog(tabId, 'offscreen 文档就绪');

  // 会话代号：随消息贯穿 offscreen → 后台，用于丢弃「停止后才返回」的迟到转写结果
  const gen = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

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
    const info = captureErrorInfo(e && e.message);
    liveLog(tabId, '音频捕获授权失败：' + ((e && e.message) || String(e)));
    return { ok: false, code: info.code, error: info.error };
  }

  const r = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'lf:off:start', tabId, streamId, voice, gen },
      (res) => { void chrome.runtime.lastError; resolve(res || null); });
  });
  liveLog(tabId, 'offscreen 捕获结果：' + JSON.stringify(r));
  if (!r || !r.ok) {
    return { ok: false, error: (r && r.error) || '音频捕获失败' };
  }

  live[tabId] = { gen, at: Date.now() };
  await writeLive(live);
  notifyTab(tabId, { type: 'lf:liveStarted', gen });
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
  return { ok: r.ok, live: !!r.ok, error: r.error, code: r.code };
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
    const hasOffscreen = await hasOffscreenDocument();
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
          // 防御性截断（内容脚本单批最多 16 条，正常到不了）：真被截断要在响应里说明，
          // 否则调用方会以为「整批都翻完了」
          const truncated = texts.length > 2000;
          if (truncated) texts.length = 2000;
          // 内容脚本用窗口并发时一次会有多批在飞：按车道数分摊池大小，
          // 保证总并发仍是用户在「高级设置」里选的那个值（否则会被放大成 N 倍）
          const r = await translateTexts(texts, null, { lanes: msg.lanes, lane: msg.lane });
          sendResponse(truncated ? Object.assign({}, r, { truncated: true }) : r);
          break;
        }
        case 'lf:getSettings': {
          // 内容脚本 / 弹窗只拿公开设置：其中绝不含 apiKey（密钥在 storage.local）
          // 必须先跑一次密钥迁移：调用方拿到的是「无密钥副本」，随后会把它整体写回 sync，
          // 老版本升级后若先打开弹窗改个语言，未迁移就等于把旧密钥永久抹掉。
          const pub = await migrateSecretsOnce(await readPublicSettings());
          sendResponse({ ok: true, settings: LF_SPLIT_SECRETS(pub).pub });
          break;
        }
        case 'lf:testProvider': {
          const settings = await getSettings();
          const prov = settings.providers.find((p) => p.id === msg.providerId);
          if (!prov) return sendResponse({ ok: false, error: '未找到该引擎' });
          const t0 = Date.now();
          // 必须绕缓存：否则改完配置点「测试」会直接返回旧译文，造成"测试通过"的假象
          const r = await translateTexts(['Hello! This is a connection test.'], prov, { bypassCache: true });
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
          const liveNow = await readLive();
          const cur = liveNow[tabId];
          // 会话已停止（或被新一轮直播取代）→ 丢弃迟到结果，避免「停止后仍在出字幕」
          if (!cur || (msg.gen && cur.gen && msg.gen !== cur.gen)) {
            liveLog(tabId, '丢弃迟到转写结果（会话已结束或已更换）');
            sendResponse({ ok: false, dropped: true });
            break;
          }
          // 串行处理：保证「先录制的分片先上屏」，同时天然限制同一标签页的翻译并发
          await queueAsr(tabId, async () => {
            const before = await readLive();
            const c0 = before[tabId];
            if (!c0 || (msg.gen && c0.gen && msg.gen !== c0.gen)) {
              liveLog(tabId, '排队期间会话已结束，丢弃该条字幕');
              return;
            }
            liveLog(tabId, '收到转写文本：' + JSON.stringify(text.length > 120 ? text.slice(0, 120) + '…' : text));
            const r = await translateTexts([text.slice(0, 1500)]);
            // 翻译期间用户可能已点停止：返回后再校验一次，宁可丢一条也不上屏
            const liveAfter = await readLive();
            const still = liveAfter[tabId];
            if (!still || (msg.gen && still.gen && msg.gen !== still.gen)) {
              liveLog(tabId, '翻译返回时会话已结束，丢弃该条字幕');
              return;
            }
            const translated = (r.ok && r.results && r.results[0] != null) ? r.results[0] : null;
            if (translated != null) {
              liveLog(tabId, '翻译成功（' + ((r.stats && r.stats.cacheHits) ? '缓存命中' : '实时请求，引擎=' + (r.stats && r.stats.engine))
                + '）：' + JSON.stringify(translated.length > 120 ? translated.slice(0, 120) + '…' : translated));
            } else {
              liveLog(tabId, '翻译失败：' + ((r && r.error) || '引擎返回空结果'));
            }
            notifyTab(tabId, { type: 'lf:liveCaption', original: text, translated, speechAt: msg.speechAt, gen: msg.gen });
          });
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
  // 初始化默认设置（只写公开部分，密钥留给 storage.local）
  const o = await chrome.storage.sync.get('settings');
  if (!o || !o.settings) {
    await chrome.storage.sync.set({ settings: LF_SPLIT_SECRETS(LF_DEFAULTS).pub });
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
