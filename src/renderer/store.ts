import { create } from 'zustand';
import type { AppInfo } from '../preload/index';
import type { LogEntry, PaperReport, TokenUsage } from '../shared/types';

export type PageKey = 'single' | 'review' | 'paper' | 'browser' | 'analysis' | 'settings';

const PAGE_KEYS: PageKey[] = ['single', 'review', 'paper', 'browser', 'analysis', 'settings'];

function isPageKey(v: string): v is PageKey {
  return (PAGE_KEYS as string[]).includes(v);
}

/**
 * 从 URL 读取初始页签。
 *
 * 用途一：开发时深链到某个面板（#settings），省去每次手点。
 * 用途二：界面预览脚本要逐面板截图，必须能不靠鼠标切换。
 * 认不出就回落到默认页，不抛错——URL 是外部输入。
 */
export function initialPage(): PageKey {
  if (typeof location === 'undefined') return 'browser';
  const raw = (location.hash || '').replace(/^#\/?/, '').trim();
  return isPageKey(raw) ? raw : 'browser';
}

interface State {
  page: PageKey;
  logs: LogEntry[];
  usage: TokenUsage;
  appInfo: AppInfo | null;
  ready: boolean;
  /**
   * 最近一次整卷汇总结果。
   *
   * 放在这里而不是让面板各自持有：整卷阅卷负责**产出**报告，
   * 学情分析负责**解读**它。两个面板各算一次的话，聚合口径就有两份实现，
   * 它们会在某个边界给出不一致的数字，而那种不一致不会报错。
   *
   * 刻意**不持久化**：报告依赖当次录入的数据，重启后旧报告会与显示的
   * 题目定义对不上，留着比清掉更容易误导人。
   */
  lastReport: PaperReport | null;

  setPage: (p: PageKey) => void;
  setLastReport: (r: PaperReport | null) => void;
  appendLog: (e: LogEntry) => void;
  setLogs: (l: LogEntry[]) => void;
  setUsage: (u: TokenUsage) => void;
  setAppInfo: (i: AppInfo) => void;
}

/**
 * 日志上限。阅卷长任务会刷出大量日志，
 * 保留最近 1000 条足够定位问题，且避免 React 渲染 10000 行卡死。
 */
const LOG_LIMIT = 1000;

export const useStore = create<State>((set) => ({
  page: initialPage(),
  logs: [],
  usage: { prompt: 0, completion: 0, total: 0, costCNY: 0 },
  appInfo: null,
  ready: false,
  lastReport: null,

  setPage: (page) => set({ page }),

  setLastReport: (lastReport) => set({ lastReport }),

  appendLog: (e) =>
    set((s) => {
      const next = [...s.logs, e];
      return { logs: next.length > LOG_LIMIT ? next.slice(next.length - LOG_LIMIT) : next };
    }),

  setLogs: (logs) => set({ logs: logs.slice(-LOG_LIMIT) }),

  setUsage: (usage) => set({ usage }),

  setAppInfo: (appInfo) => set({ appInfo, ready: true }),
}));

/** 可选：顺序编号，便于日志面板对齐 */
export function nextSeq(logs: LogEntry[], e: LogEntry): number {
  return logs.length && logs[logs.length - 1]!.ts === e.ts ? logs.length : logs.length + 1;
}

export type { LogEntry, TokenUsage, AppInfo };