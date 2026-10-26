/*
 * 测试辅助：把扩展脚本按需加载进 node。
 * 项目本身无构建步骤、无第三方依赖，测试只用 node 内置能力。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

/**
 * 加载 shared/ 下的脚本（它们都是 (function(g){...})(globalThis)，会把符号挂到 globalThis）。
 * @param {string} rel 相对仓库根目录的路径
 */
function loadShared(rel) {
  const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  (0, eval)(code); // 间接 eval → 全局作用域执行
}

/**
 * 从某个脚本里截取一段源码并求值，返回其中声明的符号。
 * 用于测试内嵌在大文件里的纯函数，避免为测试而改动运行时结构。
 * @param {string} rel 脚本路径
 * @param {string} from 起始标记（含）
 * @param {string} to 结束标记（不含）
 * @param {string[]} names 需要取出的顶层函数名
 * @returns {Object<string, Function>}
 */
function loadSlice(rel, from, to, names) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  if (a < 0 || b < 0 || b <= a) {
    throw new Error('源码切片失败：' + rel + ' [' + from + ' → ' + to + ']');
  }
  // 用 new Function 而不是 eval：切片里的函数声明不会污染本模块作用域
  const factory = new Function(src.slice(a, b) + '\nreturn {' + names.join(',') + '};');
  return factory();
}

module.exports = { ROOT, loadShared, loadSlice, bootBackground, askBackground };

/* ============================== background.js 测试桩 ============================== */

/** 内存版 chrome.storage 区域 */
function makeArea(store) {
  return {
    async get(keys) {
      if (keys == null) return Object.assign({}, store);
      if (typeof keys === 'string') return { [keys]: store[keys] };
      if (Array.isArray(keys)) {
        const out = {};
        keys.forEach((k) => { out[k] = store[k]; });
        return out;
      }
      const out = {};
      Object.keys(keys).forEach((k) => { out[k] = k in store ? store[k] : keys[k]; });
      return out;
    },
    async set(obj) { Object.assign(store, JSON.parse(JSON.stringify(obj))); },
    async remove(keys) { (Array.isArray(keys) ? keys : [keys]).forEach((k) => { delete store[k]; }); },
    async clear() { Object.keys(store).forEach((k) => { delete store[k]; }); }
  };
}

/**
 * 在 node 里用最小 chrome 桩跑真实的 background.js。
 * @param {{sync?:object, local?:object, failLocalSet?:boolean, fetch?:Function}} seed
 *   fetch 可换成自定义桩（默认返回一段 OpenAI 格式译文）
 * @returns {{sandbox, sync, local, session, calls, flags, fetchStats, send}}
 */
function bootBackground(seed) {
  const s = seed || {};
  const sync = JSON.parse(JSON.stringify(s.sync || {}));
  const local = JSON.parse(JSON.stringify(s.local || {}));
  const session = {};
  const calls = [];                            // 记录后台发出的请求，供断言检查 Authorization
  const fetchStats = { inflight: 0, maxInflight: 0 };
  const flags = { failLocalSet: !!s.failLocalSet, localSetCalls: 0 };
  let onMessage = null;

  const noop = () => {};
  const event = () => ({ addListener: noop, removeListener: noop, hasListener: () => false });

  // local.set 可被切成失败，用于验证「迁移失败时不能抹掉 sync」
  const localArea = makeArea(local);
  const rawLocalSet = localArea.set;
  localArea.set = async (obj) => {
    flags.localSetCalls++;
    if (flags.failLocalSet) throw new Error('QUOTA_BYTES exceeded');
    return rawLocalSet(obj);
  };

  const defaultFetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content: '["ok"]' } }] })
  });

  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, AbortController, TextEncoder, TextDecoder,
    fetch: async (url, opts) => {
      calls.push({ url, opts: opts || {} });
      fetchStats.inflight++;
      fetchStats.maxInflight = Math.max(fetchStats.maxInflight, fetchStats.inflight);
      try {
        return await (s.fetch || defaultFetch)(url, opts);
      } finally {
        fetchStats.inflight--;
      }
    },
    self: {},
    chrome: {
      storage: {
        sync: makeArea(sync),
        local: localArea,
        session: makeArea(session),
        onChanged: { addListener: noop }
      },
      runtime: {
        id: 'test',
        lastError: null,
        onMessage: { addListener: (fn) => { onMessage = fn; } },
        onInstalled: event(),
        onStartup: event(),
        onConnect: event(),
        sendMessage: noop,
        getURL: (p) => p,
        getManifest: () => ({ version: 'test' }),
        getContexts: async () => []
      },
      action: { onClicked: event(), setTitle: noop },
      commands: { onCommand: event() },
      contextMenus: { removeAll: noop, create: noop, onClicked: event() },
      tabs: { query: async () => [], sendMessage: noop, onRemoved: event(), onUpdated: event() },
      offscreen: { createDocument: async () => {}, closeDocument: async () => {} },
      scripting: { executeScript: async () => {} }
    },
    importScripts: (...files) => {
      files.forEach((f) => {
        const abs = path.resolve(ROOT, 'background', f);
        vm.runInContext(fs.readFileSync(abs, 'utf8'), sandbox, { filename: abs });
      });
    }
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  const bg = path.join(ROOT, 'background', 'background.js');
  vm.runInContext(fs.readFileSync(bg, 'utf8'), sandbox, { filename: bg });

  return { sandbox, sync, local, session, calls, flags, fetchStats, send: (msg) => askBackground(onMessage, msg) };
}

/** 触发 onMessage 监听器并等待 sendResponse */
function askBackground(listener, msg) {
  return new Promise((resolve) => {
    let done = false;
    listener(msg, {}, (resp) => { done = true; resolve(resp); });
    setTimeout(() => { if (!done) resolve(null); }, 1500);
  });
}
