/**
 * 灰度统计纯函数的测试（gray-stats.ts）。
 *
 * `grayStatsFromDataUrl`（薄绑定）依赖真实浏览器解码，jsdom 无法验 ——
 * 所以把所有可判对错的部分都压进 `statsFromImageData`（纯函数）钉死：
 * 抽样确定性、空输入不猜、以及"统计量错了空白判定就全错"的边界。
 */
import { describe, expect, it } from 'vitest';
import { statsFromImageData } from '../src/renderer/gray-stats';

/** 造一张 W×H 的纯色图（RGBA） */
function solid(w: number, h: number, gray: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = gray;
    px[i + 1] = gray;
    px[i + 2] = gray;
    px[i + 3] = 255;
  }
  return px;
}

describe('statsFromImageData —— 灰度统计（纯函数）', () => {
  it('纯白图：mean≈255、stdDev=0（空白卷的典型输入）', () => {
    const s = statsFromImageData(solid(40, 30, 255));
    expect(s).not.toBeNull();
    expect(s!.mean).toBeCloseTo(255, 5);
    expect(s!.stdDev).toBe(0);
    expect(s!.samples).toBe(40 * 30);
  });

  it('纯黑图同理（镜头盖/压黑也是"无内容"）', () => {
    const s = statsFromImageData(solid(40, 30, 0));
    expect(s!.mean).toBe(0);
    expect(s!.stdDev).toBe(0);
  });

  it('黑白棋盘：mean≈127.5、stdDev 明显大于空白阈值 —— 有内容的图', () => {
    const w = 32;
    const h = 32;
    const px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const v = (Math.floor(i / w) + (i % w)) % 2 === 0 ? 0 : 255;
      px[i * 4] = v;
      px[i * 4 + 1] = v;
      px[i * 4 + 2] = v;
      px[i * 4 + 3] = 255;
    }
    const s = statsFromImageData(px);
    expect(s!.mean).toBeCloseTo(127.5, 1);
    expect(s!.stdDev).toBeGreaterThan(6);
  });

  it('抽样是确定性的：同一输入两次结果完全一致（闸门判定必须可复现）', () => {
    const px = solid(500, 400, 200);
    // 中途撒一些暗点，制造非零方差
    for (let i = 0; i < px.length; i += 400 * 4) px[i] = 30;
    const a = statsFromImageData(px);
    const b = statsFromImageData(px);
    expect(a).toEqual(b);
  });

  it('大图默认抽样 ~50k：样本数有上限，不做 1200 万像素全采样', () => {
    const s = statsFromImageData(solid(3000, 4000, 128));
    expect(s).not.toBeNull();
    expect(s!.samples).toBeLessThanOrEqual(50_000);
    expect(s!.samples).toBeGreaterThanOrEqual(1);
    expect(s!.mean).toBeCloseTo(128, 0);
  });

  it('空/不合法输入返回 null —— 不猜，交给 classifyBlankPaper 判 unknown', () => {
    expect(statsFromImageData(new Uint8ClampedArray(0))).toBeNull();
    expect(statsFromImageData(new Uint8ClampedArray(3))).toBeNull(); // 不足一个像素
    expect(statsFromImageData(null as unknown as Uint8ClampedArray)).toBeNull();
  });

  it('防御分支：统计量算出 NaN 时返回 null（Uint8ClampedArray 本身存不了 NaN —— 赋值即 clamp 为 0，此分支只防未来换数据源）', () => {
    // 普通数组伪装成像素数据：0 号像素的 r 通道是真正的 NaN
    const fake = [Number.NaN, 0, 0, 255, 100, 100, 100, 255] as unknown as Uint8ClampedArray;
    expect(statsFromImageData(fake)).toBeNull();
  });

  it('不改入参（像素数组只读使用）', () => {
    const px = solid(10, 10, 128);
    const snapshot = Uint8ClampedArray.from(px);
    statsFromImageData(px);
    expect(Array.from(px)).toEqual(Array.from(snapshot));
  });
});