/**
 * 图片灰度统计（F3.4 批量导入的空白卷判定输入）—— 渲染层。
 *
 * 分两层，纪律同 §4.4：
 *   · `statsFromImageData` 纯函数：ImageData 像素 → GrayStats。可测。
 *   · `grayStatsFromDataUrl` 薄绑定 ⚠：data URL → Image → canvas → ImageData。
 *     依赖真实浏览器解码（jsdom 的 canvas 没有像素，无法验）；
 *     `pnpm ui:verify` 的 Edge 无头渲染是目前的替代验证路径。
 *
 * 为什么统计放渲染层而不是主进程：浏览器解码自带 EXIF 方向处理 ——
 * 手机竖拍的照片字节流是横的、靠 EXIF 标记转正，Node 侧处理要额外引库，
 * 浏览器免费拿到。判定本身在 `shared/blank-paper.ts`（两边共用）。
 */
import type { GrayStats } from '@shared/blank-paper';

/** 采样目标：~50k 个像素足够稳定地估计 stdDev，又比全采样快两个数量级 */
const TARGET_SAMPLES = 50_000;

export interface StatsFromPixelsOptions {
  /** 覆盖默认采样步长（测试用）；≤0 视为 1 */
  step?: number;
}

/**
 * 从 RGBA 像素数组算灰度统计（BT.601 加权：人眼对绿色最敏感，
 * 直接取 (r+g+b)/3 会把亮度感知算偏，空白判定阈值是按感知灰度定的）。
 *
 * 固定步长抽样（不是随机）：同样的输入永远得到同样的统计量 ——
 * 空白判定是"拦 API 调用"的闸门，判定必须可复现，随机抽样会让
 * "这次拦了下次没拦"这种 bug 无从查起。
 *
 * 输入不合法（空像素/NaN）返回 null，由 `classifyBlankPaper` 判 unknown。
 */
export function statsFromImageData(
  pixels: Uint8ClampedArray,
  opts: StatsFromPixelsOptions = {},
): GrayStats | null {
  if (!pixels || pixels.length < 4) return null;
  const totalPixels = Math.floor(pixels.length / 4);
  if (totalPixels === 0) return null;

  const rawStep = opts.step ?? Math.max(1, Math.floor(totalPixels / TARGET_SAMPLES));
  const step = rawStep > 0 ? rawStep : 1;

  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let i = 0; i < totalPixels; i += step) {
    const o = i * 4;
    const gray = 0.299 * pixels[o]! + 0.587 * pixels[o + 1]! + 0.114 * pixels[o + 2]!;
    sum += gray;
    sumSq += gray * gray;
    n++;
  }
  if (n === 0) return null;

  const mean = sum / n;
  // 单遍方差公式；浮点误差可能给出 -1e-13 这类极小负数，clamp 到 0
  const variance = Math.max(0, sumSq / n - mean * mean);
  const stdDev = Math.sqrt(variance);

  if (!Number.isFinite(mean) || !Number.isFinite(stdDev)) return null;
  return { mean, stdDev, samples: n };
}

/**
 * ⚠ 未验证（薄绑定）：解码 data URL 并算灰度统计，顺带带回解码后尺寸
 * （面板要显示 W×H —— 一次解码两用，不做第二次 Image 解码）。
 *
 * 依赖：浏览器 `Image` + `<canvas>` 2D 上下文。失败路径（解码失败、
 * canvas 被污染、画布为 0 尺寸）一律返回 null —— 上层判 unknown
 * 放行识别，**绝不**编一个统计量出来。
 */
export interface DecodedImageStats {
  stats: GrayStats;
  width: number;
  height: number;
}

export function grayStatsFromDataUrl(dataUrl: string): Promise<DecodedImageStats | null> {
  return new Promise((resolve) => {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
      resolve(null);
      return;
    }
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        if (!(w > 0) || !(h > 0)) {
          resolve(null);
          return;
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.drawImage(img, 0, 0);
        const { data } = ctx.getImageData(0, 0, w, h);
        const stats = statsFromImageData(data);
        if (!stats) {
          resolve(null);
          return;
        }
        resolve({ stats, width: w, height: h });
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}