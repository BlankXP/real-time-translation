/*
 * BPFlow — 译文在页面上的落地（DOM 标记层）
 * 职责：把一段译文按展示模式插进页面 / 打样式 / 出错占位。
 * 与主流程解耦：不读全局状态，settings 由调用方传入，方便单独阅读与替换。
 * 依赖：document / requestAnimationFrame（内容脚本环境）。
 */
(function (g) {
  'use strict';

  /** 按设置给译文元素上色 / 字号 / 徽标 */
  function applyStyleTo(el, settings) {
    const s = (settings && settings.style) || {};
    if (s.color) el.style.color = s.color; else el.style.removeProperty('color');
    el.style.fontSize = ((s.fontSize || 95) / 100) + 'em';
    if (s.showBadge) el.setAttribute('data-badge', '1');
    else el.removeAttribute('data-badge');
  }

  function makeTranslationEl(text, isError, settings) {
    const el = document.createElement('lf-translation');
    el.setAttribute('data-lf-skip', '1');
    el.className = 'lf-translation' + (isError ? ' lf-error' : '');
    applyStyleTo(el, settings);
    el.textContent = text;
    return el;
  }

  /** 设置里的样式变了：给页面上已有的译文重新上样式 */
  function reapplyStyles(doc, settings) {
    doc.querySelectorAll('lf-translation.lf-translation').forEach((el) => applyStyleTo(el, settings));
  }

  /**
   * 把译文落到块上。
   * bilingual：在块后插入 <lf-translation>；replace：原文收进 <lf-original>、译文放 <lf-text>；
   * hover：只挂 data-lf-hoverText，由鼠标事件出 tooltip。
   * @param {Element} block 目标块
   * @param {?string} translated null 表示翻译失败（双语模式下插一条错误占位）
   * @param {object} settings 当前设置（读 displayMode / style）
   */
  function applyTranslation(block, translated, settings) {
    const mode = (settings && settings.displayMode) || 'bilingual';
    block.dataset.lfDone = '1';

    if (translated == null) {
      if (mode === 'bilingual' && !(block.nextElementSibling && block.nextElementSibling._lf)) {
        const err = makeTranslationEl('⚠ 此段翻译失败', true, settings);
        err._lf = true;
        block.after(err);
        requestAnimationFrame(() => err.classList.add('lf-in'));
      }
      return;
    }

    if (mode === 'bilingual') {
      const next = block.nextElementSibling;
      if (next && next.tagName === 'LF-TRANSLATION') return;
      const el = makeTranslationEl(translated, false, settings);
      block.after(el);
      requestAnimationFrame(() => el.classList.add('lf-in'));
    } else if (mode === 'replace') {
      if (!block.querySelector(':scope > lf-original')) {
        const holder = document.createElement('lf-original');
        holder.setAttribute('data-lf-skip', '1');
        while (block.firstChild) holder.appendChild(block.firstChild);
        block.appendChild(holder);
      }
      if (!block.querySelector(':scope > lf-text')) {
        const t = document.createElement('lf-text');
        t.setAttribute('data-lf-skip', '1');
        t.textContent = translated;
        block.appendChild(t);
      }
      block.classList.add('lf-replaced');
    } else { // hover
      block.dataset.lfHoverText = translated;
      block.classList.add('lf-hoverable');
    }
  }

  g.LF_MARKS = { applyStyleTo, makeTranslationEl, reapplyStyles, applyTranslation };
})(globalThis);
