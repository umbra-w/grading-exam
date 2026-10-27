import { describe, expect, it } from 'vitest';
import {
  clamp,
  sanitizeNormalizedRect,
  toPixelRect,
  isPointInRect,
  cropCanvasRegion,
} from '../src/renderer/sheet/crop';

describe('答题卡坐标换算与切片 (Phase A2)', () => {
  it('clamp 能正确截断上下界', () => {
    expect(clamp(0.5, 0, 1)).toBe(0.5);
    expect(clamp(-0.2, 0, 1)).toBe(0);
    expect(clamp(1.5, 0, 1)).toBe(1);
  });

  it('sanitizeNormalizedRect 能规范越界与负宽高矩形', () => {
    const normal = sanitizeNormalizedRect({
      x: 0.1,
      y: 0.2,
      width: 0.3,
      height: 0.4,
    });
    expect(normal.x).toBe(0.1);
    expect(normal.y).toBe(0.2);
    expect(normal.width).toBe(0.3);
    expect(normal.height).toBe(0.4);

    // 超出右边界截断
    const overflow = sanitizeNormalizedRect({
      x: 0.8,
      y: 0.5,
      width: 0.5,
      height: 0.2,
    });
    expect(overflow.x).toBe(0.8);
    expect(overflow.width).toBe(0.2);
  });

  it('toPixelRect 精确换算为容器像素尺寸', () => {
    const rect = { x: 0.1, y: 0.2, width: 0.5, height: 0.3 };
    const pixel = toPixelRect(rect, 1000, 2000);

    expect(pixel.x).toBe(100);
    expect(pixel.y).toBe(400);
    expect(pixel.width).toBe(500);
    expect(pixel.height).toBe(600);
  });

  it('isPointInRect 正确判定归一化命中点', () => {
    const rect = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 };

    expect(isPointInRect(0.3, 0.3, rect)).toBe(true);
    expect(isPointInRect(0.2, 0.2, rect)).toBe(true);
    expect(isPointInRect(0.6, 0.6, rect)).toBe(true);

    expect(isPointInRect(0.1, 0.3, rect)).toBe(false);
    expect(isPointInRect(0.7, 0.3, rect)).toBe(false);
    expect(isPointInRect(0.3, 0.7, rect)).toBe(false);
  });

  it('cropCanvasRegion 在单测/Node 环境下能降级返回切片尺寸', () => {
    const fakeCanvas = {
      width: 1000,
      height: 1500,
    } as unknown as HTMLCanvasElement;

    const res = cropCanvasRegion(fakeCanvas, {
      x: 0.1,
      y: 0.1,
      width: 0.4,
      height: 0.2,
    });

    expect(res.pixelWidth).toBe(400);
    expect(res.pixelHeight).toBe(300);
    expect(res.dataUrl).toContain('data:image/');
  });
});
