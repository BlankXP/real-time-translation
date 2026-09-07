/*
 * BPFlow — 共享语言数据与工具函数
 * 该文件不依赖任何 chrome API，可同时被以下环境加载：
 *   - Service Worker（importScripts）
 *   - 内容脚本 / 扩展页面（<script> 标签）
 *   - 普通浏览器（用于 UI 预览）
 */
(function (g) {
  'use strict';

  /** 语言表：code 为内部统一编码（与 Google/Bing 风格一致） */
  const LANGS = [
    { code: 'auto',   label: 'Auto Detect',    name: '自动检测' },
    { code: 'zh-CN',  label: 'Chinese (Simplified)',  name: '中文（简体）' },
    { code: 'zh-TW',  label: 'Chinese (Traditional)', name: '中文（繁體）' },
    { code: 'en',     label: 'English',        name: 'English' },
    { code: 'ja',     label: 'Japanese',       name: '日本語' },
    { code: 'ko',     label: 'Korean',         name: '한국어' },
    { code: 'fr',     label: 'French',         name: 'Français' },
    { code: 'de',     label: 'German',         name: 'Deutsch' },
    { code: 'es',     label: 'Spanish',        name: 'Español' },
    { code: 'pt',     label: 'Portuguese',     name: 'Português' },
    { code: 'ru',     label: 'Russian',        name: 'Русский' },
    { code: 'it',     label: 'Italian',        name: 'Italiano' },
    { code: 'nl',     label: 'Dutch',          name: 'Nederlands' },
    { code: 'pl',     label: 'Polish',         name: 'Polski' },
    { code: 'tr',     label: 'Turkish',        name: 'Türkçe' },
    { code: 'ar',     label: 'Arabic',         name: 'العربية' },
    { code: 'th',     label: 'Thai',           name: 'ไทย' },
    { code: 'vi',     label: 'Vietnamese',     name: 'Tiếng Việt' },
    { code: 'id',     label: 'Indonesian',     name: 'Bahasa Indonesia' },
    { code: 'hi',     label: 'Hindi',          name: 'हिन्दी' },
    { code: 'uk',     label: 'Ukrainian',      name: 'Українська' },
    { code: 'sv',     label: 'Swedish',        name: 'Svenska' },
    { code: 'da',     label: 'Danish',         name: 'Dansk' },
    { code: 'fi',     label: 'Finnish',        name: 'Suomi' },
    { code: 'nb',     label: 'Norwegian',      name: 'Norsk' },
    { code: 'cs',     label: 'Czech',          name: 'Čeština' },
    { code: 'el',     label: 'Greek',          name: 'Ελληνικά' },
    { code: 'he',     label: 'Hebrew',         name: 'עברית' },
    { code: 'hu',     label: 'Hungarian',      name: 'Magyar' },
    { code: 'ro',     label: 'Romanian',       name: 'Română' },
    { code: 'ms',     label: 'Malay',          name: 'Bahasa Melayu' },
    { code: 'bn',     label: 'Bengali',        name: 'বাংলা' },
    { code: 'fa',     label: 'Persian',        name: 'فارسی' }
  ];

  const BY_CODE = {};
  LANGS.forEach((l) => { BY_CODE[l.code] = l; });

  /** Bing / Edge Translator 编码映射 */
  const BING_MAP = { 'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant' };
  /** DeepL 编码映射（其余取大写） */
  const DEEPL_MAP = { 'zh-CN': 'ZH', 'zh-TW': 'ZH', 'en': 'EN-US', 'pt': 'PT-BR', 'nb': 'NB', 'auto': '' };

  function toBing(code) { return BING_MAP[code] || code; }
  function toDeepl(code) { return DEEPL_MAP[code] || String(code).toUpperCase(); }
  function langName(code) { const l = BY_CODE[code]; return l ? l.name : code; }
  function langLabel(code) { const l = BY_CODE[code]; return l ? l.label : code; }

  /** 轻量语种探测（供不支持 auto 的引擎使用） */
  function quickDetect(text) {
    const t = String(text || '');
    if (/[\u4e00-\u9fff]/.test(t)) return 'zh-CN';
    if (/[\u3040-\u309f\u30a0-\u30ff]/.test(t)) return 'ja';
    if (/[\uac00-\ud7af]/.test(t)) return 'ko';
    if (/[\u0400-\u04ff]/.test(t)) return 'ru';
    if (/[\u0600-\u06ff]/.test(t)) return 'ar';
    if (/[\u0590-\u05ff]/.test(t)) return 'he';
    if (/[\u0e00-\u0e7f]/.test(t)) return 'th';
    if (/[\u0900-\u097f]/.test(t)) return 'hi';
    return 'en';
  }

  /** 引擎元信息（设置页/弹窗展示用） */
  const ENGINES = {
    'bing-free':    { label: 'Bing 翻译',     tag: '免费内置', desc: '微软 Edge 同源翻译服务，开箱即用，无需任何配置' },
    'google-free':  { label: 'Google 翻译',   tag: '免费内置', desc: 'Google 翻译公共接口，无需配置，逐句请求' },
    'openai':       { label: 'AI 模型',       tag: 'OpenAI 兼容', desc: '任意 OpenAI 兼容接口：DeepSeek / Kimi / GLM / 通义 / Groq / Ollama 等' },
    'deepl':        { label: 'DeepL',         tag: 'API Key', desc: '以译文质量著称，需在官网申请 API 密钥' },
    'mymemory':     { label: 'MyMemory',      tag: '免费', desc: '开源翻译记忆库接口，适合轻量使用' }
  };

  g.LF = { LANGS, BY_CODE, toBing, toDeepl, langName, langLabel, quickDetect, ENGINES };
})(globalThis);
