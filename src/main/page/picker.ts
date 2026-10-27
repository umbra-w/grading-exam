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
  /**
   * 上报来源 frame 的编号（页面侧的 `webFrame.routingId`）。
   *
   * 主进程定位 frame 时**以 `IpcMainEvent.frameId` 为准**（权威来源，
   * Electron 文档保证两者相等）。页面侧附带一份仅用于交叉核对——
   * 两边不等就说明有地方理解错了，这是真机上能立刻看出来的信号。
   *
   * 之所以放在 RawPagePick 而不是外层包装里：它是**同一条消息上的字段**，
   * 不是嵌套层。当初的事故正是多包了一层却没人按那层读。
   */
  frameId?: number;
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
  | { level: 'error'; code: string; message: string; action: string }
  /**
   * `info` 不是问题，是**工作模式说明**。
   *
   * 当前只有一种用法：未拾取提交按钮 → 软件不代点提交。
   * 特意不借用 `warn`：那会让界面把"另一种完全合法的用法"显示成警告，
   * 用户会去修一个不存在的问题（§6.4 的变体）。
   */
  | { level: 'info'; code: string; message: string; action: string };

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
/** 由谁按下"提交" */
export type SubmitMode = 'software' | 'platform';

/**
 * 校验一整套拾取是否齐全且自洽。
 *
 * ── 必填项只有「分数输入框」 ────────────────────────────────────────────────
 *
 * 「提交按钮」是**可选**的（SPEC 明确要求）。两种合法工作方式：
 *   · 拾取了提交按钮 → `submitMode: 'software'`，软件填分后自己点提交
 *   · 未拾取提交按钮 → `submitMode: 'platform'`，软件只负责填分，
 *     由平台自己的"提交/保存"流程生效（很多阅卷平台就是填完即存）
 *
 * 此前这里把提交按钮当成必需，于是"面板给分 + 平台自动提交"这种
 * 完全合理的用法会被挡在门外——**需求与实现对不上**。
 *
 * 未拾取提交按钮时会发一条 `info` 而不是 `error`：这不是缺陷，
 * 只是另一种工作模式，但必须让用户**知道软件这次不会替他提交**。
 * 静默地不提交和静默地提交一样危险。
 *
 * 「题目区域」同样可选（无它时跳过截图，只影响自动阅卷）。
 */
export function validatePickSet(
  picks: Partial<Record<PickKind, PickResult>>,
  viewport: { width: number; height: number },
): {
  ready: boolean;
  submitMode: SubmitMode;
  problems: Array<PickProblem & { kind: PickKind }>;
} {
  const problems: Array<PickProblem & { kind: PickKind }> = [];

  for (const kind of ['scoreInput', 'submitButton', 'questionRegion'] as const) {
    const pick = picks[kind];

    if (!pick) {
      if (kind === 'scoreInput') {
        problems.push({
          level: 'error',
          kind,
          code: 'PICK_MISSING',
          message: `${labelOf(kind)}尚未拾取。`,
          action: '自动运行前必须完成该项拾取。',
        });
      } else if (kind === 'submitButton') {
        problems.push({
          level: 'info',
          kind,
          code: 'SUBMIT_BY_PLATFORM',
          message: '未拾取提交按钮。',
          action:
            '软件将只填分、不点提交，由平台自己的保存/提交流程生效。' +
            '若需要软件代点提交，请补拾取提交按钮。',
        });
      }
      // questionRegion 缺失只影响截图范围，不提示（避免噪声）
      continue;
    }
    problems.push({ ...validatePick(pick, viewport), kind });
  }

  const ready = !problems.some((p) => p.level === 'error');
  // 有提交按钮且校验没把它判成错误 → 软件来点；否则交给平台
  const submitProblem = problems.find((p) => p.kind === 'submitButton');
  const submitMode: SubmitMode =
    picks.submitButton && (!submitProblem || submitProblem.level !== 'error')
      ? 'software'
      : 'platform';

  return { ready, submitMode, problems };
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

/* ------------------------------------------- 跨进程上报的协议校验 */

/**
 * viewer 上报拾取结果的完整消息。
 *
 * ⚠ 这是**跨进程边界上的形状约定**，两边必须逐字段一致。
 *   曾经两边不一致（页面侧发裸对象、主进程按 `{raw, framePath}` 读），
 *   后果是**每一次拾取都被静默丢弃**。所以：
 *   —— 形状定义只在这一处，`frameId` 等字段都在 RawPagePick 里 ——
 *   页面侧的类型（viewer.ts 的 PagePick）与这里的 RawPagePick 由
 *   `tests/pick-protocol.test.ts` 逐字段比对，不一致就红。
 */
export type PickReport = RawPagePick;

const PICK_KINDS: readonly PickKind[] = ['questionRegion', 'scoreInput', 'submitButton'];

/**
 * 判断一个跨进程来的值是否是合法的拾取上报。
 *
 * **为什么必须有这个函数（而不是直接 `as PickReport`）**：
 *   这里曾出现一次真实的、彻底的静默失败——页面侧发的是裸的
 *   `RawPagePick`，主进程却按 `{ raw, framePath }` 去读，
 *   于是 `payload.raw` 永远是 undefined，**每一次拾取都被丢弃**，
 *   包括普通页面。用户看到的现象是"点了没反应"，
 *   而日志只有一行轻描淡写的"格式异常已忽略"。
 *
 *   协议校验抽成纯函数后，两边的形状差异能被单测直接比较，
 *   不依赖真机、不依赖 IPC。
 */
export function parsePickReport(input: unknown): { ok: true; report: PickReport } | { ok: false; reason: string } {
  if (input === null || typeof input !== 'object') {
    return { ok: false, reason: `上报不是对象（收到 ${input === null ? 'null' : typeof input}）` };
  }
  const o = input as Record<string, unknown>;

  if (typeof o.kind !== 'string' || !PICK_KINDS.includes(o.kind as PickKind)) {
    return { ok: false, reason: `kind 非法或缺失（收到 ${JSON.stringify(o.kind)}）` };
  }
  for (const k of ['localX', 'localY', 'width', 'height'] as const) {
    if (typeof o[k] !== 'number' || !Number.isFinite(o[k])) {
      return { ok: false, reason: `${k} 不是有限数值（收到 ${JSON.stringify(o[k])}）` };
    }
  }
  if (typeof o.tag !== 'string') {
    return { ok: false, reason: 'tag 缺失' };
  }
  // selector 允许为空字符串（坐标模式），但必须是字符串类型
  if (typeof o.selector !== 'string') {
    return { ok: false, reason: 'selector 缺失或不是字符串' };
  }

  // 逐个取出并**binding 成局部常量**再做类型标注：直接在对象字面量里写
  // `localX: o.localX` 时 TS 的窄化不跨属性访问生效（会得到 unknown）。
  // 这里显式走一遍，既让类型成立，也让失败点集中在一处。
  const kind = o.kind as PickKind;
  const selector = o.selector as string;
  const localX = o.localX as number;
  const localY = o.localY as number;
  const width = o.width as number;
  const height = o.height as number;
  const tag = o.tag as string;

  const report: PickReport = {
    kind,
    selector,
    localX,
    localY,
    width,
    height,
    tag,
    text: typeof o.text === 'string' ? o.text : '',
    ...(Array.isArray(o.candidates)
      ? { candidates: o.candidates as SelectorCandidateLite[] }
      : {}),
    ...(typeof o.frameId === 'number' && Number.isFinite(o.frameId) ? { frameId: o.frameId } : {}),
  };
  return { ok: true, report };
}

/**
 * 把上报来源的 frame 换算成 framePath（从顶层到该 frame 的序号路径，顶层为 `[]`）。
 *
 * ── 用什么做 key ────────────────────────────────────────────────────────────
 *
 * `IpcMainEvent.frameId: number`。Electron 类型定义里这个字段的注释写着
 * "The ID of the renderer frame that sent this message"，并且 `ipcRenderer.send`
 * 的文档明确说：**"If you want to get the `frameId` of a given renderer context
 * you should use the `webFrame.routingId` value."**
 * 也就是说 `event.frameId === webFrame.routingId`。
 *
 * ⚠ 未在真机验证：它与 CDP `Page.getFrameTree` 里的 `frame.id` 是否同一体系
 *   没有本地证据（本机 Electron 起不来，且 chromium 协议文件不在 node_modules 里，
 *   无法离线核对）。所以这里**不假设**，而是查不到就显式报错——
 *   并在错误里写清"如果日志反复出现这一条，说明两个编号体系不同"，
 *   让真机上的第一次运行直接把答案告诉我们。
 *
 * ── 为什么查不到不能兜底成 `[]` ─────────────────────────────────────────────
 *
 * 兜底成空路径等于宣称"这是顶层 frame"。若实际是 iframe，
 * 元素的局部坐标会被当成顶层坐标使用——分数会填到页面上完全无关的位置，
 * 而这一步会"操作成功"。这是最难发现的一类错误，宁可中断并要求重新拾取。
 */
export function framePathFromFrameId(
  frameId: number | undefined,
  byFrameId: ReadonlyMap<string, number[]>,
): number[] {
  if (typeof frameId !== 'number' || !Number.isFinite(frameId)) {
    throw new Error('上报里没有可用的 frameId，无法确定拾取来源。请重新拾取。');
  }
  const path = byFrameId.get(String(frameId));
  if (!path) {
    throw new Error(
      `在 frameTree 里找不到 frameId=${frameId} 对应的 frame（树里共 ${byFrameId.size} 个）。` +
        `可能原因：① 页面刚跳转、frame 树已重建；② 上报的 frameId 与 CDP frame.id 不是同一编号体系。` +
        `请重新拾取；若持续出现请把这条日志反馈给开发者。`,
    );
  }
  return [...path];
}

/**
 * 推导拾取档案的存储 key。
 *
 * ── 为什么不能直接用完整 URL ────────────────────────────────────────────────
 *
 * 阅卷平台的 URL 通常带一堆会话参数与查询串（`?taskId=..&v=..&_t=..`），
 * 每次进入都可能不同。用完整 URL 做 key，等于**每次都存一份新的**：
 * 恢复永远命中不了，用户的感觉就是"关掉窗口拾取就丢了"。
 *
 * ── 为什么不能只用 origin ────────────────────────────────────────────────
 *
 * 同一平台的**不同页面**（不同题目的批改页）分数框位置往往不同。
 * 只用 origin 会让"恢复另一个页面的坐标"看起来像成功，
 * 而坐标是错的——这是最难发现的一类错误。
 *
 * ── 取值：origin + pathname ──────────────────────────────────────────────
 *
 * 丢掉 query 与 hash，保留 origin 与 path。理由：
 *   · query 是**数据**（任务号、会话），同一路径的布局由平台代码决定，不随它变
 *   · path 是**页面身份**，不同路径基本就是不同页面
 *
 * 这个取值不是万无一失的（平台可能把任务 id 放在 path 里，那就是天然分开的，
 * 反而更好）。所以恢复后**一定要再跑一次漂移检测**——指纹对不上就提示重拾，
 * 不能因为"恢复成功"就默认坐标可用。
 */
export function profileKeyForUrl(url: string): string {
  try {
    const u = new URL(url);
    // ⚠ `new URL('about:blank')` **不会抛错**，它会把 origin 解析成
    // 字符串 `'null'`。直接用就会得到 `'nullblank'` 这种 key——
    // 而且所有 about:/data:/blob: 页面都会塌到同一个 `'null'` 前缀下，
    // 互相覆盖彼此的拾取档案。所以这里必须显式排除。
    if (u.origin === 'null' || u.origin === '') {
      return url.trim();
    }
    return `${u.origin}${u.pathname}`;
  } catch {
    // 真正无法解析的串：退化成原始串，至少保证不同页面的 key 不同，
    // 而不是全部塌到同一个 key 上互相覆盖。
    return url.trim();
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