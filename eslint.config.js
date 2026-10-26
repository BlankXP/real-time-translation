/*
 * ESLint flat config —— 目标不是风格统一，而是挡住「真会出问题」的那类错误：
 * 未定义变量、重复声明、不可达代码、漏 await 之类的笔误。
 * 运行：npm run lint（依赖 eslint + globals，仅开发期使用，不影响扩展打包）
 */
'use strict';

const globals = require('globals');

/** shared/*.js 挂到 globalThis 的共享符号 */
const LF_GLOBALS = {
  LF: 'readonly',
  LF_DEFAULTS: 'readonly',
  LF_MERGE: 'readonly',
  LF_PRESETS: 'readonly',
  LF_VOICE_PRESETS: 'readonly',
  LF_BAILIAN_MODELS: 'readonly',
  LF_BAILIAN_DEFAULT_MODEL: 'readonly',
  LF_BAILIAN_MODEL: 'readonly',
  LF_MIGRATE_VOICE: 'readonly',
  LF_MIGRATE_SETTINGS: 'readonly',
  LF_RESOLVE_VOICE: 'readonly',
  LF_VALIDATE_SETTINGS: 'readonly',
  LF_SPLIT_SECRETS: 'readonly',
  LF_APPLY_SECRETS: 'readonly',
  LF_MERGE_SECRETS: 'readonly',
  LF_VALIDATE_ENDPOINT: 'readonly',
  LF_CORE: 'readonly',
  LF_DOM: 'readonly',
  LF_ENGINES: 'readonly',
  LF_SCAN: 'readonly',
  LF_MARKS: 'readonly',
  LF_UI_CSS: 'readonly',
  LF_VIEW: 'readonly'
};

const RULES = {
  // ---- 真错误 ----
  'no-undef': 'error',
  // 文件头部的 /* global LF */ 是给编辑器看的，与配置里的 globals 重复，不算错误
  'no-redeclare': ['error', { builtinGlobals: false }],
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-dupe-else-if': 'error',
  'no-unreachable': 'error',
  'no-fallthrough': 'error',
  'no-cond-assign': 'error',
  'no-self-assign': 'error',
  'no-unsafe-negation': 'error',
  'no-unsafe-optional-chaining': 'error',
  'valid-typeof': 'error',
  'use-isnan': 'error',

  // ---- 容易出 bug 的写法 ----
  'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
  'no-empty': ['warn', { allowEmptyCatch: true }],
  'no-prototype-builtins': 'warn',
  'no-var': 'warn',
  'eqeqeq': ['warn', 'smart'],
  'no-constant-condition': ['warn', { checkLoops: false }],
  'no-async-promise-executor': 'warn',
  'require-atomic-updates': 'off',
  'no-useless-escape': 'warn'
};

module.exports = [
  {
    ignores: ['node_modules/**', 'demo/**', '**/*.min.js']
  },

  // 扩展脚本：内容脚本 / 扩展页面（浏览器环境 + 扩展 API）
  {
    files: ['background/**/*.js', 'content/**/*.js', 'options/**/*.js', 'popup/**/*.js', 'offscreen/**/*.js', 'shared/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: Object.assign({}, globals.browser, globals.webextensions, globals.worker, LF_GLOBALS, {
        // 预览垫片用的标记
        __LF_PREVIEW__: 'readonly'
      })
    },
    rules: RULES
  },

  // 测试与工具脚本：CommonJS + node 内置模块
  {
    files: ['tests/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: Object.assign({}, globals.node, globals.es2023, LF_GLOBALS)
    },
    rules: RULES
  },

  // 本配置文件自身
  {
    files: ['eslint.config.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: Object.assign({}, globals.node) },
    rules: { 'no-undef': 'error' }
  }
];
