/**
 * 主进程入口。
 *
 * 职责：应用启动、窗口、IPC 路由、日志推送。
 * 重活都在子模块里：AI（ai/client.ts）、自动化（page/*）、解析导出（io/*）。
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
  GradeResult,
  ImagePart,
  LogEntry,
  LogLevel,
  PaperReport,
  ParseResult,
  PickKind,
  TokenUsage,
} from '../shared/types';
import {
  getReviewQueue,
  getStorePath,
  getUsageTotals,
  loadSettings,
  resetUsage,
  saveSettings,
  setReviewQueue,
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
import { parseFile, toIpcResult } from './io/parse';
import { exportExcel, exportMarkdown } from './io/export';
import { compareObjective } from '../shared/objective';
import {
  applyManualCorrection,
  applyManualVerdict,
  compactQueue,
  enqueueIfNeeded,
  explainReasons,
  partitionQueue,
  queueStats,
  signalsFromResult,
  sortQueue,
  type ReviewItem,
} from './ai/review';

const __dirname_ = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
/** 阅卷窗口管理器；窗口与 CDP 会话在其内部维护 */
let platform: PlatformBrowser;

/* ------------------------------------------------------- 复核队列接入 */

/**
 * 把一份评分结果按需入复核队列并落盘。
 *
 * 为什么单独抽出来：入队有两件事必须**同时**发生——
 * 内存/磁盘里有这条记录，以及日志里说的和实际做的一致。
 * 拆开写就会出现"日志说已入队、队列里没有"的老问题。
 *
 * @returns `added` 表示**本次确实新入了队**（用于日志措辞）；
 *          `item` 是入队后的条目（无论新旧），未入队时为 null。
 */
function pushToReviewQueue(
  result: GradeResult,
  fullScore: number,
  ctx: { paperId: string; questionNo: string; subject: string },
): { added: boolean; item: ReviewItem | null } {
  try {
    const item = enqueueIfNeeded(result, {
      ...ctx,
      fullScore,
      signals: signalsFromResult(result),
    });
    if (!item) return { added: false, item: null };

    const { items: queue } = readReviewQueue();
    const exists = queue.some((x) => x.id === item.id);
    // 已存在时不重复插入：重复条目会让老师对同一题复核两次
    const next = exists ? queue : [...queue, item];
    // 每次入队顺手压缩，避免长期使用后队列无限增长。
    // 丢掉的**只可能是已处理且超期的**条目（compactQueue 保证 pending 永不丢）。
    const { queue: compacted, dropped } = compactQueue(next);
    setReviewQueue(compacted);
    if (dropped > 0) {
      pushLog('info', `复核队列已清理 ${dropped} 条超期的已处理记录（待复核的不会被清理）。`);
    }
    return { added: !exists, item };
  } catch (err) {
    // 入队失败必须显式说出来。**绝不能吞掉**——
    // 吞掉就等于"低置信度分数没人管"，而这正是这一层要防的事。
    pushLog('error', `入复核队列失败（该分数未进入复核，请人工核对）：${(err as Error)?.message}`);
    return { added: false, item: null };
  }
}

/**
 * 读出复核队列，并统计**结构已损坏**的条目数。
 *
 * 校验逻辑在 `review.ts` 的 `isValidReviewItem`（纯函数，有单测）。
 * 这里只负责读、校验、并按需要上报——
 * 手写一遍判类型代码就会与那边分叉，而分叉的后果是
 * "这边认为可用、那边认为损坏"，同一份数据两种结论。
 */
function readReviewQueue(): { items: ReviewItem[]; invalid: number } {
  const { items, invalid } = partitionQueue(getReviewQueue());
  if (invalid > 0) {
    pushLog(
      'warn',
      `复核队列里有 ${invalid} 条记录结构损坏，已隐藏（其余 ${items.length} 条正常）。` +
        `这意味着可能有分数没能进入复核，请人工核对最近的评分结果。`,
    );
  }
  return { items, invalid };
}

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

  // Phase 4：文件解析与导出。
  // parseFile 内部不抛异常（所有失败都是结构化返回），这里再兜一层——
  // 真出意外时返回可读原因，好过让异常穿过 IPC 变成渲染层的一句英文堆栈。
  ipcMain.handle('io:parseFile', async (_e, filePath: string): Promise<ParseResult> => {
    if (typeof filePath !== 'string' || filePath.trim() === '') {
      return {
        ok: false,
        name: '',
        ext: '',
        code: 'READ_FAILED',
        message: '没有收到文件路径。请重新选择文件。',
      };
    }
    try {
      const r = await parseFile(filePath);
      if (r.ok) {
        pushLog(
          'info',
          `解析成功：${r.name}，${r.charCount} 字` +
            (r.pageCount ? `，${r.pageCount} 页` : '') +
            (r.warnings.length ? `，${r.warnings.length} 条警告` : ''),
        );
        // 警告要进日志：用户可能不看界面提示，但日志里必须留痕
        for (const w of r.warnings) pushLog('warn', `${r.name}：${w.message}`);
      } else {
        pushLog('warn', `解析失败（${r.code}）：${r.name} — ${r.message}`);
      }
      return toIpcResult(r);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pushLog('error', `解析异常：${msg}`);
      return { ok: false, name: '', ext: '', code: 'PARSE_FAILED', message: `解析时发生意外：${msg}` };
    }
  });

  ipcMain.handle(
    'io:exportExcel',
    async (_e, payload: { report: PaperReport; outPath: string }) => {
      try {
        const path = await exportExcel(payload.report, payload.outPath);
        pushLog('ok', `已导出 Excel：${path}`);
        return { ok: true, path };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        pushLog('error', `导出 Excel 失败：${msg}`);
        return { ok: false, error: msg };
      }
    },
  );

  ipcMain.handle(
    'io:exportMarkdown',
    async (_e, payload: { report: PaperReport; outPath: string }) => {
      try {
        const path = await exportMarkdown(payload.report, payload.outPath);
        pushLog('ok', `已导出 Markdown：${path}`);
        return { ok: true, path };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        pushLog('error', `导出 Markdown 失败：${msg}`);
        return { ok: false, error: msg };
      }
    },
  );

  /*
   * 客观题本地比对。
   *
   * 这里**刻意不产生任何日志、不消耗任何 token、不发起网络请求**——
   * 它必须是纯计算。P5-2 的验收就是断言这条路径零网络。
   * 若将来有人在里面加了联网/打点的调用，那条断言会立刻变红。
   */
  ipcMain.handle(
    'objective:compare',
    (
      _e,
      payload: {
        student: string;
        expected: string;
        acceptable?: string[];
        optionText?: Record<string, string>;
      },
    ) => {
      const r = compareObjective(payload.student, payload.expected, {
        ...(payload.acceptable === undefined ? {} : { acceptable: payload.acceptable }),
        ...(payload.optionText === undefined ? {} : { optionText: payload.optionText }),
      });
      return {
        verdict: r.verdict,
        awarded: r.awarded,
        normalized: r.normalized,
        expected: r.expected,
        reason: r.reason,
        needsReview: r.needsReview,
      };
    },
  );

  /* --------------------------------------------------------- 复核队列 */

  ipcMain.handle('review:queue', () => {
    const { items: all, invalid } = readReviewQueue();

    // 顺手压缩：读取是最自然的时机，且不会漏掉任何一次入队后的清理
    const { queue, dropped } = compactQueue(all);
    if (dropped > 0) {
      setReviewQueue(queue);
      pushLog('info', `复核队列已清理 ${dropped} 条超期的已处理记录。`);
    }

    return {
      // 列表按"最该先看的排前面"排序：待处理 → 理由多 → 置信度低 → 更早入队
      items: sortQueue(queue),
      stats: queueStats(queue),
      // 损坏条数由 readReviewQueue 统一上报（它已经打过日志），
      // 这里原样带回给界面，让用户能看到"队列可能不完整"
      invalidDropped: invalid,
    };
  });

  ipcMain.handle('review:correct', (_e, payload) => {
    const { items: queue } = readReviewQueue();
    const idx = queue.findIndex((x) => x.id === payload.id);
    if (idx < 0) return { ok: false, warnings: [], error: '该条目不在复核队列里（可能已被处理）' };

    const { item, warnings } = applyManualCorrection(queue[idx]!, {
      ...(payload.score === undefined ? {} : { score: payload.score }),
      ...(payload.markHit === undefined ? {} : { markHit: payload.markHit }),
      ...(payload.markMissed === undefined ? {} : { markMissed: payload.markMissed }),
      ...(payload.pointScores === undefined ? {} : { pointScores: payload.pointScores }),
      ...(payload.note === undefined ? {} : { note: payload.note }),
      ...(payload.by === undefined ? {} : { by: payload.by }),
    });

    // 警示要同时进日志与返回值：日志留痕，返回值让界面能就地显示
    for (const w of warnings) pushLog('warn', `人工修正提醒：${w}`);

    const changed = item !== queue[idx]!;
    if (changed) {
      const next = [...queue];
      next[idx] = item;
      setReviewQueue(next);
      pushLog(
        'ok',
        `已修正复核项「${item.questionNo}」：${queue[idx]!.effective.score} → ${item.effective.score}` +
          (payload.note ? `（${payload.note}）` : ''),
      );
    } else {
      pushLog('info', `复核项「${queue[idx]!.questionNo}」未发生实际改动。`);
    }

    return { ok: true, item, warnings };
  });

  ipcMain.handle('review:verdict', (_e, payload) => {
    const { items: queue } = readReviewQueue();
    const idx = queue.findIndex((x) => x.id === payload.id);
    if (idx < 0) return { ok: false, error: '该条目不在复核队列里（可能已被处理）' };

    const item = applyManualVerdict(queue[idx]!, payload.status, {
      ...(payload.note === undefined ? {} : { note: payload.note }),
      ...(payload.by === undefined ? {} : { by: payload.by }),
    });
    const next = [...queue];
    next[idx] = item;
    setReviewQueue(next);
    pushLog(
      'info',
      `复核项「${item.questionNo}」标记为${payload.status === 'confirmed' ? '已确认' : '不参与评分'}。`,
    );
    return { ok: true, item };
  });

  ipcMain.handle('review:remove', (_e, payload) => {
    const { items: queue } = readReviewQueue();
    const before = queue.length;
    // 待处理的条目不允许直接删：删掉就等于一个可疑分数没人看，
    // 而且不会留下任何记录。想让它消失必须先下结论（确认或排除）。
    const target = queue.find((x) => x.id === payload.id);
    if (target && target.status === 'pending') {
      pushLog('warn', '待复核的条目不能直接删除，请先「确认无误」或「不参与评分」。');
      return { ok: false, removed: 0 };
    }
    const next = queue.filter((x) => x.id !== payload.id);
    setReviewQueue(next);
    const removed = before - next.length;
    if (removed > 0) pushLog('info', `已从复核队列移除 ${removed} 条已处理记录。`);
    return { ok: true, removed };
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
    () => {
      // 用户手动关掉阅卷窗口：必须通知渲染层，
      // 否则面板会一直显示"窗口已打开"，而点拾取又报"请先打开窗口"
      pushLog('warn', '阅卷窗口已被用户关闭。');
      mainWindow?.webContents.send('evt:browserClosed');
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

      // 复核队列：**先真的入队，再说"已入队"**。
      // 此前这里直接写「（已入复核队列）」而队列并不存在——
      // 日志声称做了没做的事，用户看到就放心了，低置信度分数直接生效。
      const reviewOutcome = pushToReviewQueue(r, fullScore, {
        // ⚠ `ai:grade` 的 payload 里既**没有** paperId 也**没有** questionNo
        // （`AutoGradeConfig['question']` 只有 stem/fullScore/referenceAnswer/
        // scoringPoints/subject）。单题评分接口本来就不知道自己在哪张卷子里。
        //
        // 所以用**题干前 24 字**做题目标识，而不是编一个看起来像真的编号：
        // 同一个题干重复评分会被认成同一条（去重正确），
        // 而界面上一眼能看出是哪道题。
        paperId: '',
        questionNo: q?.stem ? q.stem.slice(0, 24) : '(无题干)',
        subject: q?.subject ?? '',
      });

      pushLog(
        r.reviewRequested || reviewOutcome.added ? 'warn' : 'ok',
        `评分完成：${r.score}/${fullScore}，置信度 ${r.confidence.toFixed(2)}` +
          (reviewOutcome.added
            ? `（已入复核队列：${explainReasons(reviewOutcome.item!.reasons).join('、')}）`
            : ''),
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