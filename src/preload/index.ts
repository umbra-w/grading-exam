/**
 * 渲染层 API 桥 —— contextBridge 暴露白名单方法。
 * 渲染层永远拿不到 ipcRenderer 本体，也拿不到 Node 权限（PLAN §0 D2）。
 *
 * 设计取舍：这里**不逐个手写 26 个通道包装**。
 * 手写的代价不是多打几行字，而是通道名会在 preload / types.ts / main.ts
 * 三处各写一遍——改名时漏掉一处就是"点了没反应"的静默 bug。
 *
 * 改为：
 *   · 用共享契约 `IPC` 的类型作为唯一真源，通道名只出现在 types.ts
 *   · 暴露一个**泛型派发器**，类型安全由 `IPC[K]` 约束
 *   · 只对高频动作用写起来舒服的便捷方法包一层
 *（真源只剩一处：泛型派发器里的 `invoke('通道名')` 字面量，
 * 而它由 `IPC[K]` 约束，写错名字编译期就报错——所以并不算第二个真源。）
 *
 * 实体通道的白名单由**主进程**把关（只有声明过的才注册 handler），
 * preload 不需要也不能替代那道检查。
 */
import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppInfo,
  AppSettings,
  BrowserKernel,
  IPC,
  LogEntry,
  LogLevel,
  ParseResult,
  PickResult,
  TokenUsage,
} from '../shared/types';

// AppInfo 的形状定义在 shared/types.ts（唯一真源），此处只做再导出，
// 保持既有 `import type { AppInfo } from '../preload/index'` 的调用点不变。
export type { AppInfo };

/**
 * 泛型派发器。
 *
 * 断言的理由：`IPC[K]` 是「参数 → 返回值」的映射类型，运行时的
 * `ipcRenderer.invoke` 本身返回 `Promise<any>`。类型在 UI 侧被完整约束，
 * 真正的安全性来自主进程一定注册了对应 handler（启动时校验）。
 */
function invoke<K extends keyof IPC>(
  channel: K,
  ...args: Parameters<IPC[K]>
): Promise<ReturnType<IPC[K]>> {
  return ipcRenderer.invoke(channel as string, ...args) as Promise<ReturnType<IPC[K]>>;
}

/**
 * 拾取事件载荷。
 *
 * 断言的理由：事件通道的形状由主进程决定，无法从 `IPC`（那是 invoke 的
 * 请求-响应契约）推导出来。这里显式声明，让 UI 侧至少有一处可查的约定。
 * 注意主进程 send 的是 `PickResult`，`changeFingerprint` 只在漂移检测里用。
 */
function asPick(payload: unknown): PickResult {
  return payload as PickResult;
}

const api = {
  /* 设置 */
  getSettings: (): Promise<AppSettings> => invoke('settings:get'),
  saveSettings: (patch: Partial<AppSettings>): Promise<AppSettings> => invoke('settings:save', patch),

  /* 用量 */
  getUsage: (): Promise<TokenUsage> => invoke('usage:get'),
  resetUsage: (): Promise<TokenUsage> => invoke('usage:reset'),

  /* 应用信息 */
  getAppInfo: (): Promise<AppInfo> => invoke('app:info'),

  /* 日志 */
  getLogHistory: (): Promise<LogEntry[]> => invoke('log:history'),
  writeLog: (level: LogLevel, message: string): Promise<void> => invoke('log:write', level, message),

  /* 文件对话框 */
  pickFile: (opts: {
    filters: Array<{ name: string; extensions: string[] }>;
    multi?: boolean;
  }): Promise<{ canceled: boolean; paths: string[] }> => invoke('io:pickFile', opts),
  pickDir: (): Promise<{ canceled: boolean; path: string }> => invoke('io:pickDir'),
  /**
   * F3.4：读答卷图片为 data URL。职责刻意收窄（解码/统计/空白判定
   * 在渲染层 —— 浏览器解码自带 EXIF 方向处理），见 types.ts 注释。
   */
  readImages: (paths: string[]): Promise<ReturnType<IPC['io:readImages']>> =>
    invoke('io:readImages', paths),
  /**
   * 解析文件为纯文本。**不抛异常**：失败时返回 `{ok:false, code, message}`，
   * `message` 是中文说明且包含"下一步怎么办"，可直接展示给用户。
   */
  parseFile: (filePath: string): Promise<ParseResult> => invoke('io:parseFile', filePath),
  /** 导出 Excel（只出 xlsx，不出 csv —— UTF-8 CSV 在中文 Excel 里会乱码） */
  exportExcel: (payload: Parameters<IPC['io:exportExcel']>[0]) =>
    invoke('io:exportExcel', payload),
  exportMarkdown: (payload: Parameters<IPC['io:exportMarkdown']>[0]) =>
    invoke('io:exportMarkdown', payload),

  /*
   * 整卷聚合。做成便捷方法而不是让渲染层自己算：
   * 聚合口径（及格线、分箱、分层、空值语义）必须只有一处实现，
   * 否则导出的 Excel 与界面显示会在某个边界对不上，而不报错。
   */
  paperAggregate: (payload: Parameters<IPC['paper:aggregate']>[0]) =>
    invoke('paper:aggregate', payload),
  /**
   * 客观题本地比对。**零网络零 token** —— 界面上标记为"本地比对"的路径
   * 走的就是它，任何时候都不应该产生 API 费用。
   */
  compareObjective: (payload: Parameters<IPC['objective:compare']>[0]) =>
    invoke('objective:compare', payload),

  /* ---- 复核队列 ---- */

  /**
   * 读取复核队列（含统计）。
   *
   * `stats` 由主进程算，界面**不自己算**：修正率的口径（哪些状态算
   * "人工下了结论"、`excluded` 算不算分母）必须只有一处定义。
   * 界面再算一遍就会在边界上分叉，而修正率正是判断模型能不能用的依据。
   */
  reviewQueue: () => invoke('review:queue'),
  reviewCorrect: (payload: Parameters<IPC['review:correct']>[0]) =>
    invoke('review:correct', payload),
  reviewVerdict: (payload: Parameters<IPC['review:verdict']>[0]) =>
    invoke('review:verdict', payload),
  reviewRemove: (payload: Parameters<IPC['review:remove']>[0]) =>
    invoke('review:remove', payload),

  /* ---- 连续阅卷（Phase 5）---- */
  /*
   * 三个方法都只是 `invoke` 的薄包装。**不要在渲染层直接写通道名**：
   * 桥刻意不暴露 `invoke`（§4.2），就是为了让通道名只出现在
   * types.ts 一处——散到多处后改名漏一处就是"点了没反应"的静默 bug。
   * 本轮接线时我在面板里写了 `gradingExam.invoke(...)`，被 tsc 抓住了。
   */
  autoStart: (cfg: Parameters<IPC['auto:start']>[0]) => invoke('auto:start', cfg),
  autoStop: () => invoke('auto:stop'),
  autoConfirm: () => invoke('auto:confirm'),

  /* ---- AI ---- */
  aiTest: (cfg: Parameters<IPC['ai:test']>[0]) => invoke('ai:test', cfg),
  aiGrade: (payload: Parameters<IPC['ai:grade']>[0]) => invoke('ai:grade', payload),
  /**
   * 多次运行评分。**不要所有题都走这里**：先单次，结果可疑（边界分 /
   * 低质量图 / 得分点不自洽）再用它复核，否则 API 成本变 3 倍而收益有限。
   */
  aiGradeMulti: (payload: Parameters<IPC['ai:gradeMulti']>[0]) => invoke('ai:gradeMulti', payload),
  aiParsePaper: (payload: Parameters<IPC['ai:parsePaper']>[0]) => invoke('ai:parsePaper', payload),
  aiVisionAnswers: (payload: Parameters<IPC['ai:visionAnswers']>[0]) =>
    invoke('ai:visionAnswers', payload),

  /* ---- 浏览器自动化 ---- */
  browserOpen: (url: string, kernel?: BrowserKernel) => invoke('browser:open', { url, kernel }),
  browserNavigate: (url: string) => invoke('browser:navigate', url),
  browserClose: () => invoke('browser:close'),

  /* ---- 元素拾取 ---- */
  pickerStart: (kind: Parameters<IPC['picker:start']>[0]) => invoke('picker:start', kind),
  pickerCancel: () => invoke('picker:cancel'),
  /** 读取当前拾取集合，用于面板回显（切换页签后不丢状态） */
  pickerState: () => invoke('picker:state'),
  pickerCoordinate: (payload: Parameters<IPC['picker:coordinate']>[0]) =>
    invoke('picker:coordinate', payload),

  /* ---- 页面 ---- */
  /** 截取已拾取的题目区域，返回 base64 PNG */
  captureQuestion: () => invoke('page:captureQuestion'),
  /** 检查页面结构是否改版；changed=true 时应**暂停并请人确认**，不要硬闯 */
  checkDrift: () => invoke('page:checkDrift'),

  /* 通用逃生口：上面没包的方法仍可用，通道名由契约约束 */
  invoke,

  /* 事件订阅 —— 返回取消订阅函数，避免 HMR 重复注册 */
  onLog: (cb: (e: LogEntry) => void): (() => void) => {
    const h = (_e: unknown, payload: LogEntry): void => cb(payload);
    ipcRenderer.on('evt:log', h);
    return () => ipcRenderer.removeListener('evt:log', h);
  },
  onUsage: (cb: (u: TokenUsage) => void): (() => void) => {
    const h = (_e: unknown, payload: TokenUsage): void => cb(payload);
    ipcRenderer.on('evt:usage', h);
    return () => ipcRenderer.removeListener('evt:usage', h);
  },
  onPick: (cb: (r: PickResult) => void): (() => void) => {
    const h = (_e: unknown, payload: unknown): void => cb(asPick(payload));
    ipcRenderer.on('evt:pick', h);
    return () => ipcRenderer.removeListener('evt:pick', h);
  },
  onProgress: (cb: (p: unknown) => void): (() => void) => {
    const h = (_e: unknown, payload: unknown): void => cb(payload);
    ipcRenderer.on('evt:progress', h);
    return () => ipcRenderer.removeListener('evt:progress', h);
  },
  /**
   * 阅卷窗口被关闭（用户手动关掉，不是我们调的 close）。
   *
   * 不订阅的话界面会永远显示"窗口已打开"——用户关掉窗口后点拾取，
   * 得到的是"请先打开阅卷窗口"却又看着界面说已经打开，完全不知所措。
   */
  onBrowserClosed: (cb: () => void): (() => void) => {
    const h = (): void => cb();
    ipcRenderer.on('evt:browserClosed', h);
    return () => ipcRenderer.removeListener('evt:browserClosed', h);
  },
  /**
   * 「稳健模式」等待人工确认。
   *
   * 消费方是 Phase 5 的连续阅卷流程；此处先把订阅接上，
   * 免得通道在契约里却无人监听——那种情况下主进程发了事件也**不会有任何报错**。
   */
  onAwaitConfirm: (cb: (p: { score: number; comment: string }) => void): (() => void) => {
    const h = (_e: unknown, payload: { score: number; comment: string }): void => cb(payload);
    ipcRenderer.on('evt:awaitConfirm', h);
    return () => ipcRenderer.removeListener('evt:awaitConfirm', h);
  },
};

/**
 * 暴露给渲染层的 API 类型。
 *
 * **刻意摘掉 `invoke` 逃生口**：渲染层只应通过具名方法访问主进程，
 * 这样每个可用能力在类型上都是显式的（33 个），而不是"任意通道都能调"。
 * 逃生口仍留在 preload 内部供便捷方法使用，只是不出现在 Window 类型里。
 *
 * 真源就是 `api` 对象本身（`typeof api`），不存在手抄的第二份——
 * 原先 `env.d.ts` 手抄了一份且把返回类型大量写成 `unknown`，
 * 结果字段名写错在渲染层完全不报错。
 */
export type GradingExamApi = Omit<typeof api, 'invoke'>;

declare global {
  interface Window {
    gradingExam: GradingExamApi;
  }
}

contextBridge.exposeInMainWorld('gradingExam', api);