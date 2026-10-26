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

  /**
   * 双种子 32 位哈希拼成约 64 位的键。
   * 单用 djb2 在数千条缓存下碰撞概率虽已很低（且键里还带了长度），
   * 但碰撞的表现是「静默命中别人的译文」，几乎无法排查——第二个种子成本近乎为零。
   * 两个种子走不同的混合方式（加法 vs 异或），避免同步退化成同一条序列。
   */
  function hashStr(s) {
    let h1 = 5381;
    let h2 = 52711;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = ((h1 << 5) + h1 + c) | 0;
      h2 = (((h2 << 5) + h2) ^ c) | 0;
    }
    return (h1 >>> 0).toString(36) + '.' + (h2 >>> 0).toString(36) + '_' + s.length.toString(36);
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

  /**
   * 把「全局并发」按在途车道数分摊成单车道并发。
   * 内容脚本改为窗口式并发后，同一时刻有 lanes 个 lf:translate 在飞；
   * 后台若仍按整份 concurrency 开池，峰值会被放大成 lanes×concurrency，
   * 免费引擎（Bing / Google）会直接撞限流。
   *
   * 分摊必须**向下取整 + 余数补到前几条车道**，不能用四舍五入：
   * concurrency=3、lanes=2 时 round(1.5)=2 会让总量变成 4；=5 时 round(2.5)=3 变成 6，
   * 都突破了用户设置的上限。这里保证 sum(各车道) === concurrency（车道数不超过并发时）。
   *
   * @param {number} concurrency 用户设置的全局并发（1-8）
   * @param {number} lanes 在途车道数（1-4）
   * @param {number} [lane] 当前车道下标（0 起）；不传按第 0 条算
   */
  function laneConcurrency(concurrency, lanes, lane) {
    const c = Math.max(1, Math.min(8, Math.round(Number(concurrency) || 4)));
    // 车道数不能超过总并发：否则「每车道至少 1」会让总量必然超限
    const l = Math.max(1, Math.min(4, Math.round(Number(lanes) || 1), c));
    const base = Math.floor(c / l);
    const extra = c % l; // 余数分给前 extra 条车道，一条不多一条不少
    const idx = Math.max(0, Math.min(l - 1, Math.round(Number(lane) || 0)));
    return Math.max(1, base + (idx < extra ? 1 : 0));
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

  /**
   * 把「分片返回的引擎结果」还原成「按原文顺序的结果数组」。
   *
   * 这是调度层最复杂的记账：一条原文可能被切成多片（长文），多片又会被打散进不同
   * 分片并发请求，返回顺序与原文顺序无关；任何一片缺失/报错，整条原文都不能算成功
   * （否则会把半截译文拼上去）。
   *
   * @param {{units: Array<{idx:number, part:number, total:number}>,
   *          chunkSizes: number[],
   *          chunkResults: Array<?{ok:boolean, out?:string[], error?:string}>,
   *          count: number}} input
   *   units：按 chunks 展开顺序排列，idx 是「待翻文本」的下标（0..count-1），
   *          part/total 是该原文被切分后的第几片/共几片
   *   chunkSizes：每个分片的条数，必须与 chunkResults 一一对应
   *   chunkResults：runPool 的返回；失败槽位可能是 null（任务级错误隔离）
   *   count：待翻文本条数
   * @returns {{values:(string|null)[], fetched:number, failed:number, firstError:(string|null)}}
   */
  function assembleResults(input) {
    const units = (input && input.units) || [];
    const sizes = (input && input.chunkSizes) || [];
    const outs = (input && input.chunkResults) || [];
    const count = Math.max(0, (input && input.count) || 0);

    const bags = new Map(); // idx -> { parts, total, broken }
    let firstError = null;
    let cursor = 0;

    for (let ci = 0; ci < sizes.length; ci++) {
      const n = sizes[ci];
      const r = outs[ci];
      const outArr = (r && r.ok && Array.isArray(r.out)) ? r.out : null;
      for (let k = 0; k < n; k++) {
        const u = units[cursor + k];
        if (!u) continue;
        let bag = bags.get(u.idx);
        if (!bag) {
          bag = { parts: new Array(u.total).fill(null), total: u.total, broken: false };
          bags.set(u.idx, bag);
        }
        if (outArr) {
          const val = outArr[k] != null ? outArr[k] : null;
          if (val == null) bag.broken = true;
          else bag.parts[u.part] = val;
        } else {
          bag.broken = true;
          // 失败槽位可能是 null（runPool 的错误隔离）：给一句可读兜底，
          // 否则整批失败时 firstError 仍为 null，UI 只剩一句没有原因的"翻译失败"
          if (!firstError) firstError = (r && r.error) || '引擎请求失败（未返回原因）';
        }
      }
      cursor += n;
    }

    const values = new Array(count).fill(null);
    let fetched = 0;
    let failed = 0;
    for (let i = 0; i < count; i++) {
      const bag = bags.get(i);
      const complete = bag && !bag.broken && bag.parts.every((p) => p != null);
      if (!complete) { failed++; continue; }
      values[i] = bag.total > 1 ? joinParts(bag.parts) : bag.parts[0];
      fetched++;
    }
    return { values, fetched, failed, firstError };
  }

  g.LF_CORE = {
    hashStr,
    providerFingerprint,
    cacheKey,
    chunkTexts,
    splitLongText,
    laneConcurrency,
    joinParts,
    assembleResults
  };
})(globalThis);
