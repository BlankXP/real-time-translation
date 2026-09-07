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
})(globalThis);
