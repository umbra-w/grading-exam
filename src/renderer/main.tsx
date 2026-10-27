import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// 初始化 Windows 11 Fluent 视觉主题（深浅双模支持）
try {
  const saved = localStorage.getItem('ge_theme');
  if (saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else {
    document.documentElement.setAttribute('data-theme', 'light');
  }
} catch {
  // 忽略
}

/**
 * 渲染层入口。
 *
 * 这里加了两道「必须能看见」的兜底，原因很具体：
 *   打包后的应用曾出现"窗口一闪而过 / 一片空白"，而渲染层**什么都不留**——
 *   没有日志（pushLog 不写磁盘）、没有界面（React 抛错后是空白）。
 *   用户只能描述现象，开发者只能猜。所以：
 *     ① 全局错误 + 未处理 rejection 直接画到页面上
 *     ② window.gradingExam 缺失时立刻画错误，而不是等组件里 await 时静默炸
 *   这两条同时也是诚实纪律的要求：坏掉了就说坏掉了（AGENTS §1.2）。
 */
let fatalShown = false;
function renderFatal(title: string, detail: string): void {
  if (fatalShown) return; // 只画第一个，后续错误往往是它的连带
  fatalShown = true;
  const root = document.getElementById('root');
  if (!root) return;
  const pre = document.createElement('pre');
  pre.style.cssText =
    'white-space:pre-wrap;word-break:break-all;background:#fff;border:1px solid #e6e8f2;' +
    'border-radius:11px;padding:12px;font-size:12px;color:#991b1b;margin:0 0 16px';
  pre.textContent = detail;
  const h = document.createElement('h1');
  h.style.cssText = 'font-size:18px;margin:0 0 12px';
  h.textContent = title;
  const box = document.createElement('div');
  box.style.cssText =
    'padding:32px;font:14px/1.7 system-ui,"Microsoft YaHei",sans-serif;color:#1e2130;background:#f6f7fb';
  box.append(h, pre);
  root.replaceChildren(box);
}

window.addEventListener('error', (e) => {
  const where = e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : '(未知位置)';
  renderFatal('渲染层脚本出错', `${e.message}\n${where}\n\n${e.error?.stack ?? ''}`);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason as Error | undefined;
  renderFatal('渲染层有未处理的 Promise 异常', `${r?.name ?? ''}: ${r?.message ?? String(e.reason)}\n\n${r?.stack ?? ''}`);
});

// ★ 预加载脚本没生效时，渲染层拿不到任何 IPC 能力。
//   原先是等到 App 里的 `await window.gradingExam.*` 才炸（而且是个静默的、
//   被 async IIFE 吞掉的 rejection）。这里提前、明确地报出来。
if (!window.gradingExam) {
  renderFatal(
    '预加载脚本（preload）没有生效',
    'window.gradingExam 不存在。\n' +
      '这意味着 preload/index.cjs 没有加载成功，渲染层无法与主进程通信。\n' +
      '请查看数据目录下的 startup.log —— 主进程会记录 preload 加载错误。',
  );
} else {
  const container = document.getElementById('root');
  if (!container) throw new Error('#root 未找到');

  // StrictMode 会让 effect 跑两次，这里刻意保留：
  // 用于验证 onLog/onUsage 的取消订阅逻辑是否正确（重复注册会导致日志面板出现双份）。
  createRoot(container).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}