/**
 * 配置与记录持久化 —— 全部本地，无后端（SPEC F5.3）。
 * electron-store 12 为 ESM-only，本文件运行在 electron-vite 的 ESM 主进程构建中。
 */
import Store from 'electron-store';
import path from 'node:path';
import type { AIConfig, AppSettings, GradingMode } from '../shared/types';
import { DEFAULT_MAX_TOKENS, PROVIDER_PRESETS } from './ai/compat';
import { resolveStoreDirFromEnv } from './store-path';

/**
 * ★ 数据落盘位置在**模块加载时**决策一次，之后不再变。
 *
 * 为什么在模块顶层定而不是在 getStore() 里：electron-store 的 `cwd` 只在
 * 构造时生效，创建之后再改不会搬数据。分散决策会导致"读到一半换了目录"
 * 这种极难排查的问题，所以这里一次性定死。
 *
 * 便携版（electron-builder 的 portable 目标）通过 `PORTABLE_EXECUTABLE_DIR`
 * 让数据落在 exe 所在目录，整个目录拷走即可带走全部数据；
 * 否则回落 electron-store 默认的 userData。判据与理由见 store-path.ts。
 */
const STORE_DIR = resolveStoreDirFromEnv(process.env);

export interface PersistedSchema {
  settings: AppSettings;
  /** 每个阅卷平台的拾取配置。
   *  key 由 `profileKeyForUrl()` 推导（origin + pathname，刻意丢掉 query/hash——
   *  取舍理由见该函数注释），**不是**单纯的 origin。改 key 规则会让老档案失联。 */
  pickProfiles: Record<string, unknown>;
  /** 提示词 / rubric 冻结清单（PLAN v2.0 §3 E1） */
  freezeManifest: Record<string, unknown>;
  /** 待人工复核的评分结果。形状见 `ai/review.ts` 的 ReviewItem */
  reviewQueue: unknown[];
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
      // 仅在便携/显式指定时传 cwd；为 undefined 时 electron-store 用自己的默认
      // 位置（userData）。刻意不自己拼一个默认路径 —— 那会绕过它的默认行为，
      // 将来它换位置我们不会跟着走。
      cwd: STORE_DIR.cwd,
      defaults: {
        settings: DEFAULT_SETTINGS,
        pickProfiles: {},
        freezeManifest: {},
        reviewQueue: [],
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

/**
 * 复核队列的持久化。
 *
 * 为什么必须落盘：队列里放的是**人还没看过的可疑分数**。
 * 只存内存的话，关掉软件就全没了——而用户会以为"已经入队了，下次处理"。
 * 这是"界面说谎"的另一种形态：状态只在内存里活过一次启动。
 *
 * 存 `unknown[]` 而不是 `ReviewItem[]`：`store.ts` 不该反向依赖 `ai/`。
 * 形状由 `ai/review.ts` 负责，读写两端都做校验。
 */
export function getReviewQueue(): unknown[] {
  const q = getStore().get('reviewQueue');
  return Array.isArray(q) ? q : [];
}

export function setReviewQueue(items: readonly unknown[]): void {
  // 只保留可序列化的普通对象，坏数据在写入口就丢掉，
  // 免得读的时候到处判类型（且判漏一处就是静默错误）
  const clean = items.filter((x) => x !== null && typeof x === 'object' && !Array.isArray(x));
  getStore().set('reviewQueue', clean);
}

export function getStorePath(): string {
  // ★ 便携模式下 electron-store 拼出来的是 `D:/App/data\grading-exam.json`
  //   （传入的 cwd 用了正斜杠，它自己补的是反斜杠）。混用分隔符的路径
  //   用户复制出来会以为写错了，所以统一规范化成当前平台的原生形式。
  return path.normalize(getStore().path);
}

/** 数据目录的决策来源，供界面如实告知用户"数据在哪"（便携版尤其需要）。 */
export function getStoreSource(): 'explicit' | 'portable' | 'default' {
  return STORE_DIR.source;
}