/*
 * BPFlow — 内容脚本的 Shadow DOM 样式（类纸风格）
 * 悬浮球 / 快捷面板 / 进度条 / Tooltip / 划词浮条 / Toast 全部在这里，
 * 挂在 #lf-ui-host 的 Shadow Root 内，页面 CSS 影响不到，也不污染页面。
 *
 * 设计语言：米色纸面 + 墨色文字 + 朱砂印章做强调；描边代替发光，
 * 圆角收敛，分隔线用虚线（像装订线/撕口）。
 * 依赖：无（纯字符串），由 content.js 读取 LF_UI_CSS。
 */
(function (g) {
  'use strict';

  const UI_CSS = `
    :host {
      all: initial;
      --paper: #fbf7ee;
      --paper-2: #f4eddd;
      --line: rgba(72, 58, 40, 0.18);
      --line-2: rgba(72, 58, 40, 0.32);
      --ink: #2b2723;
      --ink-2: #57503f;
      --ink-3: #8a8071;
      --seal: #b23a2f;
      --serif: "Songti SC", "Noto Serif SC", "Source Han Serif SC", STSong, SimSun, Georgia, serif;
      font-family: -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: inherit; }

    /* ---- 悬浮球：一枚朱砂印 ---- */
    #lf-ball {
      position: fixed; width: 46px; height: 46px; border-radius: 50%;
      background: radial-gradient(circle at 32% 26%, #c14a3c 0%, #ab382c 45%, #93301f 100%);
      box-shadow:
        0 0 0 1px rgba(112, 32, 24, 0.55),
        inset 0 1px 0 rgba(255, 246, 232, 0.35),
        inset 0 -2px 6px rgba(80, 20, 14, 0.35),
        0 6px 16px rgba(90, 55, 35, 0.28);
      cursor: pointer; user-select: none; -webkit-user-select: none;
      display: flex; align-items: center; justify-content: center;
      z-index: 2147483600; transition: transform .18s ease, box-shadow .18s ease;
      touch-action: none;
    }
    #lf-ball:hover {
      transform: scale(1.06);
      box-shadow:
        0 0 0 1px rgba(112, 32, 24, 0.6),
        inset 0 1px 0 rgba(255, 246, 232, 0.4),
        inset 0 -2px 6px rgba(80, 20, 14, 0.35),
        0 10px 22px rgba(90, 55, 35, 0.34);
    }
    #lf-ball.dragging { transition: none; transform: scale(1.02); cursor: grabbing; }
    #lf-ball svg { width: 24px; height: 24px; pointer-events: none; }
    #lf-ball .dot {
      position: absolute; right: 1px; top: 1px; width: 11px; height: 11px; border-radius: 50%;
      border: 2px solid #fbf7ee; background: #8a8071; pointer-events: none;
    }
    #lf-ball.on .dot { background: #4a7c59; }
    #lf-ball.working .dot { background: #a2701c; animation: lf-pulse 1s ease infinite; }
    #lf-ball.working { animation: lf-ring 1.6s ease infinite; }
    @keyframes lf-pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
    @keyframes lf-ring {
      0% { box-shadow: 0 0 0 0 rgba(178, 58, 47, 0.45), 0 6px 16px rgba(90, 55, 35, 0.28); }
      70% { box-shadow: 0 0 0 12px rgba(178, 58, 47, 0), 0 6px 16px rgba(90, 55, 35, 0.28); }
      100% { box-shadow: 0 0 0 0 rgba(178, 58, 47, 0), 0 6px 16px rgba(90, 55, 35, 0.28); }
    }

    /* ---- 面板：一张纸片 ---- */
    #lf-panel {
      position: fixed; width: 292px;
      background-color: var(--paper);
      background-image:
        radial-gradient(120% 80% at 50% -20%, #fffdf8 0%, rgba(255, 253, 248, 0) 65%),
        repeating-linear-gradient(0deg, rgba(96, 78, 52, 0.026) 0 1px, rgba(0, 0, 0, 0) 1px 4px);
      border: 1px solid var(--line);
      border-radius: 10px;
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.9),
        0 1px 2px rgba(70, 56, 38, 0.08),
        0 14px 36px -14px rgba(70, 56, 38, 0.45);
      color: var(--ink); font-size: 13px; line-height: 1.55;
      z-index: 2147483601; overflow: hidden;
      animation: lf-pop .22s cubic-bezier(.2,.9,.3,1.2) both;
    }
    @keyframes lf-pop { from { opacity: 0; transform: translateY(8px) scale(.98); } to { opacity: 1; transform: none; } }
    #lf-panel.hidden { display: none; }

    .head {
      display: flex; align-items: center; gap: 8px;
      padding: 13px 14px 10px;
      border-bottom: 1px dashed var(--line);
    }
    .brand {
      display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 14px;
      letter-spacing: .06em; flex: 1; font-family: var(--serif); color: var(--ink);
    }
    .brand .logo {
      width: 24px; height: 24px; border-radius: 5px;
      background: var(--seal); color: #fdf6ea;
      display: flex; align-items: center; justify-content: center;
      font-family: var(--serif); font-size: 13px; font-weight: 700;
      box-shadow: inset 0 0 0 1px rgba(255, 246, 232, 0.35);
    }
    .icon-btn {
      width: 24px; height: 24px; border: none; border-radius: 6px; cursor: pointer;
      background: transparent; color: var(--ink-3);
      display: flex; align-items: center; justify-content: center; font-size: 14px;
      transition: background .15s, color .15s;
    }
    .icon-btn:hover { background: var(--paper-2); color: var(--ink); }

    #lf-panel .body { padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 12px; }

    .field { display: flex; flex-direction: column; gap: 6px; }
    .field > .lbl { font-size: 11px; color: var(--ink-3); letter-spacing: .1em; }

    select {
      appearance: none; -webkit-appearance: none;
      background-color: var(--paper-2);
      background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23575040' stroke-width='1.6' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
      background-repeat: no-repeat; background-position: right 10px center;
      border: 1px solid var(--line); border-radius: 7px;
      color: var(--ink); padding: 8px 30px 8px 11px; font-size: 13px; cursor: pointer; outline: none;
      width: 100%;
    }
    select:hover, select:focus { border-color: var(--line-2); }
    select option { background: var(--paper); color: var(--ink); }

    .seg { display: flex; background: var(--paper-2); border: 1px solid var(--line); border-radius: 8px; padding: 3px; gap: 3px; }
    .seg button {
      flex: 1; border: none; background: transparent; color: var(--ink-2);
      padding: 6px 0; border-radius: 5px; cursor: pointer; font-size: 12px;
      transition: all .15s;
    }
    .seg button:hover { color: var(--ink); }
    .seg button.active {
      background: var(--ink); color: #fbf7ee; font-weight: 500;
      box-shadow: 0 1px 0 rgba(255, 255, 255, 0.25) inset, 0 1px 2px rgba(70, 56, 38, 0.25);
    }

    .actions { display: flex; gap: 8px; }
    .btn {
      border: 1px solid transparent; border-radius: 7px; padding: 9px 12px; font-size: 13px; font-weight: 500;
      cursor: pointer; transition: all .15s; flex: 1; letter-spacing: .02em;
    }
    .btn.primary {
      background: linear-gradient(180deg, #bb4436, #9d3126);
      color: #fdf6ea; border-color: rgba(112, 32, 24, 0.5);
      box-shadow: inset 0 1px 0 rgba(255, 246, 232, 0.28), 0 2px 6px rgba(120, 45, 30, 0.28);
    }
    .btn.primary:hover { filter: brightness(1.06); }
    .btn.primary:disabled { opacity: .55; cursor: default; filter: none; }
    .btn.ghost {
      background: var(--paper-2); color: var(--ink-2); border-color: var(--line);
    }
    .btn.ghost:hover { background: #efe6d4; color: var(--ink); }
    .btn.ghost.active {
      background: var(--ink); color: #fbf7ee; border-color: var(--ink);
      box-shadow: 0 1px 2px rgba(70, 56, 38, 0.25);
    }

    .site-rule {
      display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--ink-2);
      background: rgba(72, 58, 40, 0.035); border: 1px dashed var(--line);
      border-radius: 7px; padding: 8px 10px; cursor: pointer;
    }
    .site-rule input { accent-color: var(--seal); width: 14px; height: 14px; cursor: pointer; }

    .foot {
      display: flex; justify-content: space-between; align-items: center;
      padding: 9px 14px; border-top: 1px dashed var(--line);
      font-size: 11px; color: var(--ink-3);
    }
    .foot .engine { color: var(--ink-3); }
    .foot .engine b { color: var(--seal); font-weight: 600; }

    #lf-panel .msg {
      margin: 10px 14px 0; padding: 8px 10px; border-radius: 7px; font-size: 12px;
      background: rgba(178, 58, 47, 0.07); color: #8f2c23;
      border: 1px solid rgba(178, 58, 47, 0.28);
      display: flex; gap: 6px; align-items: flex-start;
    }
    #lf-panel .msg.hidden { display: none; }

    /* ---- 进度条：一条墨线 ---- */
    #lf-progress {
      position: fixed; left: 0; top: 0; right: 0; height: 3px; z-index: 2147483602;
      background: rgba(72, 58, 40, 0.12); transition: opacity .4s;
    }
    #lf-progress.hidden { opacity: 0; pointer-events: none; }
    #lf-progress .bar {
      height: 100%; width: 0;
      background: linear-gradient(90deg, #b23a2f, #d9a441, #b23a2f);
      background-size: 200% 100%;
      animation: lf-flow 1.4s linear infinite;
      border-radius: 0 2px 2px 0;
      transition: width .3s ease;
    }
    @keyframes lf-flow { from { background-position: 0 0; } to { background-position: 200% 0; } }
    #lf-progress .label {
      position: absolute; top: 9px; left: 50%; transform: translateX(-50%);
      background: var(--paper); border: 1px solid var(--line);
      color: var(--ink-2); font-size: 11px; padding: 4px 12px; border-radius: 4px;
      box-shadow: 0 2px 8px rgba(70, 56, 38, 0.16);
    }

    /* ---- Tooltip：一张便签 ---- */
    #lf-tip {
      position: fixed; max-width: 420px; z-index: 2147483603;
      background: var(--paper); border: 1px solid var(--line);
      color: var(--ink); font-size: 13px; line-height: 1.68;
      padding: 10px 13px; border-radius: 6px;
      box-shadow: 0 1px 2px rgba(70, 56, 38, 0.1), 0 10px 26px -10px rgba(70, 56, 38, 0.4);
      white-space: pre-wrap; word-break: break-word;
      font-family: var(--serif);
    }
    #lf-tip.hidden { display: none; }

    /* ---- 划词浮条 ---- */
    #lf-selbar {
      position: fixed; z-index: 2147483605;
      background: var(--paper);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: 0 1px 2px rgba(70, 56, 38, 0.1), 0 10px 26px -10px rgba(70, 56, 38, 0.42);
      padding: 6px;
      display: flex; flex-direction: column; gap: 6px;
      color: var(--ink); font-size: 13px;
      animation: lf-pop .16s cubic-bezier(.2,.9,.3,1.2) both;
    }
    #lf-selbar.hidden { display: none; }
    #lf-selbar .sb-row { display: flex; align-items: center; gap: 4px; }
    #lf-selbar .sb-btn {
      border: 1px solid transparent; border-radius: 6px; cursor: pointer;
      background: var(--paper-2); color: var(--ink-2);
      padding: 6px 12px; font-size: 13px; transition: background .15s, color .15s;
      display: inline-flex; align-items: center; gap: 4px; white-space: nowrap;
    }
    #lf-selbar .sb-btn:hover { background: #efe6d4; color: var(--ink); }
    #lf-selbar .sb-btn.primary {
      background: linear-gradient(180deg, #bb4436, #9d3126); color: #fdf6ea;
      border-color: rgba(112, 32, 24, 0.5);
      box-shadow: inset 0 1px 0 rgba(255, 246, 232, 0.28);
    }
    #lf-selbar .sb-btn.primary:hover { filter: brightness(1.06); }
    #lf-selbar .sb-btn:disabled { opacity: .6; cursor: default; }
    #lf-selbar .sb-divider { width: 1px; height: 18px; background: var(--line); margin: 0 2px; }
    #lf-selbar .sb-result {
      max-width: 380px; max-height: 280px; overflow-y: auto;
      white-space: pre-wrap; word-break: break-word; line-height: 1.68;
      padding: 6px 8px; font-size: 13px; color: var(--ink);
      border-top: 1px dashed var(--line);
      font-family: var(--serif);
    }
    #lf-selbar .sb-result.hidden { display: none; }
    #lf-selbar .sb-result.err { color: #8f2c23; }

    /* ---- Toast：一张纸条 ---- */
    #lf-toast {
      position: fixed; bottom: 34px; left: 50%; transform: translateX(-50%);
      background: var(--paper); border: 1px solid var(--line);
      color: var(--ink); font-size: 13px; padding: 9px 18px; border-radius: 4px;
      box-shadow: 0 1px 2px rgba(70, 56, 38, 0.1), 0 10px 26px -10px rgba(70, 56, 38, 0.42);
      z-index: 2147483604;
      animation: lf-toast-in .25s ease both;
      max-width: min(80vw, 460px); white-space: normal;
      line-height: 1.55; text-align: center; word-break: break-word;
      font-family: var(--serif);
    }
    @keyframes lf-toast-in { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translate(-50%, 0); } }
    #lf-toast.hidden { display: none; }`;

  g.LF_UI_CSS = UI_CSS;
})(globalThis);
