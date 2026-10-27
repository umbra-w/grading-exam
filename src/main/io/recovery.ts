/**
 * 崩溃自动恢复协议（Phase C3 —— 借鉴小卷喵 `~` 后缀安全协议）。
 *
 * 协议说明：
 * 1. 运行中/阅卷中的临时会话状态持久化到 `session_recovery.json~`（以 ~ 结尾）。
 * 2. 正常退出应用时触发 `finalizeRecoveryAutosave`，将 `~` 文件重命名为正常文件或安全清理。
 * 3. 下次启动时若检测到残留的 `session_recovery.json~` 文件，确证上一次会话属于
 *    异常退出（断电/崩溃/进程强杀），弹出恢复提示并还原试卷批改进度与未保存数据。
 */

import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { RecoverySession } from '../../shared/types';

export const RECOVERY_TEMP_FILENAME = 'session_recovery.json~';
export const RECOVERY_FINAL_FILENAME = 'session_recovery.json';

export function getRecoveryPaths(dataDir: string): { tempPath: string; finalPath: string } {
  return {
    tempPath: path.join(dataDir, RECOVERY_TEMP_FILENAME),
    finalPath: path.join(dataDir, RECOVERY_FINAL_FILENAME),
  };
}

/**
 * 写入临时恢复数据（带 ~ 后缀）。
 */
export async function saveRecoveryAutosave(
  dataDir: string,
  session: RecoverySession
): Promise<boolean> {
  try {
    const { tempPath } = getRecoveryPaths(dataDir);
    const content = JSON.stringify(session, null, 2);
    await writeFile(tempPath, content, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 正常关闭会话：去掉 ~ 后缀，表明属于正常退出。
 */
export async function finalizeRecoveryAutosave(dataDir: string): Promise<boolean> {
  const { tempPath, finalPath } = getRecoveryPaths(dataDir);
  try {
    await rename(tempPath, finalPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 检查是否存在异常退出残留的恢复文件。
 */
export async function checkCrashRecovery(
  dataDir: string
): Promise<{ hasCrash: boolean; session?: RecoverySession }> {
  const { tempPath } = getRecoveryPaths(dataDir);
  try {
    const raw = await readFile(tempPath, 'utf-8');
    const session = JSON.parse(raw) as RecoverySession;
    if (session && typeof session.timestamp === 'number') {
      return { hasCrash: true, session };
    }
    return { hasCrash: false };
  } catch {
    // 文件不存在或内容解析失败
    return { hasCrash: false };
  }
}

/**
 * 清除已恢复或不再需要的暂存文件。
 */
export async function clearRecovery(dataDir: string): Promise<boolean> {
  const { tempPath, finalPath } = getRecoveryPaths(dataDir);
  let ok = true;
  try {
    await unlink(tempPath);
  } catch {
    ok = false;
  }
  try {
    await unlink(finalPath);
  } catch {
    // 忽略
  }
  return ok;
}
