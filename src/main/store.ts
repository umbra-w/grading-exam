/**
 * 配置与记录持久化 —— 全部本地，无后端（SPEC F5.3）。
 * electron-store 12 为 ESM-only，本文件运行在 electron-vite 的 ESM 主进程构建中。
 */
import Store from 'electron-store';
import type { AIConfig, AppSettings, GradingMode } from '../shared/types';
import { DEFAULT_MAX_TOKENS, PROVIDER_PRESETS } from './ai/compat';

export interface PersistedSchema {
  settings: AppSettings;
  /** 每个阅卷平台的拾取配置，key 为 URL origin */
  pickProfiles: Record<string, unknown>;
  /** 提示词 / rubric 冻结清单（PLAN v2.0 §3 E1） */
  freezeManifest: Record<string, unknown>;
  usageTotals: { prompt: number; completion: number; total: number; costCNY: number };
}

const deepseek = PROVIDER_PRESETS.find((p) => p.id === 'deepseek')!;

export const DEFAULT_AI_CONFIG: AIConfig = {
  provider: 'deepseek',
  baseUrl: deepseek.baseUrl,
  apiKey: '',
  model: deepseek.defaultModel,
  disableThinking: true,
  maxTokens: DEFAULT_MAX_TOKENS,
  temperature: 0.1,
  timeoutMs: 120_000,
};

export const DEFAULT_SETTINGS: AppSettings = {
  ai: DEFAULT_AI_CONFIG,
  general: {
    theme: 'light',
    exportDir: '',
    pollIntervalMs: 400,
  },
  // 按 PLAN v2.0 §3 E4 的门槛裁定：默认必须是「稳健模式」，
  // 无人值守（top）与自动提交须用户显式开启并确认风险。
  autoDefaults: {
    mode: 'steady' as GradingMode,
    throttleMs: 600,
    maxPapers: 0,
    nextPaperTimeoutMs: 15_000,
  },
};

let store: Store<PersistedSchema> | null = null;

function getStore(): Store<PersistedSchema> {
  if (!store) {
    store = new Store<PersistedSchema>({
      name: 'grading-exam',
      defaults: {
        settings: DEFAULT_SETTINGS,
        pickProfiles: {},
        freezeManifest: {},
        usageTotals: { prompt: 0, completion: 0, total: 0, costCNY: 0 },
      },
    });
  }
  return store;
}

/** 读取设置并与默认值合并，保证新版本新增字段不会读到 undefined */
export function loadSettings(): AppSettings {
  const raw = getStore().get('settings');
  return {
    ai: { ...DEFAULT_AI_CONFIG, ...(raw?.ai ?? {}) },
    general: { ...DEFAULT_SETTINGS.general, ...(raw?.general ?? {}) },
    autoDefaults: { ...DEFAULT_SETTINGS.autoDefaults, ...(raw?.autoDefaults ?? {}) },
  };
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const merged: AppSettings = {
    ai: { ...loadSettings().ai, ...(patch.ai ?? {}) },
    general: { ...loadSettings().general, ...(patch.general ?? {}) },
    autoDefaults: { ...loadSettings().autoDefaults, ...(patch.autoDefaults ?? {}) },
  };
  getStore().set('settings', merged);
  return merged;
}

export function getUsageTotals(): PersistedSchema['usageTotals'] {
  return getStore().get('usageTotals');
}

export function addUsage(delta: {
  prompt: number;
  completion: number;
  total: number;
  costCNY: number;
}): PersistedSchema['usageTotals'] {
  const cur = getUsageTotals();
  const next = {
    prompt: cur.prompt + delta.prompt,
    completion: cur.completion + delta.completion,
    total: cur.total + delta.total,
    costCNY: cur.costCNY + delta.costCNY,
  };
  getStore().set('usageTotals', next);
  return next;
}

export function resetUsage(): PersistedSchema['usageTotals'] {
  const zero = { prompt: 0, completion: 0, total: 0, costCNY: 0 };
  getStore().set('usageTotals', zero);
  return zero;
}

export function getPickProfile(origin: string): unknown {
  return getStore().get('pickProfiles')[origin];
}

export function setPickProfile(origin: string, value: unknown): void {
  const all = getStore().get('pickProfiles');
  all[origin] = value;
  getStore().set('pickProfiles', all);
}

export function getStorePath(): string {
  return getStore().path;
}