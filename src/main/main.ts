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
  QuestionMeta,
  ReadImagesResult,
  StudentResult,
  TokenUsage,
} from '../shared/types';
import {
  getReviewQueue,
  getStorePath,
  getStoreSource,
  getUsageTotals,
  loadSettings,
  resetUsage,
  saveSettings,
  setReviewQueue,
} from './store';
import { describeStoreLocation, resolveStoreDirFromEnv } from './store-path';
import {
  EMPTY_USAGE,
  gradeQuestion,
  gradeQuestionMulti,
  parsePaper,
  testConnection,
  visionAnswers,
} from './ai/client';
import { PlatformBrowser } from './page/browser';
  import { AutoRunner } from './page/auto-runner';
import { parseFile, toIpcResult } from './io/parse';
import { exportExcel, exportMarkdown, statsWarnings } from './io/export';
import { readImages } from './io/images';
import { aggregatePaper } from './io/paper';
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
import { flushStartupLog, initStartupLog, logStartup, startupLogPath } from './startup-log';

const __dirname_ = dirname(fileURLToPath(import.meta.url));

/** pushLog 落盘的条数上限：只覆盖启动阶段，避免影响运行时日志吞吐 */
const STARTUP_ECHO_MAX = 200;
let startupEchoCount = 0;

// ★ 尽可能早地打开启动日志。
//   放在这里而不是 whenReady 里，是因为"模块加载阶段失败"本身就是要抓的目标之一
//   —— 若等到 whenReady 再开日志，那种失败仍然什么痕迹都不留。
//   此时 app.getPath() 通常已可用；万不可用就退回临时目录，绝不因为写日志失败而中断启动。
let startupLogFile = '';
try {
  startupLogFile = initStartupLog();
} catch (e) {
  startupLogFile = `初始化失败：${(e as Error).message}`;
}
logStartup(`main.ts 模块求值完成，输出目录 __dirname_=${__dirname_}`);
logStartup(`启动日志文件 = ${startupLogFile}`);
logStartup(`argv=${JSON.stringify(process.argv)}`);
logStartup(
  `PORTABLE_EXECUTABLE_DIR=${process.env['PORTABLE_EXECUTABLE_DIR'] ?? '(未设置)'} ` +
    `GRADING_EXAM_DATA_DIR=${process.env['GRADING_EXAM_DATA_DIR'] ?? '(未设置)'}`,
);

process.on('uncaughtException', (e) => {
  logStartup(`!! uncaughtException: ${e.stack ?? e.message}`);
  flushStartupLog();
});
process.on('unhandledRejection', (reason) => {
  logStartup(`!! unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
});
process.on('exit', (code) => {
  // ★ 这一行几乎总能写进去，不管崩溃前发生了什么
  logStartup(`!! process exit code=${code} (0x${(code >>> 0).toString(16)})`);
  // 用同步写把完整记录再落一份，避免崩溃丢掉最后几行
  flushStartupLog();
});

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

  // ★ 启动阶段前 200 条也落盘。理由：pushLog 原来只进内存/终端/IPC，
  //   而"窗口还没出来就挂了"的情况恰恰是最需要证据的 —— 那时渲染层不存在，
  //   终端窗口也随进程消失。设上限是为了不影响运行时的日志吞吐。
  if (startupEchoCount < STARTUP_ECHO_MAX) {
    startupEchoCount++;
    logStartup(`[日志/${tag.trim()}] ${message}`);
  }

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
      preload: join(__dirname_, '../preload/index.cjs'),
      // 安全基线：渲染层不开 Node 权限（PLAN §0 D2）
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // ★ 渲染进程出错时把原因写成一张页面，而不是让窗口白屏/消失。
  //   为什么要这个：React 抛错时页面会静默变空白，而"空白"看起来很像"简洁的设计"，
  //   用户只会说"一闪而过 / 打不开"，开发者拿不到任何线索。
  //   把错误画到窗口上，等于把诊断信息直接交到用户手里。
  const showFailure = (title: string, detail: string): void => {
    logStartup(`!! 渲染层失败 [${title}] ${detail}`);
    const safe = detail.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] as string);
    const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body style="font:14px/1.6 'Microsoft YaHei',sans-serif;padding:32px;color:#1e2130;background:#fafbff">
<h1 style="font-size:18px;margin:0 0 12px">界面未能加载</h1>
<p style="margin:0 0 16px;color:#4b5169">${title}</p>
<pre style="white-space:pre-wrap;word-break:break-all;background:#fff;border:1px solid #e6e8f2;border-radius:8px;padding:12px;font-size:12px;color:#991b1b">${safe}</pre>
<p style="margin:16px 0 0;color:#4b5169">诊断日志：<code>${startupLogPath() ?? '(无)'}</code></p>
</body></html>`;
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    if (!win.isVisible()) win.show();
  };

  // ready-to-show 正常路径；若它一直不来（页面加载失败），3 秒后强制显示，
  // 至少让用户看到窗口和错误，而不是"一闪而过"后什么都不知道。
  win.once('ready-to-show', () => {
    logStartup('ready-to-show 触发 → 显示窗口');
    win.show();
  });
  setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) {
      logStartup('!! ready-to-show 超时未触发（页面可能加载失败）→ 强制显示窗口');
      win.show();
    }
  }, 3000);

  win.webContents.on('did-finish-load', () => {
    logStartup(`did-finish-load：页面加载完成 url=${win.webContents.getURL().slice(0, 120)}`);
    logStartup(`窗口状态 可见=${win.isVisible()} 尺寸=${JSON.stringify(win.getSize())} 标题='${win.getTitle()}'`);
  });
  // ★ 窗口「被关闭 / 被隐藏」是最直接的"一闪而过"证据，必须留下。
  win.on('close', () => logStartup(`!! 窗口 close 事件（可见=${win.isVisible()}）`));
  win.on('closed', () => {
    logStartup('!! 窗口 closed 事件 —— 主窗口已销毁');
    mainWindow = null;
  });
  win.on('hide', () => logStartup('!! 窗口 hide 事件'));
  win.on('minimize', () => logStartup('窗口 minimize 事件'));
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    logStartup(`!! did-fail-load code=${code} desc=${desc} url=${url} isMainFrame=${isMainFrame}`);
    if (isMainFrame) showFailure('页面加载失败', `code=${code}\n${desc}\n${url}`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    logStartup(`!! render-process-gone reason=${details.reason} exitCode=${details.exitCode}`);
    showFailure('渲染进程崩溃', `reason=${details.reason}\nexitCode=${details.exitCode}`);
  });
  win.webContents.on('unresponsive', () => logStartup('!! 窗口无响应'));
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    // ★ 预加载脚本挂掉时渲染层拿不到任何 API，界面必白屏 —— 这条是关键线索
    logStartup(`!! preload 加载失败 ${preloadPath}: ${error.message}`);
    showFailure('预加载脚本加载失败', `${preloadPath}\n${error.stack ?? error.message}`);
  });
  // 渲染层的 console 消息（level 3 = error）也要收进日志：React 的报错都从这里出来
  let consoleLines = 0;
  win.webContents.on('console-message', (e) => {
    if (consoleLines >= 100) return;
    const lvl = String((e as { level?: unknown }).level ?? '?');
    if (lvl !== '3' && lvl !== 'error') return;
    consoleLines++;
    const msg = String((e as { message?: unknown }).message ?? '');
    const where = `${String((e as { lineNumber?: unknown }).lineNumber ?? '?')}:${String((e as { sourceId?: unknown }).sourceId ?? '?')}`;
    logStartup(`!! 渲染层 console.error @${where} ${msg.slice(0, 500)}`);
  });

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
    storeSource: getStoreSource(),
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

  // F3.4 批量导入：读答卷图片为 data URL。解码/统计/空白判定都在渲染层
  // （浏览器解码自带 EXIF 方向处理），这里只做读文件与编码（见 types.ts）。
  ipcMain.handle('io:readImages', async (_e, paths: string[]): Promise<ReadImagesResult> => {
    if (!Array.isArray(paths)) {
      return { ok: false, images: [], errors: [], error: '没有收到文件路径列表' };
    }
    try {
      return await readImages(paths);
    } catch (e) {
      // readImages 内部已逐文件兜错；能走到这里说明框架层出了意外
      const msg = (e as Error)?.message ?? String(e);
      return { ok: false, images: [], errors: [], error: `读取图片失败：${msg}` };
    }
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

  /*
   * 整卷聚合。纯计算通道：不碰磁盘、不联网，所以没有失败路径需要包成
   * {ok,error} —— 直接返回报告。
   *
   * 校验只做"形状对不对"，不做业务修正：把不合格的 results 拦在外面，
   * 比事后猜学生缺了什么字段要诚实得多。缺明细时返回一份**空统计**的
   * 报告（各指标为 null），而不是伪造 0 分（§6.1）。
   */
  ipcMain.handle(
    'paper:aggregate',
    (
      _e,
      payload: {
        paperId: string;
        paperTitle: string;
        results: StudentResult[];
        questionsMeta?: QuestionMeta[];
      },
    ): PaperReport => {
      if (!payload || !Array.isArray(payload.results)) {
        pushLog('error', '整卷聚合失败：没有收到答卷明细。');
        return aggregatePaper({
          paperId: payload?.paperId ?? '',
          paperTitle: payload?.paperTitle ?? '',
          results: [],
        });
      }
      const report = aggregatePaper({
        paperId: payload.paperId,
        paperTitle: payload.paperTitle,
        results: payload.results,
        questionsMeta: payload.questionsMeta,
      });
      const warns = statsWarnings(report.stats);
      pushLog(
        warns.length > 0 ? 'warn' : 'ok',
        `已汇总 ${report.stats.count} 份答卷${warns.length > 0 ? `（${warns[0]}）` : ''}`,
      );
      return report;
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

  // Phase 5：连续阅卷的执行层。
  // 判定逻辑已在纯模块里单测（auto-orchestrator 28 项 / autoloop 37 项 /
  // geometry 66 项）；这里只做"装配"，但**依赖真实 CDP，本机无法验证**。
  registerAutoHandlers();
}

/**
 * 注册连续阅卷的执行层通道（Phase 5）。
 *
 * ⚠ 验证状态：装配逻辑本机可编译、可对账，但**跑不到真机验证**——
 * 它与 `browser.ts`/`cdp.ts` 一样依赖真实 BrowserWindow（BLOCKERS.md B3）。
 * 因此这里的诚实纪律是：
 *   · 任何前置条件不满足（窗口没开、被拒绝、已有运行中）就**明确报错**，
 *     不假装跑起来了
 *   · 不用假数据兜底，不用"看起来像是在跑"的进度
 *   · 审计与拒绝的记录都会写日志，方便真机调试时回溯
 */
let autoRunner: AutoRunner | null = null;

function registerAutoHandlers(): void {
  ipcMain.handle('auto:start', async (_e, cfg: AutoGradeConfig) => {
    if (!cfg || typeof cfg !== 'object') {
      pushLog('warn', 'auto:start 参数不合法，已拒绝。');
      return { ok: false, error: '参数不合法' };
    }
    if (!platform?.isOpen()) {
      pushLog('warn', '连续阅卷启动失败：阅卷窗口未打开。');
      return { ok: false, error: '请先打开阅卷窗口' };
    }
    if (autoRunner?.isRunning()) {
      pushLog('warn', '连续阅卷已在运行中，本次启动被忽略。');
      return { ok: false, error: '已在运行中' };
    }

    /*
     * 开工前查一次漂移：平台改版后坐标全部失效，若不做这一步，
     * 失败会表现为"点击没反应"，而原因看起来像"平台卡了"，
     * 排查方向被带偏。
     *
     * `checkDrift()` 返回 `DriftReport | null`，null 表示**无从判断**
     *（没拾取过 / 拿不到当前指纹）。此时刻意**不拦**启动，但必须
     * 把"这次没做漂移检查"说清楚——静默通过会让人以为检查过了。
     */
    const drift = await platform.checkDrift();
    if (drift === null) {
      pushLog('info', '本次未做页面结构漂移检查（无历史指纹可比对），运行中若点击无效应优先怀疑平台改版。');
    } else if (drift.changed) {
      const detail = drift.details?.join('；') ?? '页面结构与拾取时不一致';
      pushLog('warn', `连续阅卷未启动：${detail}`);
      if (drift.action) pushLog('info', drift.action);
      return { ok: false, error: '页面结构已变化，请重新拾取后再启动' };
    }

    const settings = loadSettings();
    const runner = new AutoRunner(
      platform,
      cfg,
      {
        log: (level, msg) => pushLog(level, msg),
        progress: (p) => {
          mainWindow?.webContents.send('evt:progress', {
            running: p.running,
            handled: p.handled,
            current: p.current,
            lastScore: p.lastScore ?? 0,
          });
        },
        awaitConfirm: (payload) => mainWindow?.webContents.send('evt:awaitConfirm', payload),
        finished: (outcome) => {
          pushLog(
            outcome.kind === 'error' ? 'error' : 'ok',
            `连续阅卷结束：${outcome.kind}，处理 ${outcome.handled} 份，提交 ${outcome.submitted} 份。`,
          );
          if (outcome.kind === 'error') {
            pushLog('warn', `结束原因：${outcome.error ?? '未知'}`);
          }
          autoRunner = null;
        },
      },
      settings.ai,
    );
    autoRunner = runner;

    pushLog(
      'info',
      `连续阅卷启动：${cfg.mode === 'top' ? '无人值守（自动填分+自动提交）' : cfg.mode === 'steady' ? '稳健（逐份确认，不自动提交）' : '仅评分（不填分）'}模式。`,
    );
    // 刻意不 await：一轮可能跑几十分钟，阻塞 IPC 会让整个界面卡死
    void runner.run();
    return { ok: true };
  });

  ipcMain.handle('auto:stop', () => {
    if (!autoRunner) {
      // 没有在跑却说"已停止"会让老师以为停掉了某个正在跑的任务
      pushLog('info', '当前没有正在运行的连续阅卷。');
      return { ok: false };
    }
    autoRunner.stop();
    return { ok: true };
  });

  ipcMain.handle('auto:confirm', () => {
    if (!autoRunner) {
      pushLog('warn', '当前没有正在运行的连续阅卷，确认被忽略。');
      return { ok: false };
    }
    return { ok: autoRunner.confirm() };
  });
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
logStartup('即将 await app.whenReady()');

if (!app.requestSingleInstanceLock()) {
  // ★ 单实例锁拿不到时**不会**创建窗口 —— 现象就是"双击后窗口一闪/根本不出现"。
  //   以前这里只有一行 app.quit()，什么痕迹都不留，非常难查。现在会记日志并提示。
  logStartup('!! requestSingleInstanceLock 返回 false → 已有实例在运行，本实例将退出');
  app.quit();
} else {
  app.on('second-instance', () => {
    logStartup('second-instance：第二次双击，聚焦已有窗口');
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    logStartup('whenReady 已触发');
    registerIpc();
    logStartup('IPC 已注册，准备创建主窗口');
    mainWindow = createMainWindow();
    logStartup(`主窗口已创建（isDestroyed=${mainWindow.isDestroyed()}）`);

    pushLog('info', `Grading_exam v${app.getVersion()} 启动`);
    pushLog('info', `Electron ${process.versions.electron} / Chrome ${process.versions.chrome} / Node ${process.versions.node}`);
    pushLog('info', `配置存放于 ${getStorePath()}`);
    // 便携版必须告诉用户数据在哪：整个目录拷走即可带走全部数据。
    // 默认位置则说明"不随程序目录移动"，避免用户以为拷走 exe 就带走了配置。
    pushLog('info', describeStoreLocation(resolveStoreDirFromEnv(process.env)));

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
  logStartup(`window-all-closed：所有窗口已关闭（平台 ${process.platform}）`);
  // ★ 诊断开关 GE_KEEP_ALIVE=1：不退出，让应用留在后台。
  //   用来判定"一闪而过"是否由窗口被关闭触发 —— 因为 showFailure 会重载页面，
  //   万一过程中窗口被销毁，就会走进这里连锁退出。
  if (process.env['GE_KEEP_ALIVE'] === '1') {
    logStartup('GE_KEEP_ALIVE=1 → 不退出，保持进程存活以便观察');
    return;
  }
  if (process.platform !== 'darwin') {
    logStartup('非 macOS → app.quit()');
    app.quit();
  }
});