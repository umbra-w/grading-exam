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
 *   · 只对 8 个高频动作用写起来舒服的便捷方法包一层
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
};

export type GradingExamApi = typeof api;

declare global {
  interface Window {
    gradingExam: GradingExamApi;
  }
}

contextBridge.exposeInMainWorld('gradingExam', api);