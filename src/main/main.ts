/**
 * 主进程入口 —— Phase 0 骨架。
 *
 * 本阶段目标：应用能启动、设置能读写、IPC 能通、日志面板能收到推送。
 * 不含：CDP 自动化（Phase 2）、AI 调用（Phase 1）、解析导出（Phase 4~6）。
 */
import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type {
  AICallResult,
  AIConfig,
  AppSettings,
  AutoGradeConfig,
  BrowserKernel,
  ImagePart,
  LogEntry,
  LogLevel,
  PickKind,
  TokenUsage,
} from '../shared/types';
import {
  getStorePath,
  getUsageTotals,
  loadSettings,
  resetUsage,
  saveSettings,
} from './store';
import {
  EMPTY_USAGE,
  gradeQuestion,
  gradeQuestionMulti,
  parsePaper,
  testConnection,
  visionAnswers,
} from './ai/client';
import { PlatformBrowser } from './page/browser';

const __dirname_ = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
/** 阅卷窗口管理器；窗口与 CDP 会话在其内部维护 */
let platform: PlatformBrowser;

/* ------------------------------------------------------------ 日志推送 */

const LOG_BUFFER_MAX = 500;
const logBuffer: LogEntry[] = [];

export function pushLog(level: LogLevel, message: string, depth?: number): void {
  const entry: LogEntry = { ts: Date.now(), level, message, ...(depth !== undefined ? { depth } : {}) };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.splice(0, logBuffer.length - LOG_BUFFER_MAX);

  // 同时打到终端，便于 Phase 2 调 CDP 时看原始输出
  const tag = { info: 'INFO', ok: ' OK ', warn: 'WARN', error: 'ERR ' }[level];
  // eslint-disable-next-line no-console
  console.log(`[${tag}] ${'  '.repeat(depth ?? 0)}${message}`);

  mainWindow?.webContents.send('evt:log', entry);
}

export function pushUsage(usage: TokenUsage): void {
  mainWindow?.webContents.send('evt:usage', usage);
}

/* -------------------------------------------------------------- 主窗口 */

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: 'Grading_exam · AI 阅卷助手',
    backgroundColor: '#f4f5f7',
    webPreferences: {
      preload: join(__dirname_, '../preload/index.js'),
      // 安全基线：渲染层不开 Node 权限（PLAN §0 D2）
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  // 外链走系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname_, '../renderer/index.html'));
  }

  return win;
}

/* ----------------------------------------------------------------- IPC */

function registerIpc(): void {
  ipcMain.handle('settings:get', (): AppSettings => loadSettings());

  ipcMain.handle('settings:save', (_e, patch: Partial<AppSettings>): AppSettings => {
    const saved = saveSettings(patch);
    pushLog('ok', `设置已保存（模型 ${saved.ai.model}，思考模式${saved.ai.disableThinking ? '关闭' : '开启'}）`);
    return saved;
  });

  ipcMain.handle('usage:get', () => getUsageTotals());
  ipcMain.handle('usage:reset', () => resetUsage());

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    storePath: getStorePath(),
  }));

  // 日志回放：渲染层挂载后拉取历史，避免启动前的日志丢失
  ipcMain.handle('log:history', (): LogEntry[] => [...logBuffer]);

  ipcMain.handle('log:write', (_e, level: LogLevel, message: string): void => {
    pushLog(level, message);
  });

  ipcMain.handle('io:pickFile', async (
    _e,
    opts: { filters: Array<{ name: string; extensions: string[] }>; multi?: boolean },
  ) => {
    const res = await dialog.showOpenDialog({
      properties: opts.multi ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: opts.filters,
    });
    return { canceled: res.canceled, paths: res.filePaths };
  });

  ipcMain.handle('io:pickDir', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    return { canceled: res.canceled, path: res.filePaths[0] ?? '' };
  });

  // Phase 1：AI 通道已实现（client.ts）。
  registerAIHandlers();

  // Phase 2：阅卷窗口与拾取通道已实现（page/browser.ts + page/picker.ts）。
  registerBrowserHandlers();

  // auto:*（连续阅卷状态机）仍未实现，明确报未实现而不是静默返回假数据
  for (const channel of ['auto:start', 'auto:stop', 'auto:confirm'] as const) {
    ipcMain.handle(channel, () => {
      pushLog('warn', `${channel} 尚未实现（Phase 5：连续阅卷状态机）`);
      return { ok: false, error: 'Phase 5 未实现' };
    });
  }
}

/**
 * 注册阅卷窗口与拾取通道。
 *
 * ⚠ 验证状态：本段涉及真实 BrowserWindow 与 CDP，**本机无法验证**
 *（Electron 在 app.whenReady() 处崩溃，见 BLOCKERS.md B3）。
 * 其判定逻辑（坐标累加、回读校验、结构漂移检测）已在 tests/ 里单测覆盖。
 */
function registerBrowserHandlers(): void {
  platform = new PlatformBrowser(
    (level, msg) => pushLog(level, msg),
    (pick) => {
      // 拾取结果推给渲染层，面板据此把按钮变绿并显示坐标
      mainWindow?.webContents.send('evt:pick', pick);
    },
  );

  /*
   * 打开阅卷窗口。
   *
   * 只允许 http/https：file:// 与自定义协议会让「元素拾取」的语义与真实
   * 阅卷平台不一致，等于在测一个根本不同的东西。
   * 也刻意不接受 data: —— 它同样没有真实的跨域 iframe 结构。
   */
  ipcMain.handle(
    'browser:open',
    async (_e, cfg: { url: string; kernel?: BrowserKernel }) => {
    if (!cfg?.url?.trim()) {
      pushLog('warn', '未填写阅卷平台网址。');
      return { ok: false, error: '未填写网址' };
    }
    // 只允许 http/https：file:// 与自定义协议会让拾取语义与真实平台不一致
    let parsed: URL;
    try {
      parsed = new URL(cfg.url);
    } catch {
      pushLog('error', `网址格式非法：${cfg.url}`);
      return { ok: false, error: '网址格式非法' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      pushLog('error', `仅支持 http/https，收到 ${parsed.protocol}`);
      return { ok: false, error: `不支持的协议 ${parsed.protocol}` };
    }
    return platform.open(cfg.url, cfg.kernel ?? 'chrome');
    },
  );

  ipcMain.handle('browser:close', () => {
    pushLog('info', '关闭阅卷窗口。');
    return platform.close();
  });

  ipcMain.handle('browser:navigate', async (_e, url: string) => {
    if (!url?.trim()) return { ok: false, error: '网址为空' };
    return platform.navigate(url);
  });

  ipcMain.handle('picker:start', async (_e, kind: PickKind) => {
    if (!platform.isOpen()) {
      pushLog('warn', '请先打开阅卷窗口，再进行拾取。');
      return { ok: false };
    }
    return platform.startPick(kind);
  });

  ipcMain.handle('picker:cancel', () => platform.cancelPick());

  // 面板需要读取当前拾取状态（用于回显已拾取项与坐标）
  ipcMain.handle('picker:state', () => platform.getState());

  // 坐标模式：Canvas 平台由渲染层传入点击位置
  ipcMain.handle(
    'picker:coordinate',
    async (_e, payload: { kind: PickKind; localX: number; localY: number; framePath?: number[] }) => {
      if (!platform.isOpen()) return { ok: false, error: '阅卷窗口未打开' };
      const r = await platform.addCoordinatePick(
        payload.kind,
        payload.localX,
        payload.localY,
        payload.framePath ?? [],
      );
      mainWindow?.webContents.send('evt:pick', r);
      return { ok: true, pick: r };
    },
  );

  // 截图题目区域，供视觉模型评分
  ipcMain.handle('page:captureQuestion', async () => {
    const res = await platform.captureQuestionRegion();
    return res.ok
      ? { ok: true, base64: res.base64 ?? '' }
      : { ok: false, error: res.error ?? '截图失败' };
  });

  // 手动触发结构漂移检测（自动运行前会调用）
  ipcMain.handle('page:checkDrift', async () => {
    const drift = await platform.checkDrift();
    return drift ? { changed: true, details: drift.details, action: drift.action } : { changed: false };
  });
}

/**
 * 注册 AI 相关通道。
 *
 * 记账原则：**只要发生了 API 调用就记用量**，包括失败的调用——
 * 失败请求同样消耗服务商额度（尤其空响应往往是 token 被思考吃光，
 * 那恰恰是最贵的失败）。若只在成功时记账，用户会看到"没怎么用却扣了钱"。
 */
function registerAIHandlers(): void {
  const record = (usage: TokenUsage, label: string): void => {
    if (usage.total > 0 || usage.prompt > 0 || usage.completion > 0) {
      pushUsage(usage);
      pushLog('info', `${label} 用量：prompt ${usage.prompt} / completion ${usage.completion} / total ${usage.total}`);
    }
  };

  ipcMain.handle('ai:test', async (_e, cfg: AIConfig): Promise<AICallResult> => {
    pushLog('info', `连通性测试：${cfg.provider} / ${cfg.model}`);
    const res = await testConnection(cfg);
    record(res.usage, '连通性测试');

    if (res.ok) {
      pushLog('ok', `连通成功，模型回复：${res.text.slice(0, 60)}`);
    } else {
      pushLog('error', `连通失败：${res.diag.rawSnippet ?? res.diag.errorCode ?? '未知原因'}`);
    }
    if (res.diag.usedReasoningFallback) {
      pushLog('warn', '正文为空，已回退读取思考字段——建议在设置中开启「关闭思考模式」');
    }
    return res;
  });

  ipcMain.handle(
    'ai:grade',
    async (
      _e,
      payload: { question: AutoGradeConfig['question']; answerText: string; images?: ImagePart[] },
    ): Promise<AICallResult> => {
      const q = payload.question;
      const fullScore = Number(q?.fullScore ?? 0);

      // 前置校验：满分缺失或非法时不做评分——否则越界钳制会失去参照，
      // 清洗逻辑里 `score > fullScore` 的判断会退化为恒假。
      if (!Number.isFinite(fullScore) || fullScore <= 0) {
        pushLog('error', `评分中止：题目满分非法（${q?.fullScore}）。请先设定满分。`);
        return {
          ok: false,
          text: '',
          usage: { ...EMPTY_USAGE },
          diag: { model: cfgModelSafe(), errorCode: 'INVALID_FULL_SCORE', rawSnippet: `满分必须为正数，实为 ${q?.fullScore}` },
        };
      }

      pushLog('info', `开始评分：${q?.stem?.slice(0, 30) ?? '(无题干)'}… 满分 ${fullScore}`);

      const outcome = await gradeQuestion(
        loadSettings().ai,
        {
          questionText: q?.stem ?? '',
          fullScore,
          referenceAnswer: q?.referenceAnswer ?? '',
          scoringPoints: Array.isArray(q?.scoringPoints) ? q.scoringPoints : [],
          answerText: payload.answerText ?? '',
          subject: q?.subject,
        },
        { images: payload.images },
      );

      record(outcome.usage, '评分');

      if (!outcome.ok || !outcome.result) {
        pushLog('error', `评分失败：${outcome.diag.rawSnippet ?? outcome.diag.errorCode ?? '未知原因'}`);
        return { ok: false, text: outcome.rawText, usage: outcome.usage, diag: outcome.diag };
      }

      const r = outcome.result;
      for (const w of r.warnings) pushLog('warn', `评分输出已修正：${w}`);

      pushLog(
        r.reviewRequested ? 'warn' : 'ok',
        `评分完成：${r.score}/${fullScore}，置信度 ${r.confidence.toFixed(2)}` +
          (r.reviewRequested ? '（已入复核队列）' : ''),
      );

      // 返回值里带上结构化结果，供渲染层直接渲染得分点/失分点
      return {
        ok: true,
        text: outcome.rawText,
        usage: outcome.usage,
        diag: outcome.diag,
        grade: r,
      };
    },
  );

  /*
   * 多次运行评分（自一致性）。
   *
   * 与 ai:grade 的关系：ai:grade 是单次调用，便宜；本通道跑多次，贵但可靠。
   * 正确用法是**先单次、可疑才多次**——不要全量走这里，
   * 那会让 API 成本变成 3 倍而收益有限。
   */
  ipcMain.handle(
    'ai:gradeMulti',
    async (
      _e,
      payload: { config: AutoGradeConfig; answerText?: string; images?: ImagePart[]; runs?: number },
    ): Promise<AICallResult> => {
      const cfg = payload?.config;
      const fullScore = Number(cfg?.question?.fullScore ?? 0);
      if (!(fullScore > 0)) {
        pushLog('error', '多次评分被拒绝：满分必须大于 0');
        return {
          ok: false,
          text: '',
          usage: { ...EMPTY_USAGE },
          diag: { model: cfgModelSafe(), errorCode: 'INVALID_FULL_SCORE', rawSnippet: '满分必须大于 0' },
        };
      }

      const runs = Math.max(2, Math.min(Number(payload.runs ?? 3), 5));
      pushLog(
        'info',
        `开始多次评分（${runs} 次，用于估计不确定性）：` +
          `${cfg?.question?.stem?.slice(0, 30) ?? '(无题干)'}… 满分 ${fullScore}`,
      );

      const outcome = await gradeQuestionMulti(
        loadSettings().ai,
        {
          questionText: cfg?.question?.stem ?? '',
          fullScore,
          referenceAnswer: cfg?.question?.referenceAnswer ?? '',
          scoringPoints: Array.isArray(cfg?.question?.scoringPoints) ? cfg.question.scoringPoints : [],
          answerText: payload?.answerText ?? '',
          subject: cfg?.question?.subject,
        },
        { images: payload?.images ?? [], ensemble: { runs } },
      );

      record(outcome.usage, `多次评分×${runs}`);

      if (!outcome.ok || !outcome.result) {
        pushLog('error', `多次评分全部失败：${outcome.diag.rawSnippet ?? outcome.diag.errorCode ?? '未知原因'}`);
        return { ok: false, text: outcome.rawText, usage: outcome.usage, diag: outcome.diag };
      }

      const r = outcome.result;
      const v = outcome.verdict;
      for (const w of r.warnings) pushLog('warn', `评分输出已修正：${w}`);

      if (v) {
        pushLog(
          v.requiresReview ? 'warn' : 'ok',
          `多次评分结果：${v.distribution.scores.join(' / ')} → 取中位数 ${r.score}/${fullScore}；` +
            `${v.rationale}`,
        );
        const misses = r.ensemble?.commonMisses ?? [];
        if (misses.length) {
          // 共同盲区是改提示词/rubric 的主要线索，单独提出来
          pushLog('warn', `⚠ 系统性盲区（各次都漏）：${misses.join('、')}`);
        }
      }

      return { ok: true, text: outcome.rawText, usage: outcome.usage, diag: outcome.diag, grade: r };
    },
  );

  ipcMain.handle('ai:parsePaper', async (_e, payload: { rawText: string; subject?: string }): Promise<AICallResult> => {
    pushLog('info', `解析试卷文本（${(payload.rawText ?? '').length} 字符）`);
    const res = await parsePaper(loadSettings().ai, payload.rawText ?? '', payload.subject);
    record(res.usage, '试卷解析');
    pushLog(res.ok ? 'ok' : 'error', res.ok ? '试卷解析完成' : `试卷解析失败：${res.diag.rawSnippet ?? res.diag.errorCode}`);
    return { ok: res.ok, text: res.rawText, usage: res.usage, diag: res.diag, data: res.data };
  });

  ipcMain.handle(
    'ai:visionAnswers',
    async (_e, payload: { images: ImagePart[]; questionCount: number }): Promise<AICallResult> => {
      pushLog('info', `视觉识别答卷：${payload.images?.length ?? 0} 张图，${payload.questionCount} 题`);
      const res = await visionAnswers(loadSettings().ai, payload.images ?? [], payload.questionCount);
      record(res.usage, '答卷识别');
      pushLog(res.ok ? 'ok' : 'error', res.ok ? '答卷识别完成' : `答卷识别失败：${res.diag.rawSnippet ?? res.diag.errorCode}`);
      return { ok: res.ok, text: res.rawText, usage: res.usage, diag: res.diag, data: res.data };
    },
  );
}

function cfgModelSafe(): string {
  try {
    return loadSettings().ai.model;
  } catch {
    return '';
  }
}

/* --------------------------------------------------------------- 生命周期 */

// 单实例锁：防止两个实例同时操作同一个阅卷平台会话
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    registerIpc();
    mainWindow = createMainWindow();

    pushLog('info', `Grading_exam v${app.getVersion()} 启动`);
    pushLog('info', `Electron ${process.versions.electron} / Chrome ${process.versions.chrome} / Node ${process.versions.node}`);
    pushLog('info', `配置存放于 ${getStorePath()}`);

    const usage = getUsageTotals();
    pushUsage({
      prompt: usage.prompt,
      completion: usage.completion,
      total: usage.total,
      costCNY: usage.costCNY,
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});