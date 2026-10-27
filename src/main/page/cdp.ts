/**
 * CDP 绑定层 —— 与 Electron BrowserWindow 对话的薄封装。
 *
 * ⚠️ 验证状态说明（必须保留）
 * 本文件是**唯一无法在本机验证**的部分：窗口级行为需要真实 Electron 运行，
 * 而本机 Electron 在 app.whenReady() 处崩溃（见 BLOCKERS.md B3）。
 * 因此：
 *   - 所有**数学与判定逻辑**已抽到 `geometry.ts` 并有 66 项单测覆盖；
 *   - 本文件只负责「把参数喂给 CDP、把结果取回来」，逻辑尽量薄；
 *   - 标注「⚠ 未验证」的位置属**推测行为**，首次在真机运行时必须逐条确认。
 *
 * 三个硬约束（写在这里防止后人"顺手优化"掉）：
 *
 *  1. 受控组件填值只能用 `Input.insertText`。
 *     React/Vue 受控组件不认 `el.value = x`——DOM 值会变，但框架状态不变，
 *     平台提交时读的是框架状态，于是"填了等于没填"。
 *     这不是风格问题，是功能能不能用的问题。
 *
 *  2. OOPIF（跨域 iframe）的鼠标事件必须在**顶层 target** 上派发。
 *     `Input.dispatchMouseEvent` 发进 OOPIF target 会被**静默丢弃**——
 *     不报错、不抛异常，就是没反应。这是最难排查的一类故障，
 *     因为日志上一切正常。
 *
 *  3. 顶层视口坐标 = Σ frameOffset + 局部坐标，用 `accumulateOffset` 计算。
 */
import type { BrowserWindow } from 'electron';
import {
  accumulateOffset,
  isPointInViewport,
  keyInfoForKey,
  toDevicePixelClip,
  type Rect,
} from './geometry';

/* ------------------------------------------------------------ 类型 */

export interface FrameTreeNode {
  frame: {
    id: string;
    parentId?: string;
    url: string;
    securityOrigin?: string;
    loaderId?: string;
  };
  /** 该 frame 相对其父 frame 的矩形（由 viewer preload 上报，非 CDP 原生字段） */
  childFrames?: FrameTreeNode[];
}

export interface CdpCommand {
  (method: string, params?: Record<string, unknown>): Promise<unknown>;
}

/** 把 framePath（从顶层到目标 frame 的序号路径）翻译成 frameId */
export function resolveFrameId(root: FrameTreeNode, framePath: number[]): string {
  let node = root;
  for (const idx of framePath) {
    const children = node.childFrames ?? [];
    if (idx < 0 || idx >= children.length) {
      throw new Error(`framePath 越界：第 ${idx} 层不存在（共 ${children.length} 个子 frame）`);
    }
    node = children[idx]!;
  }
  return node.frame.id;
}

/** 从 frameTree 拍平出「frameId → framePath」映射，便于反向查找 */
export function flattenFramePaths(root: FrameTreeNode): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const walk = (node: FrameTreeNode, path: number[]): void => {
    out.set(node.frame.id, path);
    (node.childFrames ?? []).forEach((child, i) => walk(child, [...path, i]));
  };
  walk(root, []);
  return out;
}

/** 找出 frameTree 里的跨域子 frame（securityOrigin 与顶层不同） */
export function findCrossOriginFrames(root: FrameTreeNode): Array<{ frameId: string; origin: string; path: number[] }> {
  const out: Array<{ frameId: string; origin: string; path: number[] }> = [];
  const topOrigin = root.frame.securityOrigin;
  const walk = (node: FrameTreeNode, path: number[]): void => {
    if (node !== root && node.frame.securityOrigin && node.frame.securityOrigin !== topOrigin) {
      out.push({ frameId: node.frame.id, origin: node.frame.securityOrigin, path });
    }
    (node.childFrames ?? []).forEach((child, i) => walk(child, [...path, i]));
  };
  walk(root, []);
  return out;
}

/* --------------------------------------------------------- 调试器 */

/**
 * 附加调试器。
 *
 * ⚠ 未验证：`webContents.debugger.attach()` 的真实行为需真机确认，
 * 尤其是「已附加」抛出的异常文案随 Electron 版本变化。
 */
export class CdpSession {
  private attached = false;

  constructor(private readonly win: BrowserWindow) {}

  get dbg(): Electron.Debugger {
    return this.win.webContents.debugger;
  }

  isAttached(): boolean {
    return this.attached && this.dbg.isAttached();
  }

  async attach(): Promise<void> {
    if (this.dbg.isAttached()) {
      this.attached = true;
      return;
    }
    try {
      this.dbg.attach('1.3');
      this.attached = true;
    } catch (err) {
      // Electron 在已附加时会抛错。实测文案不稳定，故用 isAttached 兜一层。
      if (this.dbg.isAttached()) {
        this.attached = true;
        return;
      }
      throw new Error(`附加调试器失败：${(err as Error)?.message ?? String(err)}`);
    }
  }

  detach(): void {
    try {
      if (this.dbg.isAttached()) this.dbg.detach();
    } catch {
      /* 窗口已销毁时忽略 */
    }
    this.attached = false;
  }

  send: CdpCommand = async (method, params = {}) => {
    await this.attach();
    return this.dbg.sendCommand(method, params);
  };

  /** 打开 Page / Runtime / DOM 三个域。Input 域无需显式启用。 */
  async enableDomains(): Promise<void> {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('DOM.enable');
  }

  /** 取 frame 树（Page.getFrameTree 返回单根，需自行递归成 childFrames） */
  async getFrameTree(): Promise<FrameTreeNode> {
    const res = (await this.send('Page.getFrameTree')) as { frameTree: FrameTreeNode };
    return res.frameTree;
  }

  /* -------------------------------------------------- Runtime.evaluate */

  /**
   * 在指定 frame 里求值。
   *
   * 注意：`Page.getFrameTree` 得到的 frameId 与 `Runtime.evaluate` 所需的
   * `executionContextId` **不是一回事**。必须先 `Page.createIsolatedWorld`
   * 或用 `Page.frameNavigated` 事件里的 executionContext 建立映射。
   * 这里用 createIsolatedWorld，它在每个 frame 都能拿到一个独立上下文，
   * 且与页面自身脚本互不干扰。
   *
   * ⚠ 未验证：隔离世界是**主世界之外**的上下文，viewer preload 注入的
   * `window.__gradingExamViewer` 在哪个世界可见取决于 preload 的执行世界。
   * 首次真机运行必须先确认这一点——若在隔离世界里读不到 preload 的接口，
   * 就应改用 `Runtime.evaluate` 配合主世界上下文（不传 worldName）。
   */
  async evaluateInFrame(frameId: string, expression: string, isolatedWorld = true): Promise<unknown> {
    let contextId: number | undefined;

    if (isolatedWorld) {
      const world = (await this.send('Page.createIsolatedWorld', {
        frameId,
        worldName: '__grading_exam__',
        grantUniveralAccess: true,
      })) as { executionContextId: number };
      contextId = world.executionContextId;
    }

    const res = (await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      ...(contextId !== undefined ? { contextId } : {}),
    })) as {
      result?: { value?: unknown; description?: string; unserializableValue?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };

    if (res.exceptionDetails) {
      const msg = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? '未知异常';
      throw new Error(`frame 内求值失败：${msg}`);
    }
    return res.result ?? null;
  }

  /* ------------------------------------------------- 鼠标与键盘 */

  /**
   * 在**顶层 target** 派发鼠标点击。
   *
   * ★ 硬约束 2：坐标一律是顶层视口坐标（用 accumulateOffset 算好的），
   *   这里**不接收 frameId**——因为把鼠标事件发进 OOPIF target 会被静默丢弃。
   *   参数里没有 frameId 是刻意设计，防止调用方误传。
   *
   * 用完整的 mousePressed + mouseReleased 序列：只发 pressed 不 release
   * 会让页面停留在按下状态，某些平台会因此认为操作未完成。
   */
  async clickAtTop(x: number, y: number, opts: { button?: 'left' | 'right'; clickCount?: number } = {}): Promise<void> {
    const button = opts.button ?? 'left';
    const clickCount = opts.clickCount ?? 1;

    const base = { x: Math.round(x), y: Math.round(y), button, clickCount };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, buttons: 0 });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, buttons: button === 'left' ? 1 : 2 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 });
  }

  /**
   * 受信任文本输入。
   *
   * ★ 硬约束 1：这是驱动受控组件的**唯一**正确方式。
   *   绝不能改成 `el.value = x` —— 那会绕过框架状态，填了等于没填。
   *
   * `Input.insertText` 会先清空选区再插入；若元素非空且未全选，
   * 结果是"追加"而不是"替换"。所以调用方应先点击聚焦，必要时先全选。
   */
  async insertText(text: string): Promise<void> {
    await this.send('Input.insertText', { text });
  }

  /**
   * 模拟一次按键（Canvas 平台靠 keydown/keyup 判定）。
   * 数字与字母键的 keyCode 由 keyInfoForKey 按 US 布局推算——
   * keyCode 错会导致 Canvas 平台忽略输入。
   */
  async pressKey(key: string): Promise<void> {
    const info = keyInfoForKey(key);
    const common = {
      key,
      code: info.code,
      windowsVirtualKeyCode: info.keyCode,
      nativeVirtualKeyCode: info.keyCode,
    };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...common, ...(info.text ? { text: info.text } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
  }

  /** 逐字符输入（Canvas 场景），字符之间留出极短间隔以匹配真实按键节奏 */
  async typeText(text: string, delayMs = 30): Promise<void> {
    for (const ch of text) {
      await this.pressKey(ch);
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  /* -------------------------------------------------------- 截图 */

  /**
   * 截取指定区域。
   *
   * `clip` 的坐标语义随 `captureBeyondViewport` 变化，且返回位图按
   * devicePixelRatio 缩放。`toDevicePixelClip` 已把 CSS 像素换算成设备像素。
   *
   * ⚠ 未验证：captureBeyondViewport 在 Electron 的 CDP 实现里是否完整支持
   * 需要真机确认；若报错应降级为整页截图后在本地裁剪。
   */
  async captureRegion(rect: Rect, devicePixelRatio = 1, viewport = { width: 1280, height: 800 }): Promise<string> {
    const clip = toDevicePixelClip(rect, devicePixelRatio, viewport);
    const res = (await this.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 },
      captureBeyondViewport: false,
    })) as { data: string };
    return res.data;
  }

  async captureFullPage(): Promise<string> {
    const res = (await this.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
    return res.data;
  }

  /* ------------------------------------------------------ 页面信息 */

  async getViewport(): Promise<{ width: number; height: number; devicePixelRatio: number }> {
    const r = (await this.evaluateInFrame(resolveFrameId(await this.getFrameTree(), []), `JSON.stringify({
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1
    })`)) as { value?: string };

    try {
      const parsed = JSON.parse(r?.value ?? '{}') as { width?: number; height?: number; devicePixelRatio?: number };
      return {
        width: parsed.width ?? 1280,
        height: parsed.height ?? 800,
        devicePixelRatio: parsed.devicePixelRatio ?? 1,
      };
    } catch {
      return { width: 1280, height: 800, devicePixelRatio: 1 };
    }
  }

  /** 读取指定元素的矩形（相对其所属 frame 视口） */
  async getElementRect(selector: string): Promise<Rect | null> {
    const expr = `(() => {
      try {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.left, y: r.top, width: r.width, height: r.height });
      } catch (e) { return JSON.stringify(null); }
    })()`;
    const root = await this.getFrameTree();
    const res = (await this.evaluateInFrame(root.frame.id, expr)) as { value?: string } | null;
    try {
      const v = res && 'value' in res ? JSON.parse((res as { value?: string }).value ?? 'null') : null;
      return v as Rect | null;
    } catch {
      return null;
    }
  }
}

/* ------------------------------------------------------------ 内部 */

// 坐标与判定逻辑全部在 geometry.ts（有单测覆盖）；本文件保持薄绑定，
// 不再重复实现同一套数学。

export { accumulateOffset, isPointInViewport };