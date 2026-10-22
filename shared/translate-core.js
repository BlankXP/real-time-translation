/*
 * BPFlow — 翻译核心的纯函数（无 chrome API、无 DOM 依赖）
 * 被 Service Worker（importScripts）与 node 测试共同加载。
 *
 * 放在这里的原因：分片切分、译文拼接、缓存键指纹都是「算错了很难发现」的逻辑，
 * 抽成纯函数才能直接跑断言；留在 background.js 里只能靠切片 eval 测试。
 */
(function (g) {
  'use strict';

  /* ============================== 哈希 / 缓存键 ============================== */

  /** djb2 变体：短、稳定、无碰撞风险可接受（键里还带了长度） */
  function hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + '_' + s.length.toString(36);
  }

  /**
   * 引擎配置指纹：baseUrl / 提示词 / 账号类型 / 温度都会影响输出。
   * 不进缓存键的话，改了配置仍会命中旧译文，连「测试连接」都会假成功。
   */
  function providerFingerprint(prov) {
    return hashStr([
      prov.type || '',
      prov.baseUrl || '',
      prov.model || '',
      prov.plan || '',
      prov.temperature == null ? '' : prov.temperature,
      prov.promptTemplate || ''
    ].join('\u0002'));
  }

  /** 译文缓存键：引擎标识 + 方向 + 原文 + 配置指纹 */
  function cacheKey(prov, source, target, text) {
    const id = prov.id + ':' + (prov.model || '') + ':' + source + '>' + target;
    return hashStr(id + '\u0001' + text + '\u0001' + providerFingerprint(prov));
  }

  /* ============================== 分片 ============================== */

  /** 按 batch / maxChars 把多条文本分组（不拆分单条） */
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

  /**
   * 按句末标点把超长文本切成不超过 maxChars 的片段。
   * 为什么需要：chunkTexts 只在「不同文本之间」分组，单条超长文本会原样发出，
   * 直接撞上引擎上限（如 MyMemory 450 字符 → 必然报 QUERY LENGTH LIMIT EXCEEDED）。
   */
  function splitLongText(text, maxChars) {
    const s = String(text || '');
    const n = Math.round(Number(maxChars) || 0);
    if (!(n > 0)) return [s];       // 未配置上限：不切
    const max = Math.max(50, n);
    if (s.length <= max) return [s];
    const punct = '。！？；…\n.!?;';
    const out = [];
    let rest = s;
    let guard = 64; // 极端输入（每句都超长）时的死循环保护
    while (rest.length > max && guard-- > 0) {
      const head = rest.slice(0, max + 1);
      const floor = Math.floor(max * 0.4);
      let cut = -1;
      for (let i = head.length - 1; i >= floor; i--) {
        if (punct.indexOf(head[i]) !== -1) { cut = i + 1; break; }
      }
      if (cut <= 0) {
        const sp = head.lastIndexOf(' ', max);
        cut = sp > floor ? sp + 1 : max;
      }
      const piece = rest.slice(0, cut).trim();
      if (piece) out.push(piece);
      rest = rest.slice(cut);
    }
    if (rest.trim()) out.push(rest.trim());
    return out.length ? out : [s];
  }

  /** 拼接切分后的译文：边界两侧都是 CJK 时不加空格（否则中文译文里会多出空格） */
  function joinParts(parts) {
    const cjk = /[\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]/;
    let out = '';
    parts.forEach((p) => {
      if (p == null || p === '') return;
      if (!out) { out = p; return; }
      const a = out.charAt(out.length - 1);
      const b = p.charAt(0);
      out += ((cjk.test(a) || cjk.test(b)) ? '' : ' ') + p;
    });
    return out;
  }

  g.LF_CORE = {
    hashStr,
    providerFingerprint,
    cacheKey,
    chunkTexts,
    splitLongText,
    joinParts
  };
})(globalThis);
