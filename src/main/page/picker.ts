/**
 * 拾取编排 —— 把 viewer preload 上报的「frame 内局部结果」
 * 换算成「可持久化、可复用的拾取结果」。
 *
 * ⚠ 验证状态：本文件依赖真实窗口（BrowserWindow + CDP），本机无法运行
 *（Electron 在 app.whenReady() 处崩溃，见 BLOCKERS.md B3）。
 * 但其中**纯计算部分**（framePath 换算、坐标累加、选择器校验、结构指纹比对）
 * 已在 tests/picker.test.ts 中单测覆盖；只有浏览器绑定部分待真机确认。
 *
 * framePath 的设计取舍：
 *   用 `0 > 2 > 1` 这种**序号路径**而不是 frameId。
 *   原因：frameId 每次导航都会变，存下来下次打开就失效；
 *   序号路径在页面结构不变时稳定，配合结构指纹做失效检测即可。
 */
import type { PickKind, PickResult, SelectorCandidateLite } from '../../shared/types';
import { accumulateOffset, isPointInViewport, type Rect } from './geometry';
import { selectorStillValid, structureFingerprint } from '../../shared/selector';

/** viewer preload 通过 page:picked 上报的原始数据 */
export interface RawPagePick {
  kind: PickKind;
  selector: string;
  localX: number;
  localY: number;
  width: number;
  height: number;
  tag: string;
  text: string;
  /** 按韧性排序的选择器候选（页面侧由 locator.ts 生成） */
  candidates?: SelectorCandidateLite[];
}

export interface PickContext {
  windowId: number;
  /** 从顶层到该 frame 的序号路径，顶层为 [] */
  framePath: number[];
  /** 每层 iframe 相对其父 frame 的矩形，从外到内 */
  frameRects: Rect[];
  /** 顶层视口尺寸，用于越界拦截 */
  viewport: { width: number; height: number };
  /** 该 frame 是否跨域 */
  crossOrigin: boolean;
}

/**
 * 把页面上报的原始拾取结果换算成最终 PickResult。
 *
 * 关键：`localX/localY` 是**元素相对所在 frame 视口**的坐标，
 * 必须经 accumulateOffset 累加各层 iframe 偏移才是顶层坐标。
 * 漏掉累加会得到"看起来合理但点在别处"的坐标——最难发现的一类错误。
 */
export function buildPickResult(raw: RawPagePick, ctx: PickContext): PickResult {
  const localRect: Rect = {
    x: raw.localX,
    y: raw.localY,
    width: raw.width,
    height: raw.height,
  };

  const topRect = accumulateOffset(localRect, ctx.frameRects);
  const topX = Math.round(topRect.x + topRect.width / 2);
  const topY = Math.round(topRect.y + topRect.height / 2);

  // 页面侧已按韧性排好序；这里只做形态收窄（跨进程传输用精简结构）
  const candidates: SelectorCandidateLite[] | undefined = raw.candidates?.length
    ? raw.candidates.map((c) => ({ kind: c.kind, selector: c.selector, score: c.score }))
    : undefined;

  return {
    kind: raw.kind,
    mode: 'element',
    topX,
    topY,
    localX: raw.localX,
    localY: raw.localY,
    framePath: [...ctx.framePath],
    // selector 取最优候选；候选列表整体保留，供运行时降级重试
    selector: raw.selector || candidates?.[0]?.selector || null,
    ...(candidates ? { candidates } : {}),
    width: raw.width,
    height: raw.height,
    tag: raw.tag,
    inIframe: ctx.framePath.length > 0,
    pickedAt: Date.now(),
  };
}

/** 坐标模式（Canvas 平台）：无选择器，只有一组持久化的坐标 */
export function buildCoordinatePick(
  kind: PickKind,
  localX: number,
  localY: number,
  ctx: PickContext,
): PickResult {
  const localRect: Rect = { x: localX, y: localY, width: 0, height: 0 };
  const topRect = accumulateOffset(localRect, ctx.frameRects);

  return {
    kind,
    mode: 'coordinate',
    topX: Math.round(topRect.x),
    topY: Math.round(topRect.y),
    localX,
    localY,
    framePath: [...ctx.framePath],
    selector: null,
    width: 0,
    height: 0,
    tag: '#canvas',
    inIframe: ctx.framePath.length > 0,
    pickedAt: Date.now(),
  };
}

/* --------------------------------------------------------- 校验 */

export type PickProblem =
  | { level: 'ok'; code: 'OK'; message: string }
  | { level: 'warn'; code: string; message: string; action: string }
  | { level: 'error'; code: string; message: string; action: string };

/**
 * 校验单个拾取结果是否可用。
 *
 * 为什么要在**填分之前**校验：填分与提交都是有副作用的操作，
 * 带着坏坐标去点，可能点到页面别的地方（例如误触提交按钮），不可逆。
 * 这里宁可拦住不做，也不冒险。
 */
export function validatePick(pick: PickResult, viewport: { width: number; height: number }): PickProblem {
  if (!isPointInViewport({ x: pick.topX, y: pick.topY }, viewport)) {
    return {
      level: 'error',
      code: 'OUT_OF_VIEWPORT',
      message: `目标坐标 (${pick.topX}, ${pick.topY}) 在视口 ${viewport.width}×${viewport.height} 之外。`,
      action: '页面可能已滚动或 frame 结构变化。未派发任何鼠标事件，请重新拾取。',
    };
  }

  if (pick.mode === 'element' && !pick.selector) {
    return {
      level: 'warn',
      code: 'NO_SELECTOR',
      message: '元素模式下未取得选择器，只能依赖坐标定位。',
      action: '页面改版后坐标会失效且无法自动检测。建议重新拾取，或在面板中确认切换为坐标模式。',
    };
  }

  if (pick.width === 0 || pick.height === 0) {
    return {
      level: 'warn',
      code: 'ZERO_SIZE',
      message: '拾取到的目标尺寸为 0，可能是隐藏元素或坐标模式。',
      action: '若该元素应为可见输入框，请重新拾取；坐标模式可忽略此提示。',
    };
  }

  return { level: 'ok', code: 'OK', message: '拾取结果可用。' };
}

/**
 * 校验一整套拾取是否齐全且自洽。
 * 分数框与提交按钮是**必需**的；题目区域可有可无（只影响截图范围）。
 */
export function validatePickSet(
  picks: Partial<Record<PickKind, PickResult>>,
  viewport: { width: number; height: number },
): { ready: boolean; problems: Array<PickProblem & { kind: PickKind }> } {
  const problems: Array<PickProblem & { kind: PickKind }> = [];

  for (const kind of ['scoreInput', 'submitButton', 'questionRegion'] as const) {
    const pick = picks[kind];
    const required = kind !== 'questionRegion';

    if (!pick) {
      if (required) {
        problems.push({
          level: 'error',
          kind,
          code: 'PICK_MISSING',
          message: `${labelOf(kind)}尚未拾取。`,
          action: '自动运行前必须完成该项拾取。',
        });
      }
      continue;
    }
    problems.push({ ...validatePick(pick, viewport), kind });
  }

  const ready = !problems.some((p) => p.level === 'error');
  return { ready, problems };
}

export function labelOf(kind: PickKind): string {
  switch (kind) {
    case 'questionRegion':
      return '题目区域';
    case 'scoreInput':
      return '分数输入框';
    case 'submitButton':
      return '提交按钮';
    default:
      return kind;
  }
}

/* --------------------------------------------------- 失效检测 */

export interface PickProfile {
  picks: Partial<Record<PickKind, PickResult>>;
  /** 拾取时的页面结构指纹 */
  fingerprint: string;
  url: string;
  pickedAt: number;
}

/** 指纹变化时需要重新拾取的告警 */
export interface DriftReport {
  changed: boolean;
  /** 逐项说明哪一项失效了 */
  details: string[];
  action: string;
}

/**
 * 对比当前页面与拾取时的结构指纹（SPEC P2-11 / 调研 R11）。
 *
 * 平台改版后，硬用完的选择器去填分会出现"填了没反应"或"点到别处"。
 * 主动检测并暂停，比静默失败好得多——后者会让人误以为程序卡了。
 *
 * 注意：只对**关键元素**取指纹（分数框、提交按钮、题目区域），
 * 不对整页取指纹。整页指纹在含时间戳、随机 id 的页面上会频繁误报。
 */
export function detectDrift(profile: PickProfile, currentFingerprint: string): DriftReport {
  if (!profile.fingerprint) {
    return {
      changed: false,
      details: ['拾取档案未记录结构指纹（旧版本数据）。'],
      action: '无法自动检测改版。建议重新拾取一次以启用检测。',
    };
  }

  if (profile.fingerprint === currentFingerprint) {
    return { changed: false, details: [], action: '' };
  }

  const details = diffFingerprint(profile.fingerprint, currentFingerprint);
  return {
    changed: true,
    details,
    action:
      '页面结构与拾取时不一致（平台可能已改版）。已暂停自动运行并保留已完成进度；' +
      '请重新拾取后再继续。',
  };
}

/** 逐项对比指纹字符串，指出具体哪一项变了 */
export function diffFingerprint(before: string, after: string): string[] {
  const parse = (s: string): Map<string, string> => {
    const m = new Map<string, string>();
    for (const part of s.split(';')) {
      if (!part) continue;
      const i = part.indexOf(':');
      if (i < 0) continue;
      m.set(part.slice(0, i), part.slice(i + 1));
    }
    return m;
  };

  const a = parse(before);
  const b = parse(after);
  const out: string[] = [];
  const keys = new Set([...a.keys(), ...b.keys()]);

  for (const k of [...keys].sort()) {
    const va = a.get(k);
    const vb = b.get(k);
    if (va === undefined) out.push(`${labelOfKey(k)}：拾取时不存在的目标现在出现了`);
    else if (vb === undefined) out.push(`${labelOfKey(k)}：目标已消失（选择器失效）`);
    else if (va === 'MISSING') out.push(`${labelOfKey(k)}：拾取时即未命中`);
    else if (vb === 'MISSING') out.push(`${labelOfKey(k)}：现在无法命中（选择器失效）`);
    else if (va !== vb) out.push(`${labelOfKey(k)}：元素属性变化`);
  }

  return out.length > 0 ? out : ['结构指纹变化，但未能定位到具体差异（可能是页面顺序变化）。'];
}

function labelOfKey(key: string): string {
  if (key === 'scoreInput' || key === 'submitButton' || key === 'questionRegion') return labelOf(key);
  return key;
}

/** 计算当前页面的结构指纹（供主进程调用） */
export function fingerprintOf(
  selections: Partial<Record<PickKind, string | null>>,
  doc?: Document,
): string {
  const normalized: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(selections)) normalized[k] = v ?? null;
  return structureFingerprint(normalized, doc);
}

export { selectorStillValid };