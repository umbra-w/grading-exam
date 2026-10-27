/**
 * 自动化纯逻辑 —— Phase 2 里**可以脱离浏览器验证**的那部分。
 *
 * 为什么要把这些抽出来单独成文件：
 * 本机 Electron 起不来（见 BLOCKERS.md B3），窗口级行为无法验证。
 * 但「跨域 iframe 的坐标怎么累加」「回读值算不算通过」「失败该怎么归类」
 * 这类逻辑全是纯函数，用单测就能钉死，而且正是踩坑最多的地方。
 *
 * 把它们混在 cdp.ts 里就只能等真机能跑时才发现算错——那时已经花掉一整天。
 *
 * 三个硬约束（对应 SPEC F1 / 调研 R8-R10）：
 *  1. 受控组件只能靠受信任键盘输入（Input.insertText），禁用 el.value = x
 *  2. OOPIF 的鼠标事件必须在**顶层 target** 派发，派发进 OOPIF target 会被静默丢弃
 *  3. 顶层视口坐标 = Σ(frameOffset) + frame 内局部坐标
 */

/* ------------------------------------------------- 约束 3：坐标累加 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 累加 iframe 偏移，算出元素在**顶层视口**中的矩形。
 *
 * 为什么必须累加而不是只取最内层 frame 的 rect：
 * `getBoundingClientRect()` 返回的是**相对该 frame 自身视口**的坐标。
 * 嵌了两层 iframe 时，内层元素说"我在 (10, 20)"，
 * 但真正要点击的顶层坐标还要加上每一层 iframe 自己的偏移。
 *
 * @param localRect 元素在**最内层 frame 视口**内的矩形
 * @param frameRects 从外到内的每层 iframe 自身矩形（均为相对其父 frame 的坐标）
 */
export function accumulateOffset(localRect: Rect, frameRects: Rect[]): Rect {
  let dx = 0;
  let dy = 0;
  for (const r of frameRects) {
    dx += r.x;
    dy += r.y;
  }
  return {
    x: localRect.x + dx,
    y: localRect.y + dy,
    width: localRect.width,
    height: localRect.height,
  };
}

/** 取矩形中心点（点击目标） */
export function centerOf(r: Rect): { x: number; y: number } {
  return {
    x: Math.round(r.x + r.width / 2),
    y: Math.round(r.y + r.height / 2),
  };
}

/** 把累加后的矩形转成顶层视口下的点击点 */
export function toTopClickPoint(localRect: Rect, frameRects: Rect[]): { x: number; y: number } {
  return centerOf(accumulateOffset(localRect, frameRects));
}

/**
 * 判断点是否落在顶层视口内。
 * 用于**在派发鼠标事件前**拦掉必然失败的操作——
 * 坐标算错时若直接派发，会点到页面别的地方，可能误触发别的按钮（例如误提交）。
 * 这是"宁可什么都不做，也不要点错"的取舍。
 */
export function isPointInViewport(pt: { x: number; y: number }, viewport: { width: number; height: number }): boolean {
  return pt.x >= 0 && pt.y >= 0 && pt.x < viewport.width && pt.y < viewport.height;
}

/* --------------------------------------------- 约束 1：填分回读判定 */

export type FillVerdict = 'ok' | 'empty' | 'mismatch' | 'unreadable';

export interface FillCheck {
  verdict: FillVerdict;
  /** 期望写入的值 */
  expected: string;
  /** 回读到的值 */
  actual: string | null;
  message: string;
}

/**
 * 从各种奇怪的回读结果里取出一个可比较的字符串。
 * CDP Runtime.evaluate 返回的是 RemoteObject，值可能藏在 value / description /
 * unserializableValue 里；也见过返回 {result: 5} 这种对象的情况。
 */
export function readReturnedValue(result: unknown): string | null {
  if (result === null || result === undefined) return null;
  if (typeof result === 'string') return result;
  if (typeof result === 'number' || typeof result === 'boolean') return String(result);

  const obj = result as Record<string, unknown>;
  if ('value' in obj) {
    const v = obj.value;
    if (v === null || v === undefined) return null;
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }
  if (typeof obj.unserializableValue === 'string') return obj.unserializableValue;
  if (typeof obj.description === 'string') return obj.description;
  return null;
}

/**
 * 判定一次填分是否成功。
 *
 * 判定顺序刻意如此：
 *  - `unreadable` 优先于 `mismatch`：回读不到值（元素消失、被重渲染替换）
 *    与"填进去了但值不对"是两种不同的故障，处置也不同（前者要重拾元素）。
 *  - 数值比较做归一化：平台回读常是 "6" / "6.0" / " 6 " 而期望是 "6.0"，
 *    这类差异不该判失败，否则会产生大量假告警。
 */
export function verifyFilledValue(expected: string, actual: string | null): FillCheck {
  if (actual === null || actual === undefined) {
    return {
      verdict: 'unreadable',
      expected,
      actual: null,
      message: '回读不到值：元素可能已被重渲染或从 DOM 中移除，需要重新拾取。',
    };
  }

  if (actual.trim() === '') {
    return {
      verdict: 'empty',
      expected,
      actual,
      message: '回读为空：写入未生效（受控组件未收到受信任输入事件）。',
    };
  }

  if (normalizeNumeric(expected) === normalizeNumeric(actual)) {
    return { verdict: 'ok', expected, actual, message: '回读一致。' };
  }

  return {
    verdict: 'mismatch',
    expected,
    actual,
    message: `回读不一致：期望 ${expected}，实际 ${actual}。`,
  };
}

/**
 * 数值归一化：统一全角、去掉单位与空格，并把 6.0 与 6 视为同一值。
 * 非数值内容退化为去空白后的原串比较。
 */
export function normalizeNumeric(s: string): string {
  if (s === null || s === undefined) return '';
  // 全角数字与小数点转半角
  let t = s.replace(/[\uff10-\uff19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  t = t.replace(/\uff0e/g, '.').replace(/\s+/g, '');
  t = t.replace(/[分点]$/, '');
  if (/^-?\d+(\.\d+)?$/.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n)) return String(n);
  }
  return t;
}

/* ------------------------------------------------------- 错误分类 */

export type AutoErrorKind =
  | 'PICK_MISSING'
  | 'ELEMENT_NOT_FOUND'
  | 'VALUE_MISMATCH'
  | 'VALUE_UNREADABLE'
  | 'TIMEOUT'
  | 'SUBMIT_FAILED'
  | 'AI_FAILED'
  | 'PAGE_CHANGED'
  | 'OUT_OF_VIEWPORT'
  | 'CANCELLED'
  | 'UNKNOWN';

export interface ClassifiedError {
  kind: AutoErrorKind;
  /** 是否应当中断整轮（false = 只告警，继续下一份） */
  fatal: boolean;
  /** 是否值得重试 */
  retryable: boolean;
  message: string;
  /** 处置建议，直接写进日志 */
  action: string;
}

const ERROR_RULES: Array<{
  match: RegExp | ((s: string) => boolean);
  result: Omit<ClassifiedError, 'message'>;
}> = [
  // 取消放在最前：/停止/ 是宽匹配，若放在后面会被其它规则先命中；
  // 而"平台停止响应"这类文本属于 PAGE_CHANGED，靠更靠后的规则兜住。
  {
    match: /CANCEL|取消|用户.*停止|已停止|手动停止/,
    result: {
      kind: 'CANCELLED', fatal: false, retryable: false,
      action: '用户主动停止。已完成进度保留，可断点续跑。',
    },
  },
  {
    match: /VALUE_MISMATCH/i,
    result: {
      kind: 'VALUE_MISMATCH', fatal: false, retryable: true,
      action: '按 SPEC P2-8 降级为警告并继续，不中断连续阅卷；同时记录该平台/该题型。',
    },
  },
  {
    match: /OUT_OF_VIEWPORT/i,
    result: {
      kind: 'OUT_OF_VIEWPORT', fatal: false, retryable: false,
      action: '坐标超出视口，已拦下未派发。请检查是否滚动过页面或 frame 结构变化，需重新拾取。',
    },
  },
  {
    match: /PICK_MISSING|未拾取/i,
    result: {
      kind: 'PICK_MISSING', fatal: false, retryable: false,
      action: '分数框/提交按钮尚未拾取。请先在面板完成拾取。',
    },
  },
  {
    match: /PAGE_CHANGED|结构.*变化/i,
    result: {
      kind: 'PAGE_CHANGED', fatal: true, retryable: false,
      action: '页面结构指纹与拾取时不一致（平台改版）。已暂停并保留已完成进度，需重新拾取后再继续。',
    },
  },
  {
    match: /TIMEOUT|超时/i,
    result: {
      kind: 'TIMEOUT', fatal: false, retryable: true,
      action: '超时未取得下一份试卷。检查平台是否已无待批作业，或加大下一份等待时间。',
    },
  },
  {
    match: /SUBMIT|提交失败/i,
    result: {
      kind: 'SUBMIT_FAILED', fatal: false, retryable: true,
      action: '提交失败。按幂等状态机处理：该份标记为失败，可重试；不得重复提交。',
    },
  },
  {
    match: /AI_|评分失败/i,
    result: {
      kind: 'AI_FAILED', fatal: false, retryable: true,
      action: 'AI 评分失败。该份跳过填分，只告警不中断；若连续多份失败应检查 API 配置。',
    },
  },
];

/** 把一段错误文本归类，给出是否中断、是否重试与处置建议 */
export function classifyError(raw: string): ClassifiedError {
  const s = raw ?? '';
  for (const rule of ERROR_RULES) {
    const hit = typeof rule.match === 'function' ? rule.match(s) : rule.match.test(s);
    if (hit) return { ...rule.result, message: s };
  }
  return {
    kind: 'UNKNOWN',
    fatal: false,
    retryable: false,
    message: s,
    action: '未知错误。已记录原始信息，请附日志排查。',
  };
}

/* --------------------------------------------------- 幂等提交状态机 */

export type SubmitState = 'idle' | 'inFlight' | 'submitted' | 'failed';

/**
 * 判断是否允许提交。
 * 核心是不允许从 inFlight 或 submitted 再次提交——
 * 重复提交在阅卷平台上会覆盖或产生重复记录，是不可逆的副作用。
 */
export function canSubmit(state: SubmitState, submissionId: string, submittedIds: ReadonlySet<string>): boolean {
  if (state === 'inFlight') return false;
  if (state === 'submitted') return false;
  if (submittedIds.has(submissionId)) return false; // 幂等：本份已提交过
  return true;
}

/** 状态迁移（只允许合法迁移，非法迁移原样返回旧状态） */
export function nextSubmitState(current: SubmitState, event: 'start' | 'ok' | 'fail' | 'reset'): SubmitState {
  switch (current) {
    case 'idle':
      return event === 'start' ? 'inFlight' : 'idle';
    case 'inFlight':
      if (event === 'ok') return 'submitted';
      if (event === 'fail') return 'failed';
      return 'inFlight';
    case 'submitted':
      return event === 'reset' ? 'idle' : 'submitted';
    case 'failed':
      if (event === 'start') return 'inFlight';
      return event === 'reset' ? 'idle' : 'failed';
    default:
      return current;
  }
}

/* -------------------------------------------------- 截图与像素比 */

/**
 * 按设备像素比换算截图裁剪区域。
 *
 * `Page.captureScreenshot` 的 `clip` 用的是 **CSS 像素**还是**设备像素**，
 * 取决于是否开启 `captureBeyondViewport`；而 CDP 实际返回的位图按 devicePixelRatio 放大。
 * 直接用 CSS 像素当 clip 会在高分屏上裁出偏移的区域——这是很隐蔽的错，
 * 因为裁出来的图"看起来有内容"，只是位置不对，视觉模型会照着一个错图评分。
 *
 * 本函数显式把 CSS 像素矩形换算成设备像素矩形。
 */
export function toDevicePixelClip(
  rect: Rect,
  devicePixelRatio: number,
  viewport: { width: number; height: number },
): Rect & { scale: number } {
  const scale = devicePixelRatio > 0 ? devicePixelRatio : 1;
  // 先夹进视口，避免裁到视口之外得到空白图
  const x = Math.max(0, Math.min(rect.x, viewport.width));
  const y = Math.max(0, Math.min(rect.y, viewport.height));
  const right = Math.max(x, Math.min(rect.x + rect.width, viewport.width));
  const bottom = Math.max(y, Math.min(rect.y + rect.height, viewport.height));
  return {
    x: Math.round(x * scale),
    y: Math.round(y * scale),
    width: Math.max(1, Math.round((right - x) * scale)),
    height: Math.max(1, Math.round((bottom - y) * scale)),
    scale,
  };
}

/* ------------------------------------------------------- 键位映射 */

const KEY_MAP: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  Escape: { code: 'Escape', keyCode: 27 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
};

/**
 * 取按键的 CDP 参数。
 * 数字与字母键按 US 布局推算 keyCode（'A'→65，'0'→48），
 * 因为 Canvas 平台靠 keydown 判定，keyCode 错会导致输入被忽略。
 */
export function keyInfoForKey(key: string): { code: string; keyCode: number; text?: string } {
  const named = KEY_MAP[key];
  if (named) return named;

  if (key.length === 1) {
    const ch = key;
    const upper = ch.toUpperCase();
    if (upper >= 'A' && upper <= 'Z') {
      return { code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: ch };
    }
    if (ch >= '0' && ch <= '9') {
      return { code: `Digit${ch}`, keyCode: ch.charCodeAt(0), text: ch };
    }
    if (ch === '.') return { code: 'Period', keyCode: 190, text: ch };
    if (ch === '-') return { code: 'Minus', keyCode: 189, text: ch };
    return { code: ch, keyCode: 0, text: ch };
  }

  return { code: key, keyCode: 0 };
}

/* ------------------------------------------------ 单份隔离与续跑 */

export interface PaperOutcome {
  submissionId: string;
  ok: boolean;
  errorKind?: AutoErrorKind;
  /** 已提交则记入幂等集合 */
  submitted: boolean;
}

/**
 * 汇总一轮运行的结果，并算出可续跑的起点。
 *
 * 两条规则（SPEC P5 / PLAN v2.0）：
 *  - **单份隔离**：一份失败不影响其他份，故此处不做短路。
 *  - **断点续跑**：已成功的份不重算，续跑只处理未完成的。
 */
export function summarizeRun(outcomes: PaperOutcome[]): {
  total: number;
  succeeded: number;
  failed: number;
  submitted: number;
  fatalKinds: AutoErrorKind[];
  /** 续跑时应跳过的 submissionId */
  completedIds: string[];
  failedIds: string[];
} {
  const succeededIds: string[] = [];
  const failedIds: string[] = [];
  let submitted = 0;
  const fatalKinds = new Set<AutoErrorKind>();

  for (const o of outcomes) {
    if (o.ok) {
      succeededIds.push(o.submissionId);
      if (o.submitted) submitted++;
    } else {
      failedIds.push(o.submissionId);
      if (o.errorKind) {
        const c = classifyError(o.errorKind);
        if (c.fatal) fatalKinds.add(o.errorKind);
      }
    }
  }

  return {
    total: outcomes.length,
    succeeded: succeededIds.length,
    failed: failedIds.length,
    submitted,
    fatalKinds: [...fatalKinds],
    completedIds: succeededIds,
    failedIds,
  };
}

/* ------------------------------------------------------- 节流计算 */

/**
 * 计算两次操作之间的实际等待时长。
 * 加减 ±20% 的抖动，理由：固定间隔的请求节律很容易被平台风控识别为机器人。
 * 抖动是**降低被风控**的最廉价手段，比换 IP 温和得多。
 */
export function throttledDelay(baseMs: number, jitter: number, rng: () => number = Math.random): number {
  const clampedJitter = Math.max(0, Math.min(jitter, 0.5));
  if (baseMs <= 0) return 0;
  const factor = 1 + (rng() * 2 - 1) * clampedJitter;
  return Math.max(0, Math.round(baseMs * factor));
}