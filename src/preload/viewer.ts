/**
 * 阅卷页注入脚本（viewer preload）—— Phase 2 拾取器的页面侧一半。
 * 每个 frame 都会注入一次，因此跨域 iframe 内的点击同样能被捕获。
 *
 * 职责边界：
 *   本文件只负责「页内观测」—— 生成稳定选择器、算出元素在**本 frame 视口**内的坐标。
 *   「frame 偏移累加」与「顶层坐标换算」由主进程 picker.ts 负责（那里才有 frameTree）。
 */
import { contextBridge, ipcRenderer } from 'electron';

type PickKind = 'questionRegion' | 'scoreInput' | 'submitButton';

interface PagePick {
  kind: PickKind;
  selector: string;
  localX: number;
  localY: number;
  width: number;
  height: number;
  tag: string;
  /** 元素文本摘要，便于日志里确认拾取到的是什么 */
  text: string;
  /** 按韧性排序的选择器候选（何者为最优由 locator.ts 判定） */
  candidates?: Array<{ kind: string; selector: string; score: number }>;
}

let pickingKind: PickKind | null = null;
let overlay: HTMLElement | null = null;

/* --------------------------------------------------------- 选择器生成 */

// 选择器逻辑已抽到 src/shared/selector.ts。
// 抽取理由：它决定拾取能不能用，是最该被单测的部分；留在 preload 里
// 就只能靠真实 Electron 验证（本机 Electron 起不来，见 BLOCKERS.md B3），
// 抽成纯模块后可用 jsdom 直接测。详见 tests/selector.test.ts。
import { buildSelector } from '../shared/selector';
export { buildSelector };

// 韧性候选器（Playwright 官方优先级：role > label > testid > CSS）。
// 与 buildSelector 并存：候选器负责"有哪些更优的定位方式"，
// buildSelector 作为 CSS 兜底与旧路径兼容。
import { primarySelector, selectorCandidates } from '../shared/locator';

/* ----------------------------------------------------------- 视觉反馈 */

function ensureOverlay(): HTMLElement {
  if (overlay && document.documentElement.contains(overlay)) return overlay;
  const div = document.createElement('div');
  div.setAttribute('data-grading-exam-overlay', '1');
  Object.assign(div.style, {
    position: 'fixed',
    pointerEvents: 'none',
    zIndex: '2147483647',
    border: '2px solid #22c55e',
    background: 'rgba(34,197,94,0.12)',
    borderRadius: '3px',
    transition: 'all 60ms linear',
    display: 'none',
  });
  document.documentElement.appendChild(div);
  overlay = div;
  return div;
}

function moveOverlay(el: Element): void {
  const ov = ensureOverlay();
  const r = el.getBoundingClientRect();
  Object.assign(ov.style, {
    display: 'block',
    left: `${r.left}px`,
    top: `${r.top}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
  });
}

function hideOverlay(): void {
  if (overlay) overlay.style.display = 'none';
}

function flashPicked(el: Element): void {
  const ov = ensureOverlay();
  const r = el.getBoundingClientRect();
  const flash = document.createElement('div');
  Object.assign(flash.style, {
    position: 'fixed',
    left: `${r.left}px`,
    top: `${r.top}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
    border: '2px solid #16a34a',
    background: 'rgba(34,197,94,0.35)',
    pointerEvents: 'none',
    zIndex: '2147483646',
    transition: 'opacity 400ms ease-out',
    opacity: '1',
  });
  document.documentElement.appendChild(flash);
  requestAnimationFrame(() => { flash.style.opacity = '0'; });
  setTimeout(() => flash.remove(), 450);
  ov.style.display = 'none';
}

/* --------------------------------------------------------- 事件处理 */

function onMove(e: MouseEvent): void {
  if (!pickingKind) return;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  if (el && !el.hasAttribute('data-grading-exam-overlay')) moveOverlay(el);
}

function onClick(e: MouseEvent): void {
  if (!pickingKind) return;

  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();

  // 拾取时隐藏自己的浮层，否则 elementFromPoint 会命中浮层
  hideOverlay();
  const el = document.elementFromPoint(e.clientX, e.clientY);
  if (!el || el.hasAttribute('data-grading-exam-overlay')) return;

  const r = el.getBoundingClientRect();
  // 生成按韧性排序的候选列表（Playwright 官方优先级）。
  // 存列表而非单个选择器：平台改版时最优候选可能失效，下一档仍能命中，
  // 运行时可自动降级重试。
  const candidates = selectorCandidates(el).map((c) => ({
    kind: c.kind,
    selector: c.selector,
    score: c.score,
  }));

  const payload: PagePick = {
    kind: pickingKind,
    selector: primarySelector(selectorCandidates(el))?.selector ?? buildSelector(el),
    candidates,
    localX: r.left,
    localY: r.top,
    width: r.width,
    height: r.height,
    tag: el.tagName.toLowerCase(),
    text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
  };

  flashPicked(el);
  ipcRenderer.send('page:picked', payload);

  pickingKind = null;
  detach();
}

function attach(): void {
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('contextmenu', onCancel, true);
}

function detach(): void {
  document.removeEventListener('mousemove', onMove, true);
  document.removeEventListener('click', onClick, true);
  document.removeEventListener('contextmenu', onCancel, true);
  hideOverlay();
}

function onCancel(e: MouseEvent): void {
  if (!pickingKind) return;
  e.preventDefault();
  e.stopPropagation();
  pickingKind = null;
  detach();
  ipcRenderer.send('page:pickCancelled', {});
}

/* ------------------------------------------------- 与主进程的控制通道 */

/** 进入拾取模式（供 ipc 与全局函数两条路径共用） */
function startPick(kind: PickKind): void {
  pickingKind = kind;
  attach();
  // 拾取期间改变光标，给出视觉提示
  document.documentElement.style.cursor = 'crosshair';
}

/** 退出拾取模式 */
function stopPick(): void {
  pickingKind = null;
  detach();
  document.documentElement.style.cursor = '';
}

ipcRenderer.on('page:startPick', (_e, kind: PickKind) => {
  startPick(kind);
});

ipcRenderer.on('page:stopPick', () => {
  stopPick();
});

/** 设定数值用于填分后回读校验（Phase 2 由主进程调用） */
ipcRenderer.on('page:readValue', (e, selector: string) => {
  let value: string | null = null;
  try {
    const el = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null;
    value = el ? el.value : null;
  } catch {
    value = null;
  }
  e.sender.send('page:valueRead', { selector, value });
});

// 供主进程在无 DOM 选择器时直接用坐标取元素（Canvas 平台的诊断用）
contextBridge.exposeInMainWorld('__gradingExamViewer', {
  buildSelector,
  elementFromPoint: (x: number, y: number): { tag: string; selector: string } | null => {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    return { tag: el.tagName.toLowerCase(), selector: buildSelector(el) };
  },
  // 拾取控制的第二条下发路径。
  //
  // 为什么要两条：主进程有「ipcRenderer.send 到具体 frame」与
  // 「Runtime.evaluate 触发页内函数」两种可能的下发方式，各有不确定性
  //（ipc 到嵌套 frame 需 frameId 路由；evaluate 需要全局函数可见）。
  // 本对象由 contextBridge 暴露，落在**主世界**，因此 Runtime.evaluate 可直接调用；
  // 同时下面的 ipcRenderer.on 监听保持不变。两套并存，任一条通即可工作——
  // 首次真机运行只需确认其中一条，不必改设计。
  __gradingExamPageStartPick: (kind: PickKind): boolean => {
    startPick(kind);
    return true;
  },
  __gradingExamPageStopPick: (): boolean => {
    stopPick();
    return true;
  },
  /** 供主进程读取页内状态做诊断 */
  __gradingExamDebugState: (): { picking: PickKind | null } => ({ picking: pickingKind }),
});

// 把上面两个函数也挂成裸全局，兼容「不经过 contextBridge 直接调全局」的下发方式。
// 注意：裸全局挂在主世界还是隔离世界取决于执行上下文，故仅作为兜底。
try {
  (window as unknown as Record<string, unknown>)['__gradingExamPageStartPick'] = (kind: PickKind): boolean => {
    startPick(kind);
    return true;
  };
  (window as unknown as Record<string, unknown>)['__gradingExamPageStopPick'] = (): boolean => {
    stopPick();
    return true;
  };
} catch {
  /* 页面上下文只读时忽略 */
}