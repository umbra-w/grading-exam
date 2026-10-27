/**
 * 启动诊断日志 —— 把主进程启动过程写到磁盘文件。
 *
 * 为什么需要它（这是踩出来的教训）：
 *   `pushLog` 把日志写进内存 buffer、打到终端、再通过 IPC 推给渲染层 ——
 *   **唯独不写磁盘**。而这个应用恰恰最容易出问题的地方就是"窗口还没出来"，
 *   那一刻渲染层不存在、终端输出的窗口一闪就没，于是**什么证据都不剩**。
 *   用户只能描述"一闪而过"，开发者只能猜。
 *
 * 所以这条链路的每一个环节都必须落盘：
 *   模块加载 → whenReady → 窗口构造 → 页面加载 → 渲染进程崩溃 → 进程退出。
 *   `flush()` 用同步写，因为要赶在 `process.on('exit')` 里最后一刻还能写进去。
 *
 * 位置：跟随 store 同目录（便携版就在 exe 旁的 data/ 下），
 * 用环境变量 `GE_STARTUP_LOG` 可覆盖 —— 便于让用户把日志放到别处。
 */
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const startedAt = new Date();
const lines: string[] = [];

function resolveLogPath(): string {
  const override = process.env['GE_STARTUP_LOG'];
  if (override && override.trim()) return override.trim();
  return path.join(app.getPath('userData'), 'startup.log');
}

let logPath: string | null = null;

export function initStartupLog(): string {
  logPath = resolveLogPath();
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    // 每次启动覆盖，避免文件无限增长；上一次的留在 startup.prev.log
    if (fs.existsSync(logPath)) {
      try {
        fs.copyFileSync(logPath, `${logPath}.prev`);
      } catch {
        /* 备份失败不影响本次日志 */
      }
    }
    fs.writeFileSync(logPath, '', 'utf-8');
  } catch {
    logPath = null;
  }
  logStartup('=== 启动日志开始 ===');
  logStartup(`时间 ${startedAt.toISOString()}`);
  return logPath ?? '(无法写入磁盘)';
}

export function startupLogPath(): string | null {
  return logPath;
}

export function logStartup(message: string): void {
  const ms = Date.now() - startedAt.getTime();
  lines.push(`[+${String(ms).padStart(6)}ms] ${message}`);
  // 同步写：崩溃往往就在下一行，异步写会丢
  if (logPath) {
    try {
      fs.appendFileSync(logPath, `[+${String(ms).padStart(6)}ms] ${message}\n`, 'utf-8');
    } catch {
      /* 写日志失败绝不能把应用搞死 */
    }
  }
}

/** 一次性把所有已记录的行写到 stderr，用于崩溃前的最后挣扎。 */
export function flushStartupLog(): void {
  if (!logPath) return;
  try {
    fs.appendFileSync(logPath, '\n=== 进程退出时的完整记录 ===\n' + lines.join('\n') + '\n', 'utf-8');
  } catch {
    /* ignore */
  }
}