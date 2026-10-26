/*
 * BPFlow — 跨环境通用小工具（内容脚本 / 设置页 / 弹窗共用）
 *
 * 为什么单独一个文件：esc 与 send 曾经各有 3~4 份拷贝，
 * 「某一份修了转义规则、其余漏改」是这类代码最典型的翻车方式。
 * 这里只放两个无状态函数，不依赖任何其它模块（只依赖 globalThis.chrome）。
 */
(function (g) {
  'use strict';

  /** HTML 转义：任何拼进 innerHTML 的动态文本都必须过它 */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  /**
   * Promise 化 chrome.runtime.sendMessage。
   * 扩展重载 / 页面被销毁后 runtime 会失效：回调里的 lastError 必须读一次否则控制台报警，
   * 同步抛错也要接住 —— 统一返回 null，调用方只需判空。
   */
  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; resolve(r || null); });
      } catch (e) { resolve(null); }
    });
  }

  g.LF_DOM = { esc, send };
})(globalThis);
