import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  saveRecoveryAutosave,
  checkCrashRecovery,
  finalizeRecoveryAutosave,
  clearRecovery,
  RECOVERY_TEMP_FILENAME,
  RECOVERY_FINAL_FILENAME,
} from '../src/main/io/recovery';
import type { RecoverySession } from '../src/shared/types';

describe('崩溃自动恢复协议 (Phase C3)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'recovery-test-'));
  });

  afterEach(async () => {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // 忽略
    }
  });

  const mockSession: RecoverySession = {
    timestamp: Date.now(),
    activeTab: 'sheet',
    paperTitle: '高三一模数学',
    sheetState: {
      currentIndex: 12,
      totalSheets: 45,
      gradedCount: 12,
    },
    unsavedText: '未提交的简评草稿',
  };

  it('saveRecoveryAutosave 将数据保存到带 ~ 后缀的文件', async () => {
    const ok = await saveRecoveryAutosave(tempDir, mockSession);
    expect(ok).toBe(true);

    const check = await checkCrashRecovery(tempDir);
    expect(check.hasCrash).toBe(true);
    expect(check.session?.paperTitle).toBe('高三一模数学');
    expect(check.session?.sheetState?.currentIndex).toBe(12);
  });

  it('finalizeRecoveryAutosave 重命名去除 ~ 后缀表示正常退出', async () => {
    await saveRecoveryAutosave(tempDir, mockSession);

    const fin = await finalizeRecoveryAutosave(tempDir);
    expect(fin).toBe(true);

    // 正常退出后，~ 后缀文件消失，故不会被判定为异常崩溃，但最终文件存在
    const check = await checkCrashRecovery(tempDir);
    expect(check.hasCrash).toBe(false);

    const { stat } = await import('node:fs/promises');
    const finalFile = path.join(tempDir, RECOVERY_FINAL_FILENAME);
    const exists = await stat(finalFile).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  it('clearRecovery 安全清理所有恢复文件', async () => {
    await saveRecoveryAutosave(tempDir, mockSession);
    await clearRecovery(tempDir);

    const check = await checkCrashRecovery(tempDir);
    expect(check.hasCrash).toBe(false);
  });

  it('损坏的 JSON 内容能够容错降级不崩溃', async () => {
    const { writeFile } = await import('node:fs/promises');
    const badPath = path.join(tempDir, RECOVERY_TEMP_FILENAME);
    await writeFile(badPath, 'INVALID_JSON_CONTENT{{{', 'utf-8');

    const check = await checkCrashRecovery(tempDir);
    expect(check.hasCrash).toBe(false);
  });
});
