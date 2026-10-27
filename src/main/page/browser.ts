/**
 * 阅卷窗口管理器 —— 独立 BrowserWindow + 拾取会话。
 *
 * ⚠ 验证状态：**本文件无法在本机验证**。
 * 窗口创建与 CDP 附加都发生在 `app.whenReady()` 之后，而本机 Electron
 * 在该处崩溃（BLOCKERS.md B3）。因此：
 *   - 所有判定逻辑已抽到 geometry.ts / picker.ts，有单测覆盖；
 *   - 本文件只做「建窗口、挂事件、转调」；
 *   - 标注 ⚠ 的位置首次真机运行必须逐条确认。
 *
 * 窗口为何用独立 BrowserWindow 而非内嵌 iframe：
 *   嵌入式会在我们的渲染层里跑目标平台脚本，带来样式污染与相互干扰；
 *   独立窗口更接近人工操作路径，也便于自由缩放查看被遮挡内容（SPEC F1.1）。
 */
import { BrowserWindow, session, type Session } from 'electron';
import type { BrowserKernel, PickKind, PickResult } from '../../shared/types';
import {
  CdpSession,
  findCrossOriginFrames,
  flattenFramePaths,
  resolveFrameId,
  type FrameTreeNode,
} from './cdp';
import {
  buildPickResult,
  buildCoordinatePick,
  detectDrift,
  fingerprintOf,
  framePathFromFrameId,
  parsePickReport,
  profileKeyForUrl,
  validatePickSet,
  type PickContext,
  type PickProfile,
} from './picker';
import { getPickProfile, setPickProfile } from '../store';

/** 拾取用的分区：独立 session 避免与主界面共享 cookie/缓存 */
const PARTITION = 'persist:grading-exam-platform';

export interface BrowserState {
  open: boolean;
  url: string;
  kernel: BrowserKernel;
  /** 当前等待拾取的类别 */
  pendingPick: PickKind | null;
  /** 已拾取结果 */
  picks: Partial<Record<PickKind, PickResult>>;
  /** 拾取时的结构指纹 */
  fingerprint: string;
  /**
   * 最近一次拾取的时刻（毫秒）。
   *
   * 存在的理由：日志要说"拾取于 X"，就必须有真实的 X。
   * 之前 checkDrift 里填的是 `Date.now()`，于是恢复旧档案时
   * 日志会声称"拾取于刚刚"——**界面在说谎**。
   */
  pickedAt: number;
}

export class PlatformBrowser {
  private win: BrowserWindow | null = null;
  private cdp: CdpSession | null = null;
  private state: BrowserState = {
    open: false,
    url: '',
    kernel: 'chrome',
    pendingPick: null,
    picks: {},
    fingerprint: '',
    pickedAt: 0,
  };

  constructor(
    private readonly onLog: (level: 'info' | 'ok' | 'warn' | 'error', msg: string) => void,
    private readonly onPick: (r: PickResult) => void,
    /**
     * 窗口被**用户手动关闭**时回调（不含我们主动调 close()）。
     *
     * 为什么需要它：`evt:browserClosed` 此前声明在 IPC 契约里、preload 也订阅了，
     * 但主进程**从来不发送**——于是用户关掉阅卷窗口后，界面永远显示"窗口已打开"，
     * 点拾取却报"请先打开阅卷窗口"。契约里有而无人发送的事件，
     * 是一种不会报错的谎言。
     */
    private readonly onWindowClosed?: () => void,
  ) {}

  getState(): BrowserState {
    return { ...this.state, picks: { ...this.state.picks } };
  }

  isOpen(): boolean {
    return !!this.win && !this.win.isDestroyed() && this.state.open;
  }

  private getSession(): Session | null {
    // session 分区由 webPreferences.partition 使用；
    // 保留此方法供日后再需要清理 cookie/缓存时使用（如"清除平台登录态"功能）。
    try {
      return session.fromPartition(PARTITION);
    } catch {
      return null;
    }
  }

  /** 清除平台会话数据（cookie / 缓存）。供日后"切换账号"使用。 */
  async clearSession(): Promise<{ ok: boolean }> {
    const s = this.getSession();
    if (!s) return { ok: false };
    try {
      await s.clearStorageData();
      this.onLog('ok', '已清除平台会话数据（cookie 与缓存）。');
      return { ok: true };
    } catch (err) {
      this.onLog('warn', `清除会话数据失败：${(err as Error)?.message ?? String(err)}`);
      return { ok: false };
    }
  }

  /* ------------------------------------------------------------ 开窗 */

  async open(url: string, kernel: BrowserKernel): Promise<{ ok: boolean; error?: string }> {
    if (this.isOpen()) {
      await this.navigate(url);
      return { ok: true };
    }

    try {
      const win = new BrowserWindow({
        width: 1280,
        height: 900,
        show: true,
        title: '阅卷平台 — Grading_exam',
        webPreferences: {
          // 平台页面绝不允许拿到 Node：这是安全边界，不是可调选项
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          partition: PARTITION,
          // 注入拾取器：每个 frame 都会注入一次，跨域 iframe 内的点击才能捕获
          preload: this.viewerPreloadPath(),
        },
      });

      this.win = win;
      this.cdp = new CdpSession(win);
      this.state = {
        ...this.state,
        open: true,
        url,
        kernel,
        // 清掉上一轮的拾取：马上会用 restoreProfile() 从本机存储按 URL 恢复。
        // 直接清空再恢复（而不是"不清空"）是因为换 URL 时必须丢弃旧坐标——
        // 保留旧坐标去点新页面，分数会填到无关位置。
        picks: {},
        fingerprint: '',
        pickedAt: 0,
      };

      win.on('closed', () => {
        const wasOpen = this.state.open;
        this.state = { ...this.state, open: false, pendingPick: null };
        this.cdp?.detach();
        this.cdp = null;
        this.win = null;
        // 只在"确实曾经打开着"时通知，避免初始化阶段发出无意义的事件
        if (wasOpen) this.onWindowClosed?.();
      });

      /*
       * viewer preload 通过 `ipcRenderer.send` 上报。
       *
       * ⚠ 这里曾有一个**彻底静默失败**的协议不匹配：页面侧发的是裸的
       *   `RawPagePick`，主进程却按 `{ raw, framePath }` 去读，
       *   于是 `payload.raw` 永远是 undefined —— **每一次拾取都被丢弃**，
       *   普通页面也一样。用户看到的是"点了没反应"。
       *
       * 现在两件事都修了：
       *   1. 形状校验交给纯函数 `parsePickReport`（有单测，两边形状不一致会红）
       *   2. framePath 由主进程用 `senderFrame.frameId` 反查 frameTree，
       *      不再指望页面侧自己算出路径（它做不到）
       */
      win.webContents.on('ipc-message', (event, channel, ...args) => {
        // 用 `event.frameId`（Electron 文档保证它等于发送方的 webFrame.routingId）。
        // 不用 senderFrame.frameId —— WebFrameMain 上**没有**这个字段
        // （它只有 frameToken，是另一种编号，不能拿来查 frameTree）。
        this.handleViewerMessage(channel, args, event.frameId);
      });

      await win.loadURL(url);
      await this.enableCdp();

      // 先尝试恢复上次的拾取档案，再算指纹。
      // 顺序很重要：指纹是**基于当前 picks 的选择器**算出来的，
      // 必须等 picks 就位后再算，否则恢复的 picks 与指纹对不上，
      // 下一次打开会误报"页面改版"。
      const restored = this.restoreProfile(url);
      this.state.fingerprint = await this.computeFingerprint();

      this.onLog('ok', `已打开阅卷窗口：${url}（内核 ${kernel}）`);

      if (restored) {
        // 恢复了就必须验一遍：恢复"成功"不等于坐标可用
        const report = await this.checkDrift();
        if (report?.changed) {
          this.onLog(
            'error',
            `已恢复上次拾取（${new Date(restored.pickedAt).toLocaleString()}），` +
              `但页面结构与当时不一致：${report.details.join('；')}`,
          );
          this.onLog('warn', report.action);
        } else {
          this.onLog(
            'info',
            `已恢复上次拾取（${new Date(restored.pickedAt).toLocaleString()}）：` +
              `${Object.keys(restored.picks).map((k) => labelOf(k as PickKind)).join('、')}。` +
              `结构指纹一致，可直接使用；如需重拾请点对应按钮。`,
          );
        }
      }

      const cross = await this.listCrossOriginFrames();
      if (cross.length > 0) {
        this.onLog(
          'info',
          `检测到 ${cross.length} 个跨域 frame（${cross.map((c) => c.origin).join(', ')}）。` +
            `填分时鼠标事件仍将在顶层派发——这是必须的，不是可选优化。`,
        );
      }
      return { ok: true };
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      this.onLog('error', `打开阅卷窗口失败：${msg}`);
      return { ok: false, error: msg };
    }
  }

  private viewerPreloadPath(): string {
    // 构建后 preload 与 main 同在 out/ 下；开发期亦由 electron-vite 统一产出
    return new URL('../preload/viewer.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  }

  private async enableCdp(): Promise<void> {
    if (!this.cdp) return;
    try {
      await this.cdp.enableDomains();
    } catch (err) {
      this.onLog('warn', `CDP 域启用失败：${(err as Error)?.message ?? String(err)}。拾取可能不可用。`);
    }
  }

  async navigate(url: string): Promise<{ ok: boolean }> {
    if (!this.win) return { ok: false };
    try {
      await this.win.loadURL(url);
      this.state.url = url;
      // 导航后结构必然变化，旧指纹作废并重算
      this.state.fingerprint = await this.computeFingerprint();
      this.onLog('info', `已跳转：${url}`);
      return { ok: true };
    } catch (err) {
      this.onLog('error', `跳转失败：${(err as Error)?.message ?? String(err)}`);
      return { ok: false };
    }
  }

  close(): { ok: boolean } {
    this.cdp?.detach();
    if (this.win && !this.win.isDestroyed()) this.win.close();
    this.win = null;
    this.cdp = null;
    this.state = { ...this.state, open: false, pendingPick: null };
    return { ok: true };
  }

  /* ----------------------------------------------------------- 拾取 */

  async startPick(kind: PickKind): Promise<{ ok: boolean }> {
    if (!this.win || !this.cdp) {
      this.onLog('warn', '尚未打开阅卷窗口，无法拾取。');
      return { ok: false };
    }
    this.state.pendingPick = kind;
    this.onLog('info', `开始拾取：${labelOf(kind)}。请在阅卷窗口内点击目标元素。`);

    // 让所有 frame 进入拾取模式（每个 frame 都注入了 viewer preload）
    try {
      await this.broadcastToFrames('page:startPick', { kind });
    } catch (err) {
      this.onLog('warn', `下发拾取指令部分失败：${(err as Error)?.message ?? String(err)}`);
    }
    return { ok: true };
  }

  cancelPick(): { ok: boolean } {
    if (this.state.pendingPick) {
      void this.broadcastToFrames('page:stopPick', {}).catch(() => undefined);
      this.onLog('info', '已取消拾取。');
    }
    this.state.pendingPick = null;
    return { ok: true };
  }

  /**
   * 处理 viewer 上报的拾取结果。
   *
   * 关键：上报的是 **frame 内局部坐标**，必须在这里补上 frame 偏移
   * 换算成顶层坐标，才能供 Input.dispatchMouseEvent 使用。
   *
   * @param senderFrameId `IpcMainEvent.frameId`（= 发送方的 webFrame.routingId）
   */
  private async handleViewerMessage(
    channel: string,
    args: unknown[],
    senderFrameId?: number,
  ): Promise<void> {
    if (channel === 'page:pickCancelled') {
      this.state.pendingPick = null;
      this.onLog('info', '页面侧取消了拾取。');
      return;
    }

    if (channel !== 'page:picked') return;

    // 形状校验走纯函数：两边协议不一致时能给出**具体哪个字段**不对，
    // 而不是一句"格式异常已忽略"（上一版就是那样，害我们丢掉全部拾取）
    const parsed = parsePickReport(args[0]);
    if (!parsed.ok) {
      this.onLog(
        'error',
        `拾取上报格式非法，已忽略：${parsed.reason}。` +
          `这是程序缺陷（页面侧与主进程协议不一致），请把日志反馈给开发者。`,
      );
      return;
    }
    const raw = parsed.report;

    let framePath: number[];
    try {
      framePath = await this.resolveFramePath(senderFrameId);
    } catch (err) {
      // 定位不到来源 frame 时不硬闯——宁可丢弃并提示重拾，
      // 也不要拿一个可能是错的坐标系去填分
      this.state.pendingPick = null;
      this.onLog('error', (err as Error).message);
      return;
    }

    const kind = raw.kind;
    const ctx = await this.buildPickContext(framePath);
    const result = buildPickResult(raw, ctx);

    // 拾取结果先自校验再接受——坏坐标不写入档案
    const viewport = ctx.viewport;
    const probe = validatePickSet({ ...this.state.picks, [kind]: result }, viewport);
    const myProblem = probe.problems.find((p) => p.kind === kind);
    if (myProblem && myProblem.level === 'error') {
      this.onLog('error', `拾取未通过校验：${myProblem.message} ${myProblem.action}`);
      return;
    }
    if (myProblem && myProblem.level === 'warn') {
      this.onLog('warn', `拾取提示：${myProblem.message} ${myProblem.action}`);
    }

    this.state.picks[kind] = result;
    this.state.pendingPick = null;
    this.state.pickedAt = Date.now();
    this.state.fingerprint = await this.computeFingerprint();

    // 落盘：拾取是人工成本最高的一步，不能只活在内存里
    this.saveProfile();

    await this.broadcastToFrames('page:stopPick', {});
    this.onPick(result);

    const pct = result.inIframe ? `（跨域 iframe 内，framePath=[${result.framePath.join(',')}]）` : '';
    this.onLog('ok', `已拾取${labelOf(kind)}${pct}：顶层坐标 (${result.topX}, ${result.topY})，选择器 ${result.selector ?? '(坐标模式)'}`);

    // 拾取变化会改变"由谁提交"。必须说清楚，不能让用户以为软件一定会代提交：
    // 静默地不提交和静默地提交一样危险。
    const after = validatePickSet(this.state.picks, viewport);
    if (after.submitMode === 'platform') {
      const info = after.problems.find((p) => p.code === 'SUBMIT_BY_PLATFORM');
      // PickProblem 是判别联合：只有非 ok 分支才有 action
      const hint = info && info.level !== 'ok' ? info.action : '';
      this.onLog('info', `提交方式：${info?.message ?? '未拾取提交按钮'} ${hint}`.trim());
    } else {
      this.onLog('info', '提交方式：软件填分后点击提交按钮。');
    }
  }

  /**
   * 把上报来源的 frame 换算成 framePath。
   *
   * ⚠ 未验证：依赖真实 frameTree（本机 Electron 起不来，见 BLOCKERS.md B3）。
   *   纯逻辑部分（`framePathFromFrameId` / `flattenFramePaths`）有单测覆盖，
   *   这里只负责取树、建表、转调。
   */
  private async resolveFramePath(senderFrameId?: number): Promise<number[]> {
    if (!this.cdp) throw new Error('CDP 未就绪，无法确定拾取来源的 frame。');

    const root = await this.cdp.getFrameTree();
    // flattenFramePaths 的 key 是 `frame.frame.id`（string），
    // framePathFromFrameId 内部把 number 转成 string 再查——两端约定写在同一处注释里。
    const byFrameId = flattenFramePaths(root);

    return framePathFromFrameId(senderFrameId, byFrameId);
  }

  /** 组装坐标换算所需的上下文 */
  private async buildPickContext(framePath: number[]): Promise<PickContext> {
    const viewportInfo = await this.cdp!.getViewport();

    // 逐层取 iframe 矩形：每层 iframe 的 rect 要在**其父 frame** 里读
    const frameRects: Array<{ x: number; y: number; width: number; height: number }> = [];
    const tree = await this.cdp!.getFrameTree();

    for (let depth = 0; depth <= framePath.length; depth++) {
      const parentPath = framePath.slice(0, depth);
      const childIndex = framePath[depth];
      if (childIndex === undefined) break;

      const parentFrameId = resolveFrameId(tree, parentPath);
      // 在第 depth+1 层父 frame 里，找 iframe 元素列表并取第 childIndex 个的矩形
      const rect = await this.readIframeRect(parentFrameId, childIndex);
      if (rect) frameRects.push(rect);
    }

    return {
      windowId: this.win?.id ?? 0,
      framePath: [...framePath],
      frameRects,
      viewport: { width: viewportInfo.width, height: viewportInfo.height },
      crossOrigin: (await this.listCrossOriginFrames()).some((c) => samePath(c.path, framePath)),
    };
  }

  private async readIframeRect(frameId: string, index: number): Promise<{ x: number; y: number; width: number; height: number } | null> {
    const expr = `(() => {
      try {
        const frames = document.querySelectorAll('iframe, frame');
        const el = frames[${index}];
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.left, y: r.top, width: r.width, height: r.height });
      } catch (e) { return JSON.stringify(null); }
    })()`;
    try {
      const res = (await this.cdp!.evaluateInFrame(frameId, expr)) as { value?: string } | null;
      const raw = res && typeof res === 'object' && 'value' in res ? (res as { value?: string }).value : null;
      return raw ? (JSON.parse(raw) as { x: number; y: number; width: number; height: number }) : null;
    } catch {
      return null;
    }
  }

  /** 坐标模式：用户在 Canvas 上点击的位置作为持久化坐标 */
  async addCoordinatePick(kind: PickKind, localX: number, localY: number, framePath: number[] = []): Promise<PickResult> {
    const ctx = await this.buildPickContext(framePath);
    const result = buildCoordinatePick(kind, localX, localY, ctx);
    this.state.picks[kind] = result;
    this.state.pickedAt = Date.now();
    this.state.fingerprint = await this.computeFingerprint();
    this.saveProfile();
    this.onPick(result);
    this.onLog('ok', `已记录坐标拾取：${kind} → (${result.topX}, ${result.topY})`);
    return result;
  }

  /* ------------------------------------------------------- 结构指纹 */

  async computeFingerprint(): Promise<string> {
    if (!this.cdp) return '';
    try {
      const root = await this.cdp.getFrameTree();
      const topId = root.frame.id;
      const sel: Partial<Record<PickKind, string | null>> = {
        scoreInput: this.state.picks.scoreInput?.selector ?? null,
        submitButton: this.state.picks.submitButton?.selector ?? null,
        questionRegion: this.state.picks.questionRegion?.selector ?? null,
      };
      // 指纹在主世界求值（隔离世界里读不到页面自身的 DOM 结构）
      const expr = `(() => {
        const sels = ${JSON.stringify(sel)};
        const bits = [];
        for (const k of ['questionRegion','scoreInput','submitButton']) {
          const s = sels[k];
          let el = null;
          try { el = s ? document.querySelector(s) : null; } catch (e) { el = null; }
          if (!el) { bits.push(k + ':MISSING'); continue; }
          const attrs = ['type','name','data-testid','id'].map(a => a + '=' + (el.getAttribute(a) || '')).join(',');
          bits.push(k + ':' + el.tagName.toLowerCase() + '|' + attrs);
        }
        return bits.join(';');
      })()`;
      const res = (await this.cdp.evaluateInFrame(topId, expr, false)) as { value?: string } | null;
      const v = res && typeof res === 'object' && 'value' in res ? (res as { value?: string }).value : null;
      return typeof v === 'string' ? v : '';
    } catch {
      return '';
    }
  }

  /** 检查页面是否改版；返回非 null 表示应暂停自动运行 */
  async checkDrift(): Promise<ReturnType<typeof detectDrift> | null> {
    if (!this.isOpen()) return null;
    const profile: PickProfile = {
      picks: this.state.picks,
      fingerprint: this.state.fingerprint,
      url: this.state.url,
      // 用真实的拾取时刻，而不是 Date.now()。
      // 之前这里填 Date.now() 是假的：日志会声称"拾取于刚刚"，
      // 而实际上是几天前拾取的——界面在说谎的一种。
      pickedAt: this.state.pickedAt || Date.now(),
    };
    const current = await this.computeFingerprint();
    const report = detectDrift(profile, current);
    if (report.changed) {
      this.onLog('error', `检测到页面结构变化：${report.details.join('；')}`);
      this.onLog('warn', report.action);
      return report;
    }
    return null;
  }

  /* ------------------------------------------------- 拾取档案持久化 */

  /**
   * 把当前拾取写回本机存储。
   *
   * 为什么必须持久化：拾取是**人工成本最高的一步**（要在平台上找到
   * 分数框、提交按钮、题目区域逐个点）。每次开窗都要重拾，用户会直接放弃。
   *
   * ⚠ 只存本机、按 URL key 分档（见 `profileKeyForUrl` 的取舍说明）。
   */
  private saveProfile(): void {
    if (!this.state.url || Object.keys(this.state.picks).length === 0) return;
    try {
      const profile: PickProfile = {
        picks: this.state.picks,
        fingerprint: this.state.fingerprint,
        url: this.state.url,
        pickedAt: this.state.pickedAt || Date.now(),
      };
      setPickProfile(profileKeyForUrl(this.state.url), profile);
    } catch (err) {
      // 持久化失败不该让拾取本身失败——内存里已经有了，本次仍可用
      this.onLog('warn', `拾取档案保存失败（本次仍可正常使用）：${(err as Error)?.message}`);
    }
  }

  /**
   * 从本机存储恢复拾取档案。
   *
   * 恢复后**必须**再跑一次漂移检测（调用方负责）：恢复"成功"只说明
   * 读到了数据，不说明坐标还指向原来的元素。
   * @returns 恢复到的档案；没有或不可用时返回 null
   */
  private restoreProfile(url: string): PickProfile | null {
    try {
      const raw = getPickProfile(profileKeyForUrl(url));
      if (!raw || typeof raw !== 'object') return null;
      const p = raw as Partial<PickProfile>;
      if (!p.picks || typeof p.picks !== 'object') return null;
      const keys = Object.keys(p.picks);
      if (keys.length === 0) return null;

      this.state.picks = p.picks;
      this.state.fingerprint = typeof p.fingerprint === 'string' ? p.fingerprint : '';
      this.state.pickedAt = typeof p.pickedAt === 'number' ? p.pickedAt : Date.now();
      return {
        picks: p.picks,
        fingerprint: this.state.fingerprint,
        url: typeof p.url === 'string' ? p.url : url,
        pickedAt: this.state.pickedAt,
      };
    } catch (err) {
      this.onLog('warn', `读取拾取档案失败，按未拾取处理：${(err as Error)?.message}`);
      return null;
    }
  }

  /* ------------------------------------------------------- 帧通信 */

  private async listCrossOriginFrames(): Promise<Array<{ frameId: string; origin: string; path: number[] }>> {
    if (!this.cdp) return [];
    const tree: FrameTreeNode = await this.cdp.getFrameTree();
    return findCrossOriginFrames(tree);
  }

  /**
   * 向所有 frame 广播指令。
   *
   * ⚠ 未验证：viewer preload 通过 `ipcRenderer.on('page:startPick')` 接收主进程消息。
   *   给所有 frame 广播需要逐个 frameId 调用 `webContents.send` 并指定 frameProcessId，
   *   或用 `Runtime.evaluate` 直接触发页内函数。当前实现走后者（不依赖 IPC 路由），
   *   首次真机运行必须确认 preload 的监听方式与之一致。
   */
  private async broadcastToFrames(event: 'page:startPick' | 'page:stopPick', payload: unknown): Promise<void> {
    if (!this.cdp) return;
    const tree = await this.cdp.getFrameTree();
    const ids: string[] = [];
    const walk = (n: FrameTreeNode): void => {
      ids.push(n.frame.id);
      (n.childFrames ?? []).forEach(walk);
    };
    walk(tree);

    const fnName = event === 'page:startPick' ? '__gradingExamPageStartPick' : '__gradingExamPageStopPick';
    const expr = `(() => {
      if (typeof window['${fnName}'] === 'function') {
        window['${fnName}'](${JSON.stringify(payload)});
        return true;
      }
      return false;
    })()`;

    for (const id of ids) {
      try {
        await this.cdp.evaluateInFrame(id, expr, false);
      } catch {
        // 跨域 frame 的隔离世界可能拒绝执行，属正常
      }
    }
  }

  /* ------------------------------------------------------- 截图 */

  /** 截图题目区域（供视觉模型评分） */
  async captureQuestionRegion(): Promise<{ ok: boolean; base64?: string; error?: string }> {
    if (!this.cdp || !this.isOpen()) return { ok: false, error: '阅卷窗口未打开' };
    const pick = this.state.picks.questionRegion;
    if (!pick) return { ok: false, error: '题目区域尚未拾取' };

    try {
      const vp = await this.cdp.getViewport();
      const base64 = await this.cdp.captureRegion(
        { x: pick.topX - pick.width / 2, y: pick.topY - pick.height / 2, width: pick.width, height: pick.height },
        vp.devicePixelRatio,
        { width: vp.width, height: vp.height },
      );
      return { ok: true, base64 };
    } catch (err) {
      return { ok: false, error: (err as Error)?.message ?? String(err) };
    }
  }

  /** 暴露 CDP 会话给填分引擎（auto.ts）使用 */
  session(): CdpSession | null {
    return this.cdp;
  }

  picks(): Partial<Record<PickKind, PickResult>> {
    return this.state.picks;
  }
}

function labelOf(kind: PickKind): string {
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

function samePath(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export { fingerprintOf };