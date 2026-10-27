/// <reference types="vite/client" />

import type { AppInfo } from '../preload/index';
import type { LogEntry, TokenUsage } from '../shared/types';

interface GradingExamBridge {
  getSettings: () => Promise<unknown>;
  saveSettings: (patch: unknown) => Promise<unknown>;
  getUsage: () => Promise<unknown>;
  resetUsage: () => Promise<unknown>;
  getAppInfo: () => Promise<AppInfo>;
  getLogHistory: () => Promise<LogEntry[]>;
  writeLog: (level: 'info' | 'ok' | 'warn' | 'error', message: string) => Promise<void>;
  pickFile: (opts: {
    filters: Array<{ name: string; extensions: string[] }>;
    multi?: boolean;
  }) => Promise<{ canceled: boolean; paths: string[] }>;
  pickDir: () => Promise<{ canceled: boolean; path: string }>;
  onLog: (cb: (e: LogEntry) => void) => () => void;
  onUsage: (cb: (u: TokenUsage) => void) => () => void;
  onPick: (cb: (r: unknown) => void) => () => void;
  onProgress: (cb: (p: unknown) => void) => () => void;
}

declare global {
  interface Window {
    gradingExam: GradingExamBridge;
    __gradingExamViewer?: unknown;
  }
}

export {};