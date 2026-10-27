/**
 * 答卷图片读取（F3.4 批量导入）—— 主进程侧薄绑定。
 *
 * 职责刻意收窄到「路径 → 读字节 → data URL」：解码、灰度统计、空白判定
 * 全部放渲染层（浏览器 `<img>` 解码自带 EXIF 方向处理，Node 侧要做到
 * 同等效果得额外引 exif 库 —— 见 types.ts 该通道的注释）。
 *
 * ⚠ 未验证：dialog 与真实文件读取依赖 Electron 运行时，本机起不来（§5）。
 * mime 映射 `extToMime` 是纯函数、可测（tests/images.test.ts）。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ImportedImage, ReadImagesResult } from '../../shared/types';

/** 支持的图片扩展名 → MIME。名单刻意从紧：视觉模型认得的、浏览器能解码的交集 */
const EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

/** 纯函数：扩展名 → MIME；不认识返回 null（调用方逐文件报错，不静默跳过） */
export function extToMime(fileName: string): string | null {
  const ext = path.extname(fileName).toLowerCase();
  return EXT_TO_MIME[ext] ?? null;
}

/**
 * 读一批图片文件。
 *
 * 单个文件失败（不存在/扩展名不支持/读取出错）**只影响那一个**：
 * 进 `errors`，其余照常返回。全部失败时 `ok:false` 且 `images` 为空 ——
 * "一张都没读成"和"读了三张"对老师是两种完全不同的局面，必须区分。
 */
export async function readImages(paths: readonly string[]): Promise<ReadImagesResult> {
  const images: ImportedImage[] = [];
  const errors: string[] = [];

  for (const p of paths) {
    if (typeof p !== 'string' || p.trim() === '') {
      errors.push('收到空路径，已跳过');
      continue;
    }
    const fileName = path.basename(p);
    const mime = extToMime(fileName);
    if (!mime) {
      errors.push(`${fileName}：不是支持的图片格式（支持 png / jpg / jpeg / webp / bmp）`);
      continue;
    }
    try {
      const buf = await readFile(p);
      images.push({
        fileName,
        dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
        bytes: buf.length,
      });
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      errors.push(`${fileName}：读取失败（${msg}）`);
    }
  }

  if (images.length === 0) {
    return {
      ok: false,
      images: [],
      errors,
      error: errors.length > 0 ? '没有读到任何可用图片' : '没有收到任何文件路径',
    };
  }
  return { ok: true, images, errors };
}