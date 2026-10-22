/*
 * BPFlow — 默认设置与引擎预设
 * 无 chrome API 依赖，可被 SW（importScripts）/ 内容脚本 / 扩展页面加载。
 */
(function (g) {
  'use strict';

  const DEFAULTS = {
    version: 1,
    /** 翻译供应商列表（用户可在设置页增删改） */
    providers: [
      { id: 'bing-free',    type: 'bing-free',    name: 'Bing 翻译 · 免费',  enabled: true,  builtin: true },
      { id: 'google-free',  type: 'google-free',  name: 'Google 翻译 · 免费', enabled: true,  builtin: true },
      { id: 'mymemory',     type: 'mymemory',     name: 'MyMemory · 免费',   enabled: true,  builtin: true },
      { id: 'openai-custom', type: 'openai',      name: '自定义 AI 模型',     enabled: false,
        baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini', temperature: 0.1, promptTemplate: '' },
      { id: 'deepl',        type: 'deepl',        name: 'DeepL',             enabled: false, apiKey: '', plan: 'free' }
    ],
    activeProviderId: 'bing-free',
    sourceLang: 'auto',
    targetLang: 'zh-CN',
    /** 展示模式：bilingual 双语对照 | replace 替换原文 | hover 悬停查看 */
    displayMode: 'bilingual',
    /** 全局自动翻译（页面加载后自动开始） */
    autoTranslate: false,
    /** 划词后显示翻译浮条（按需翻译，独立于整页翻译开关） */
    selectionToolbar: true,
    /** 视频字幕实时翻译（YouTube / Bilibili / 通用 HTML5 CC 字幕） */
    videoSubtitle: { enabled: true, bilingual: true },
    /**
     * 直播语音转写设置（OpenAI 兼容 与 阿里云百炼 为两套相互独立的配置，切换引擎不会互相覆盖）
     * engine : 'bailian' 阿里云百炼（模型下拉选择，接口地址按模型自动推导）
     *        | 'openai'  OpenAI 兼容（/audio/transcriptions，5 秒分片上传）
     * bailian: { model 模型 id（见 LF_BAILIAN_MODELS）, apiKey, baseUrl 自定义接口地址（留空=按模型自动推导） }
     * openai : { baseUrl, model, apiKey }
     * lang / playbackDelayMs / syncVideo / videoDelayTrimMs 为两引擎共用
     * playbackDelayMs: 同步延迟（毫秒，0=关闭，上限 30000）——延迟回放给用户的声音；
     *                  字幕按「语音发生时刻 + 延迟」定时上屏，与延迟后的声音对齐
     * syncVideo: 画面同步——true 时视频也一并延迟（内容脚本 captureStream → N 秒队列 → MSE 覆盖层重放），
     *            视频/声音/字幕三者整体比直播源晚 playbackDelayMs
     * videoDelayTrimMs: 画面延迟微调（-3000~+3000，正值画面更晚/负值更早）。
     *                  画面链路（1s 分片 + MSE）固有延迟比声音链路（DelayNode）多约 1~2 秒，
     *                  画面慢于声音时取负值补偿；字幕与声音对齐，不参与微调
     */
    voice: {
      engine: 'bailian',
      lang: 'auto',
      playbackDelayMs: 0,
      syncVideo: false,
      videoDelayTrimMs: 0,
      bailian: { model: 'fun-asr-flash-2026-06-15', apiKey: '', baseUrl: '' },
      openai: { baseUrl: 'https://api.openai.com/v1', model: 'whisper-1', apiKey: '' }
    },
    /** 快捷语言列表（弹窗/悬浮面板展示的语言） */
    quickLangs: ['zh-CN', 'en', 'ja', 'ko', 'zh-TW', 'fr', 'de', 'es', 'ru'],
    /** 用户自定义语言 {code,label,name} */
    customLangs: [],
    /** 站点规则 host -> {auto:boolean} */
    siteRules: {},
    /** 站点黑名单（完全禁用，不注入悬浮球） */
    blacklist: [],
    /** 译文样式 */
    style: { color: '', fontSize: 95, showBadge: true },
    advanced: {
      concurrency: 4,      // 并发请求数
      minTextLength: 2,    // 最小翻译文本长度
      cacheEnabled: true,  // 译文缓存
      maxCache: 800,       // 缓存条目上限
      maxUnits: 600        // 单页最大翻译块数
    }
  };

  /** OpenAI 兼容引擎快速预设（设置页一键填充） */
  const PRESETS = [
    { id: 'openai',      name: 'OpenAI',            baseUrl: 'https://api.openai.com/v1',                             model: 'gpt-4o-mini' },
    { id: 'deepseek',    name: 'DeepSeek',          baseUrl: 'https://api.deepseek.com/v1',                           model: 'deepseek-chat' },
    { id: 'moonshot',    name: 'Kimi · 月之暗面',    baseUrl: 'https://api.moonshot.cn/v1',                           model: 'moonshot-v1-8k' },
    { id: 'zhipu',       name: '智谱 GLM',           baseUrl: 'https://open.bigmodel.cn/api/paas/v4',                 model: 'glm-4-flash' },
    { id: 'qwen',        name: '通义千问',           baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',    model: 'qwen-plus' },
    { id: 'groq',        name: 'Groq',              baseUrl: 'https://api.groq.com/openai/v1',                       model: 'llama-3.3-70b-versatile' },
    { id: 'siliconflow', name: '硅基流动',           baseUrl: 'https://api.siliconflow.cn/v1',                        model: 'Qwen/Qwen2.5-7B-Instruct' },
    { id: 'ollama',      name: 'Ollama · 本地',      baseUrl: 'http://localhost:11434/v1',                            model: 'qwen2.5:7b', apiKeyHint: 'ollama' }
  ];

  /* ==================== 阿里云百炼（DashScope）语音识别模型 ==================== */

  /**
   * 模型清单。选择模型后「接口地址 / 协议 / 采样率」全部自动推导，无需手填。
   * protocol:
   *   - 'dashscope'        非实时：POST {base}/services/aigc/multimodal-generation/generation（JSON + Base64，5 秒分片）
   *   - 'paraformer-async' 非实时录音文件转写：POST {base}/services/audio/asr/transcription（异步任务 + 轮询）
   *                        ⚠ 该接口只接受公网可访问的音频 URL，浏览器本地音频无法直接提交，仅作地址推导占位
   */
  const BAILIAN_MODELS = [
    // —— 普通模型（非实时）——
    { id: 'paraformer-v1',                  streaming: false, sampleRate: 16000, protocol: 'paraformer-async',
      baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
      note: '录音文件识别（异步转写）。该接口仅接受公网可访问的音频 URL，浏览器端实时转写不可用' },
    { id: 'paraformer-v2',                  streaming: false, sampleRate: 16000, protocol: 'paraformer-async',
      baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
      note: '录音文件识别（异步转写）。该接口仅接受公网可访问的音频 URL，浏览器端实时转写不可用' },
    { id: 'fun-asr-flash-2026-06-15',       streaming: false, sampleRate: 16000, protocol: 'dashscope',
      baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
      note: '非实时：5 秒分片上传（multimodal-generation），延迟约 6 秒+' }
  ];

  const BAILIAN_DEFAULT_MODEL = 'fun-asr-flash-2026-06-15';

  /** 按 id 取百炼模型定义（未命中返回默认模型） */
  function lfBailianModel(id) {
    const hit = BAILIAN_MODELS.filter((m) => m.id === id)[0];
    return hit || BAILIAN_MODELS.filter((m) => m.id === BAILIAN_DEFAULT_MODEL)[0];
  }

  function lfTrimUrl(u) { return String(u || '').trim().replace(/\/+$/, ''); }

  /**
   * 旧版单套 voice 配置（protocol / baseUrl / apiKey / model）迁移为「百炼 + OpenAI」双配置。
   * 幂等：已经含 bailian / openai 子对象时不处理。
   * @returns {?object} 返回规范化后的 voice；入参非对象时返回 null
   */
  function lfMigrateVoice(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const v = Object.assign({}, raw);
    const bl = (v.bailian && typeof v.bailian === 'object') ? v.bailian : null;
    const oa = (v.openai && typeof v.openai === 'object') ? v.openai : null;
    // 旧结构判定：voice 上直接挂着 protocol/baseUrl/apiKey/model/audioField 任一旧字段。
    // 注意不能只看「bailian/openai 是否存在」——旧配置经 LF_MERGE 与新版默认值合并后，
    // 两侧子对象会被默认值补齐，只有旧字段的存在与否能可靠区分。
    const isLegacy = ['protocol', 'audioField', 'baseUrl', 'apiKey', 'model']
      .some((k) => Object.prototype.hasOwnProperty.call(v, k));
    if (isLegacy || (!bl && !oa)) {
      // 旧结构：按 protocol 判断归属，拆进对应一套，另一套保持默认
      const proto = v.protocol || 'openai';
      const isBailian = proto === 'paraformer-ws' || proto === 'dashscope';
      if (isBailian) {
        v.bailian = { model: v.model || BAILIAN_DEFAULT_MODEL, apiKey: v.apiKey || '', baseUrl: lfTrimUrl(v.baseUrl) };
        v.openai = Object.assign({}, DEFAULTS.voice.openai);
        v.engine = 'bailian';
      } else {
        v.openai = {
          baseUrl: lfTrimUrl(v.baseUrl) || DEFAULTS.voice.openai.baseUrl,
          model: v.model || DEFAULTS.voice.openai.model,
          apiKey: v.apiKey || ''
        };
        v.bailian = Object.assign({}, DEFAULTS.voice.bailian);
        v.engine = 'openai';
      }
    }
    // 补齐缺失的一侧，避免读到半套配置
    if (!v.bailian || typeof v.bailian !== 'object') v.bailian = Object.assign({}, DEFAULTS.voice.bailian);
    if (!v.openai || typeof v.openai !== 'object') v.openai = Object.assign({}, DEFAULTS.voice.openai);
    // 模型不在清单中（如已移除的实时流式模型）→ 回退默认模型，配置自动迁移为分片协议
    if (!BAILIAN_MODELS.some((m) => m.id === v.bailian.model)) {
      v.bailian = Object.assign({}, v.bailian, { model: BAILIAN_DEFAULT_MODEL });
    }
    if (v.engine !== 'openai' && v.engine !== 'bailian') v.engine = 'bailian';
    // 清掉旧字段，保持存储结构干净
    delete v.protocol; delete v.audioField; delete v.baseUrl; delete v.apiKey; delete v.model;
    return v;
  }

  /**
   * 把 voice 设置解析成运行时可直接消费的扁平配置（供 background / offscreen 使用）。
   * @returns {{engine:string, protocol:string, baseUrl:string, apiKey:string, model:string,
   *            audioField:string, sampleRate:number,
   *            lang:string, playbackDelayMs:number, syncVideo:boolean, videoDelayTrimMs:number}}
   */
  function lfResolveVoice(raw) {
    const v = lfMigrateVoice(raw) || {};
    const common = {
      lang: v.lang || 'auto',
      playbackDelayMs: v.playbackDelayMs || 0,
      syncVideo: !!v.syncVideo,
      videoDelayTrimMs: v.videoDelayTrimMs || 0
    };
    if (v.engine === 'openai') {
      const o = v.openai || {};
      return Object.assign(common, {
        engine: 'openai',
        protocol: 'openai',
        baseUrl: lfTrimUrl(o.baseUrl),
        apiKey: o.apiKey || '',
        model: o.model || 'whisper-1',
        audioField: 'input_audio',
        sampleRate: 16000
      });
    }
    const b = v.bailian || {};
    const m = lfBailianModel(b.model);
    return Object.assign(common, {
      engine: 'bailian',
      protocol: m.protocol,
      model: m.id,
      // 自定义地址优先（专属端点场景），留空则按模型自动推导
      baseUrl: lfTrimUrl(b.baseUrl) || m.baseUrl,
      apiKey: b.apiKey || '',
      audioField: 'input_audio',
      sampleRate: m.sampleRate || 16000
    });
  }

  /** 设置整体迁移（目前仅需处理 voice），供各加载入口统一调用 */
  function lfMigrateSettings(settings) {
    if (!settings || typeof settings !== 'object') return settings;
    if (settings.voice && typeof settings.voice === 'object') {
      const v = lfMigrateVoice(settings.voice);
      if (v) settings.voice = v;
    }
    return settings;
  }

  /**
   * 语音转写（ASR）引擎快速预设 —— 仅 OpenAI 兼容协议
   * （百炼侧已由「模型下拉框」自动推导协议与接口地址，无需预设）
   * 协议：音频以 WAV(16kHz 单声道) 5 秒分片上传
   */
  const VOICE_PRESETS = [
    { id: 'openai',      name: 'OpenAI Whisper',     baseUrl: 'https://api.openai.com/v1',     model: 'whisper-1' },
    { id: 'groq',        name: 'Groq · 极速',         baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo' },
    { id: 'siliconflow', name: '硅基流动 SenseVoice', baseUrl: 'https://api.siliconflow.cn/v1',  model: 'FunAudioLLM/SenseVoiceSmall' },
    { id: 'local',       name: '本地转写服务',         baseUrl: 'http://localhost:9000/v1',       model: 'whisper-1' }
  ];

  /** 深度合并（用于旧版本设置向前兼容） */
  function deepMerge(base, over) {
    if (Array.isArray(base) || Array.isArray(over) || over === null || typeof over !== 'object') {
      return over === undefined ? base : over;
    }
    const out = {};
    Object.keys(base).forEach((k) => { out[k] = base[k]; });
    Object.keys(over).forEach((k) => {
      if (k in out) out[k] = deepMerge(out[k], over[k]);
      else out[k] = over[k];
    });
    return out;
  }

  /* ==================== 设置校验（导入 / 脏数据收敛） ==================== */

  const PROVIDER_TYPES = ['bing-free', 'google-free', 'mymemory', 'deepl', 'openai'];

  /** 数值字段范围：[最小, 最大]。越界 clamp，非数字回落默认值 */
  const NUM_LIMITS = {
    'advanced.concurrency': [1, 8],
    'advanced.minTextLength': [1, 40],
    'advanced.maxCache': [50, 5000],
    'advanced.maxUnits': [50, 3000],
    'voice.playbackDelayMs': [0, 30000],
    'voice.videoDelayTrimMs': [-3000, 3000],
    'style.fontSize': [60, 200]
  };

  function pickPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }

  function deepClone(v) { return JSON.parse(JSON.stringify(v)); }

  /**
   * 校验并规范化一份设置（「导入设置」等外部来源统一走这里）。
   * 逐项收敛：数值 clamp / 枚举回退 / 数组长度与元素过滤 / providers 类型白名单。
   *
   * 为什么必须夹住数值：background 的缓存淘汰是 `while (_cache.size > maxCache)`，
   * maxCache 为 0 或负数时在空缓存上恒真（delete(undefined) 不改变 size）→ service worker
   * 直接死循环卡死，之后所有翻译请求都没有响应。脏值必须在入库前就被夹到安全区间。
   * @returns {{settings: object, fixes: string[]}} fixes 为被修正项的可读描述
   */
  function lfValidateSettings(input) {
    const fixes = [];
    const src = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
    const S = deepMerge(deepClone(DEFAULTS), src);

    // voice 先做旧结构迁移，后续数值 clamp 才对得上字段位置
    if (S.voice && typeof S.voice === 'object') S.voice = lfMigrateVoice(S.voice) || deepClone(DEFAULTS.voice);

    // ---- 数值：clamp ----
    Object.keys(NUM_LIMITS).forEach((path) => {
      const lo = NUM_LIMITS[path][0];
      const hi = NUM_LIMITS[path][1];
      const raw = pickPath(S, path);
      const n = typeof raw === 'number' ? raw : parseFloat(raw);
      const v = Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : pickPath(DEFAULTS, path);
      if (v === raw) return;
      const parts = path.split('.');
      let obj = S;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!obj[parts[i]] || typeof obj[parts[i]] !== 'object') {
          obj[parts[i]] = deepClone(pickPath(DEFAULTS, parts.slice(0, i + 1).join('.')) || {});
        }
        obj = obj[parts[i]];
      }
      obj[parts[parts.length - 1]] = v;
      fixes.push(path + '：' + JSON.stringify(raw) + ' → ' + v);
    });

    // ---- providers：类型白名单 / id 去重 / 字段规范化 ----
    const seenIds = {};
    const provs = [];
    (Array.isArray(S.providers) ? S.providers : []).slice(0, 20).forEach((p, i) => {
      if (!p || typeof p !== 'object' || Array.isArray(p)) {
        fixes.push('providers[' + i + ']：不是对象，已丢弃');
        return;
      }
      if (PROVIDER_TYPES.indexOf(p.type) === -1) {
        fixes.push('providers[' + i + ']：未知引擎类型 ' + JSON.stringify(p.type) + '，已丢弃');
        return;
      }
      let id = typeof p.id === 'string' && p.id.trim() ? p.id.trim().slice(0, 64) : p.type + '-' + i;
      if (seenIds[id]) {
        id = id + '-' + i;
        fixes.push('providers[' + i + ']：id 重复，已改为 ' + id);
      }
      seenIds[id] = 1;
      const q = {
        id,
        type: p.type,
        name: String(p.name == null ? '' : p.name).slice(0, 60) || p.type,
        enabled: p.enabled !== false
      };
      if (p.baseUrl != null) q.baseUrl = String(p.baseUrl).slice(0, 300);
      if (p.model != null) q.model = String(p.model).slice(0, 120);
      if (p.apiKey != null) q.apiKey = String(p.apiKey).slice(0, 500);
      if (p.plan != null) q.plan = p.plan === 'pro' ? 'pro' : 'free';
      if (p.promptTemplate != null) q.promptTemplate = String(p.promptTemplate).slice(0, 2000);
      if (p.temperature != null) {
        const t = parseFloat(p.temperature);
        q.temperature = Number.isFinite(t) ? Math.min(2, Math.max(0, t)) : 0.1;
      }
      if (p.builtin) q.builtin = true;
      provs.push(q);
    });
    if (!provs.length) {
      provs.push.apply(provs, deepClone(DEFAULTS.providers));
      fixes.push('providers：为空或全部无效，已恢复默认引擎列表');
    }
    S.providers = provs;

    if (!provs.some((p) => p.id === S.activeProviderId)) {
      const first = provs.filter((p) => p.enabled !== false)[0] || provs[0];
      fixes.push('activeProviderId：' + JSON.stringify(S.activeProviderId) + ' → ' + first.id);
      S.activeProviderId = first.id;
    }

    // ---- 枚举 / 语言 ----
    if (['bilingual', 'replace', 'hover'].indexOf(S.displayMode) === -1) {
      fixes.push('displayMode：' + JSON.stringify(S.displayMode) + ' → bilingual');
      S.displayMode = 'bilingual';
    }

    S.customLangs = (Array.isArray(S.customLangs) ? S.customLangs : []).slice(0, 50).filter((l) => (
      l && typeof l === 'object'
      && typeof l.code === 'string' && /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i.test(l.code)
      && !(g.LF && g.LF.BY_CODE && g.LF.BY_CODE[l.code])
    )).map((l) => ({
      code: String(l.code).toLowerCase().slice(0, 12),
      label: String(l.label || l.code).slice(0, 40),
      name: String(l.name || l.code).slice(0, 40)
    }));

    const knownLang = (code) => {
      if (typeof code !== 'string') return false;
      if (code === 'auto') return true;
      if (g.LF && g.LF.BY_CODE && g.LF.BY_CODE[code]) return true;
      return S.customLangs.some((l) => l.code === code);
    };
    if (S.targetLang === 'auto' || !knownLang(S.targetLang)) {
      fixes.push('targetLang：' + JSON.stringify(S.targetLang) + ' → ' + DEFAULTS.targetLang);
      S.targetLang = DEFAULTS.targetLang;
    }
    if (!knownLang(S.sourceLang)) {
      fixes.push('sourceLang：' + JSON.stringify(S.sourceLang) + ' → auto');
      S.sourceLang = 'auto';
    }

    S.quickLangs = (Array.isArray(S.quickLangs) ? S.quickLangs : [])
      .filter((c, i, arr) => typeof c === 'string' && c !== 'auto' && arr.indexOf(c) === i)
      .slice(0, 20);
    if (!S.quickLangs.length) S.quickLangs = deepClone(DEFAULTS.quickLangs);

    // ---- 站点规则 / 黑名单 ----
    S.blacklist = (Array.isArray(S.blacklist) ? S.blacklist : [])
      .filter((h) => typeof h === 'string' && h && h.length < 255)
      .slice(0, 500);

    const rules = {};
    const rawRules = (S.siteRules && typeof S.siteRules === 'object') ? S.siteRules : {};
    Object.keys(rawRules).slice(0, 500).forEach((h) => {
      const r = rawRules[h];
      if (typeof h === 'string' && h && r && typeof r === 'object') rules[h.slice(0, 255)] = { auto: !!r.auto };
    });
    S.siteRules = rules;

    // ---- 展示样式 / 视频字幕 ----
    if (!S.style || typeof S.style !== 'object') S.style = deepClone(DEFAULTS.style);
    if (typeof S.style.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(S.style.color)) S.style.color = '';
    S.style.showBadge = S.style.showBadge !== false;

    S.videoSubtitle = {
      enabled: !(S.videoSubtitle && S.videoSubtitle.enabled === false),
      bilingual: !(S.videoSubtitle && S.videoSubtitle.bilingual === false)
    };

    S.autoTranslate = !!S.autoTranslate;
    S.selectionToolbar = S.selectionToolbar !== false;

    return { settings: S, fixes };
  }

  /* ==================== 密钥与「公开设置」拆分 ==================== */
  /*
   * 为什么要拆：chrome.storage.sync 会随用户登录的 Chrome 账号同步到其它设备，
   * 与设置页「不会上传到任何服务器」的表述冲突；而内容脚本只需要语言、样式、
   * 引擎名这类公开字段，完全没必要读到 API Key。
   * 约定：settings（sync）只放公开设置；lf:secrets（local）只放密钥。
   */

  /**
   * 拆出密钥，返回不含 apiKey 的公开设置副本。
   * @returns {{pub: object, secrets: {providers: object, voice: object}, hadKeys: boolean}}
   */
  function lfSplitSecrets(settings) {
    const pub = deepClone(settings || {});
    const secrets = { providers: {}, voice: {} };
    let hadKeys = false;
    if (Array.isArray(pub.providers)) {
      pub.providers.forEach((p) => {
        if (!p || typeof p !== 'object') return;
        if (typeof p.apiKey === 'string' && p.apiKey) {
          secrets.providers[p.id] = p.apiKey;
          hadKeys = true;
        }
        delete p.apiKey;
      });
    }
    const v = pub.voice;
    if (v && typeof v === 'object') {
      if (v.bailian && typeof v.bailian === 'object') {
        if (v.bailian.apiKey) { secrets.voice.bailian = v.bailian.apiKey; hadKeys = true; }
        delete v.bailian.apiKey;
      }
      if (v.openai && typeof v.openai === 'object') {
        if (v.openai.apiKey) { secrets.voice.openai = v.openai.apiKey; hadKeys = true; }
        delete v.openai.apiKey;
      }
    }
    return { pub, secrets, hadKeys };
  }

  /** 把密钥合并回设置（返回新对象，不修改入参） */
  function lfApplySecrets(settings, secrets) {
    const out = deepClone(settings || {});
    const s = secrets || {};
    const sp = s.providers || {};
    if (Array.isArray(out.providers)) {
      out.providers.forEach((p) => {
        if (p && p.id && typeof sp[p.id] === 'string' && sp[p.id]) p.apiKey = sp[p.id];
      });
    }
    if (out.voice && typeof out.voice === 'object') {
      const sv = s.voice || {};
      if (out.voice.bailian && typeof out.voice.bailian === 'object' && sv.bailian) out.voice.bailian.apiKey = sv.bailian;
      if (out.voice.openai && typeof out.voice.openai === 'object' && sv.openai) out.voice.openai.apiKey = sv.openai;
    }
    return out;
  }

  /** 合并两组密钥（over 覆盖 base，空值不覆盖） */
  function lfMergeSecrets(base, over) {
    const a = base || {};
    const b = over || {};
    const pick = (x, y) => {
      const out = {};
      Object.keys(x || {}).forEach((k) => { if (x[k]) out[k] = x[k]; });
      Object.keys(y || {}).forEach((k) => { if (y[k]) out[k] = y[k]; });
      return out;
    };
    return {
      providers: pick(a.providers, b.providers),
      voice: pick(a.voice, b.voice)
    };
  }

  /* ==================== 接口地址校验 ==================== */

  /**
   * 校验自定义接口地址。远程地址必须 https，http 只允许本机 / 局域网调试地址——
   * 否则 Bearer Key、页面正文与录音数据会在明文链路上外发。
   * @returns {{ok: boolean, url?: string, local?: boolean, error?: string}}
   */
  /**
   * 严格解析 IPv4 并判断是否属于私有/回环/链路本地网段。
   * 不能用 /^10\./ 这类前缀匹配：`10.attacker.example` 是普通域名，
   * 放行它等于允许把 API Key 明文发到公网主机。
   */
  function lfIsPrivateIPv4(host) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!m) return false;
    const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    if (o.some((n) => n > 255)) return false;
    if (o[0] === 10 || o[0] === 127) return true;              // 10/8、回环
    if (o[0] === 192 && o[1] === 168) return true;             // 192.168/16
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;  // 172.16/12
    if (o[0] === 169 && o[1] === 254) return true;             // 169.254/16 链路本地
    return false;
  }

  /** IPv6 只认回环、ULA(fc00::/7)、链路本地(fe80::/10) */
  function lfIsPrivateIPv6(host) {
    const h = host.replace(/^\[|\]$/g, '');
    if (h === '::1') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
    if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
    return false;
  }

  function lfValidateEndpoint(raw) {
    const trimmed = String(raw || '').trim().replace(/\/+$/, '');
    if (!trimmed) return { ok: false, error: '请填写接口地址' };
    let u;
    try { u = new URL(trimmed); } catch (e) { return { ok: false, error: '接口地址格式不正确，需以 http(s):// 开头' }; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: '接口地址只支持 http / https' };
    const host = u.hostname.toLowerCase();
    const local = host === 'localhost' || /\.localhost$/.test(host)  // RFC 6761：始终指向本机
      || lfIsPrivateIPv4(host) || lfIsPrivateIPv6(host)
      || /\.local$/.test(host);                                     // mDNS：只在本局域网内解析
    if (u.protocol === 'http:' && !local) {
      return { ok: false, local, error: '远程地址必须使用 https（http 仅允许 localhost / 内网 IP 等局域网地址）' };
    }
    return { ok: true, url: trimmed, local };
  }

  g.LF_DEFAULTS = DEFAULTS;
  g.LF_PRESETS = PRESETS;
  g.LF_VOICE_PRESETS = VOICE_PRESETS;
  g.LF_BAILIAN_MODELS = BAILIAN_MODELS;
  g.LF_BAILIAN_DEFAULT_MODEL = BAILIAN_DEFAULT_MODEL;
  g.LF_BAILIAN_MODEL = lfBailianModel;
  g.LF_MIGRATE_VOICE = lfMigrateVoice;
  g.LF_MIGRATE_SETTINGS = lfMigrateSettings;
  g.LF_RESOLVE_VOICE = lfResolveVoice;
  g.LF_MERGE = deepMerge;
  g.LF_VALIDATE_SETTINGS = lfValidateSettings;
  g.LF_SPLIT_SECRETS = lfSplitSecrets;
  g.LF_APPLY_SECRETS = lfApplySecrets;
  g.LF_MERGE_SECRETS = lfMergeSecrets;
  g.LF_VALIDATE_ENDPOINT = lfValidateEndpoint;
})(globalThis);
