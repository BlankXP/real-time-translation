/*
 * BPFlow — 浏览器预览垫片
 * 在非扩展环境（直接用浏览器打开 popup/options 页面）模拟最小 chrome API，
 * 便于预览与调试 UI。真实扩展环境中此脚本不做任何事。
 */
(function () {
  'use strict';
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) return;

  window.__LF_PREVIEW__ = true;

  const LS_KEY = 'lf-preview-settings';
  function readStore() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { return null; }
  }
  let data = readStore();
  if (!data) {
    data = JSON.parse(JSON.stringify(globalThis.LF_DEFAULTS || {}));
    // 预览演示：多启用一个 AI 供应商，便于查看完整卡片效果
    data.providers = data.providers.concat([{
      id: 'demo-ai', type: 'openai', name: 'DeepSeek', enabled: true,
      baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat', temperature: 0.1
    }]);
  }

  const listeners = [];
  function makeArea() {
    return {
      get(keys, cb) {
        const p = new Promise((resolve) => {
          let result = {};
          if (keys === null || keys === undefined) result = JSON.parse(JSON.stringify(data));
          else if (typeof keys === 'string') result = { [keys]: data[keys] };
          else if (Array.isArray(keys)) keys.forEach((k) => { result[k] = data[k]; });
          else if (typeof keys === 'object') Object.keys(keys).forEach((k) => { result[k] = k in data ? data[k] : keys[k]; });
          resolve(result);
        });
        return cb ? (p.then(cb), undefined) : p;
      },
      set(obj, cb) {
        const p = new Promise((resolve) => {
          Object.keys(obj).forEach((k) => { data[k] = obj[k]; });
          localStorage.setItem(LS_KEY, JSON.stringify(data));
          listeners.forEach((fn) => { try { fn({ settings: { newValue: JSON.parse(JSON.stringify(data)) } }, 'sync'); } catch (e) { /* noop */ } });
          resolve();
        });
        return cb ? (p.then(cb), undefined) : p;
      }
    };
  }

  window.chrome = {
    storage: {
      sync: makeArea(),
      local: makeArea(),
      onChanged: { addListener(fn) { listeners.push(fn); } }
    },
    runtime: {
      id: 'preview',
      getManifest: () => ({ version: '1.1.0', name: 'BPFlow 实时翻译（预览）' }),
      openOptionsPage: () => { location.href = '../options/options.html'; },
      sendMessage: (msg, cb) => { if (typeof cb === 'function') cb(null); return Promise.resolve(null); },
      onMessage: { addListener() { /* noop */ } },
      getURL: (p) => p
    },
    tabs: {
      query: async () => [{ id: 1, url: 'https://example.com/preview', title: '预览标签页' }],
      sendMessage: (tabId, msg, cb) => { if (typeof cb === 'function') cb(null); return Promise.resolve(null); }
    }
  };
})();
