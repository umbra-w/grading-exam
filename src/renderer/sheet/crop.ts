/**
 * 答题卡坐标换算与题区切片裁切工具 (Phase A2)。
 *
 * 坐标系约定：
 * 1. 归一化坐标 (NormalizedRect)：x, y, width, height 均在 [0, 1] 之间。
 *    不论原图是 1000x1400 还是 3000x4200，模板定义恒定不变。
 * 2. 像素坐标 (PixelRect)：乘以实际图片宽高后的整型像素尺寸。
 */

import type { NormalizedRect } from '../../shared/sheet-types';

export function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

/** 规范化矩形，保证宽度与高度为正，且边界严格在 [0, 1] 内 */
export function sanitizeNormalizedRect(r: NormalizedRect): NormalizedRect {
  let x = clamp(r.x, 0, 1);
  let y = clamp(r.y, 0, 1);
  let width = clamp(r.width, 0, 1 - x);
  let height = clamp(r.height, 0, 1 - y);

  if (width < 0) {
    x += width;
    width = Math.abs(width);
  }
  if (height < 0) {
    y += height;
    height = Math.abs(height);
  }

  return {
    x: Number(x.toFixed(4)),
    y: Number(y.toFixed(4)),
    width: Number(Math.max(0.001, width).toFixed(4)),
    height: Number(Math.max(0.001, height).toFixed(4)),
  };
}

/** 将相对归一化矩形映射到实际像素矩形 */
export function toPixelRect(
  rect: NormalizedRect,
  containerWidth: number,
  containerHeight: number
): { x: number; y: number; width: number; height: number } {
  const norm = sanitizeNormalizedRect(rect);
  return {
    x: Math.round(norm.x * containerWidth),
    y: Math.round(norm.y * containerHeight),
    width: Math.max(1, Math.round(norm.width * containerWidth)),
    height: Math.max(1, Math.round(norm.height * containerHeight)),
  };
}

/** 检查归一化坐标点是否落在矩形内 */
export function isPointInRect(px: number, py: number, rect: NormalizedRect): boolean {
  return (
    px >= rect.x &&
    px <= rect.x + rect.width &&
    py >= rect.y &&
    py <= rect.y + rect.height
  );
}

export interface CropResult {
  dataUrl: string;
  pixelWidth: number;
  pixelHeight: number;
}

/**
 * 从 Canvas 或图片中将题区切片裁切出来。
 * 纯前端内存操作，返回切片 Base64。
 */
export function cropCanvasRegion(
  source: HTMLCanvasElement | HTMLImageElement,
  rect: NormalizedRect,
  opts: { format?: 'image/jpeg' | 'image/png'; quality?: number } = {}
): CropResult {
  const naturalWidth = 'naturalWidth' in source ? source.naturalWidth : source.width;
  const naturalHeight = 'naturalHeight' in source ? source.naturalHeight : source.height;

  const pixel = toPixelRect(rect, naturalWidth, naturalHeight);

  if (typeof document === 'undefined') {
    // 纯 Node/单测无 DOM 环境降级
    return {
      dataUrl: 'data:image/png;base64,mockCrop',
      pixelWidth: pixel.width,
      pixelHeight: pixel.height,
    };
  }

  const canvas = document.createElement('canvas');
  canvas.width = pixel.width;
  canvas.height = pixel.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('无法创建 2D 绘图上下文');
  }

  ctx.drawImage(
    source,
    pixel.x,
    pixel.y,
    pixel.width,
    pixel.height,
    0,
    0,
    pixel.width,
    pixel.height
  );

  const format = opts.format ?? 'image/jpeg';
  const quality = opts.quality ?? 0.9;
  const dataUrl = canvas.toDataURL(format, quality);

  return {
    dataUrl,
    pixelWidth: pixel.width,
    pixelHeight: pixel.height,
  };
}
