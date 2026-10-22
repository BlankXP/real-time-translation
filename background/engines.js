/*
 * BPFlow — 翻译引擎适配层
 * 依赖：shared/langs.js（LF 语言编码映射）、globalThis.fetch
 * 由 background.js 通过 importScripts('engines.js') 加载，挂到 LF_ENGINES。
 *
 * 每个适配器只负责「一次请求 → 与输入等长的译文数组」，
 * 分片、并发、缓存、重试策略都在 background.js 的调度层，互不纠缠。
 */
/* global LF, LF_VALIDATE_ENDPOINT */
(function (g) {
  'use strict';

  /** 各引擎的单请求上限（batch = 条数，maxChars = 单条/单批字符数） */
  const API = {
    'bing-free':   { batch: 20, maxChars: 40000 },
    'google-free': { batch: 1, maxChars: 1000 },  // 逐句 GET，上限受 URL 长度约束
    'mymemory':    { batch: 1, maxChars: 450 },   // 服务端硬上限 500 字符
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

  /** 把 HTTP 状态 + 响应体翻成可读中文，避免把原始 JSON 抛给用户 */
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

  let bingTokenCache = null; // {token, exp}

  async function bingToken() {
    const now = Date.now();
    if (bingTokenCache && bingTokenCache.exp > now + 30000) return bingTokenCache.token;
    const res = await fetch('https://edge.microsoft.com/translate/auth');
    if (!res.ok) throw new Error('无法获取 Bing 翻译令牌（HTTP ' + res.status + '）');
    const token = (await res.text()).trim();
    // JWT 有效期约 10 分钟，保守按 8 分钟计
    bingTokenCache = { token, exp: now + 8 * 60 * 1000 };
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

  /** 从模型输出里抠出 JSON 数组（容忍 ```json 围栏与前后废话） */
  function extractJsonArray(raw) {
    if (Array.isArray(raw)) return raw;
    const s = String(raw || '').trim();
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
    // 纵深防御：老配置里可能残留 http:// 远程地址，绝不把 Bearer Key 明文发出去。
    // 规则必须与设置页一致（LF_VALIDATE_ENDPOINT 放行局域网 http），否则会出现
    // 「保存时通过、请求时被拒」——配了局域网 Ollama 却永远翻不了。
    const ep = LF_VALIDATE_ENDPOINT(url);
    if (!ep.ok) throw new Error(ep.error);
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

  /* ---------- 统一入口 ---------- */

  /**
   * 按引擎类型分发一次翻译请求。
   * @param {object} prov provider（含 type/apiKey/plan/baseUrl/model…）
   * @param {string[]} texts 已按批切好的文本（google/mymemory 只会传 1 条）
   * @returns {Promise<string[]>} 与 texts 等长
   */
  async function callEngine(prov, texts, source, target) {
    switch (prov.type) {
      case 'bing-free': return callBing(texts, source, target);
      case 'google-free': return [await callGoogle(texts[0], source, target)];
      case 'mymemory': return [await callMyMemory(texts[0], source, target)];
      case 'deepl': return callDeepl(prov, texts, source, target);
      case 'openai': return callOpenAI(prov, texts, source, target);
      default: throw new Error('未知引擎类型：' + prov.type);
    }
  }

  g.LF_ENGINES = { API, callEngine, fetchJSON, humanError, extractJsonArray, bingToken };
})(globalThis);
