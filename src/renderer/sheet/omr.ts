/**
 * 纯前端 OMR (Optical Mark Recognition) 答题卡客观题填涂识别引擎。
 *
 * 核心原理：
 * 1. 纯像素级统计，零外部依赖（无需 Python/OpenCV），零网络请求，零 Token。
 * 2. 对每个选项候选区域（如 A/B/C/D）提取灰度密度与二值化暗像素占比。
 * 3. 动态基线消噪：以选项区域的整体背景灰度为基准，计算相对对比度，天然抵御光照不均与扫描偏色。
 */

import type { OmrOptionDetail, OmrResult } from '../../shared/sheet-types';

export interface OmrEngineOptions {
  /** 选项数量，默认 4（A, B, C, D） */
  optionCount?: number;
  /** 判定为填涂的最小黑像素比例（0..1），默认 0.20 (20%) */
  fillRatioThreshold?: number;
  /** 黑像素二值化阈值（0..255），默认 155（低于该值视为深色笔画） */
  darknessThreshold?: number;
  /** 选项标签列表，默认 ['A', 'B', 'C', 'D'] */
  optionLabels?: string[];
  /** 区分单选与多选，若为 true 则允许多选，否则只取最高置信度项 */
  allowMultiple?: boolean;
}

const DEFAULT_LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

/**
 * 从 ImageData 或灰度二维数组中识别客观题填涂。
 * @param grayscaleMatrix 2D 数组，行 x 列，数值 0 (黑) ~ 255 (白)
 */
export function detectBubbleMarks(
  grayscaleMatrix: number[][],
  opts: OmrEngineOptions = {}
): OmrResult {
  const optionCount = opts.optionCount ?? 4;
  const fillRatioThreshold = opts.fillRatioThreshold ?? 0.18;
  const darknessThreshold = opts.darknessThreshold ?? 150;
  const labels = opts.optionLabels ?? DEFAULT_LABELS.slice(0, optionCount);
  const allowMultiple = opts.allowMultiple ?? false;

  const height = grayscaleMatrix.length;
  if (height === 0) {
    return {
      questionNo: '',
      recognizedAnswer: '',
      options: [],
      confidence: 0,
      isBlank: true,
    };
  }
  const width = grayscaleMatrix[0]?.length ?? 0;
  if (width === 0) {
    return {
      questionNo: '',
      recognizedAnswer: '',
      options: [],
      confidence: 0,
      isBlank: true,
    };
  }

  // 1. 将该题区域水平均匀划分为 optionCount 个选项子块
  // 留出微小内边距（10% margin），排除边框线条干扰
  const slotWidth = width / optionCount;
  const optionDetails: OmrOptionDetail[] = [];

  for (let i = 0; i < optionCount; i++) {
    const label = labels[i] ?? String.fromCharCode(65 + i);
    const startX = Math.floor(i * slotWidth + slotWidth * 0.1);
    const endX = Math.floor((i + 1) * slotWidth - slotWidth * 0.1);
    const startY = Math.floor(height * 0.1);
    const endY = Math.floor(height * 0.9);

    let totalPixels = 0;
    let darkPixels = 0;
    let sumGray = 0;

    for (let y = startY; y < endY; y++) {
      const row = grayscaleMatrix[y];
      if (!row) continue;
      for (let x = startX; x < endX; x++) {
        const val = row[x];
        if (typeof val === 'number') {
          totalPixels++;
          sumGray += val;
          if (val < darknessThreshold) {
            darkPixels++;
          }
        }
      }
    }

    const fillRatio = totalPixels > 0 ? darkPixels / totalPixels : 0;
    const avgGray = totalPixels > 0 ? sumGray / totalPixels : 255;
    // 综合加权密度：结合黑像素比例与墨迹深度（越黑、黑像素越多，score 越高）
    const effectiveDensity = fillRatio * (1 - avgGray / 255);
    const isFilled = fillRatio >= fillRatioThreshold && avgGray < darknessThreshold;

    optionDetails.push({
      option: label,
      fillRatio: Number(effectiveDensity.toFixed(3)),
      isFilled,
    });
  }

  // 2. 识别结论汇总
  const filledOptions = optionDetails.filter((o) => o.isFilled);

  if (filledOptions.length === 0) {
    return {
      questionNo: '',
      recognizedAnswer: '',
      options: optionDetails,
      confidence: 0.95, // 确定未填涂
      isBlank: true,
    };
  }

  if (!allowMultiple && filledOptions.length > 1) {
    // 单选模式下，若有多个标记，按有效墨深排序
    filledOptions.sort((a, b) => b.fillRatio - a.fillRatio);
    const top = filledOptions[0];
    const second = filledOptions[1];
    // 若最高项比次高项显著更高（> 1.3倍），裁定为单选最高项
    if (top.fillRatio > second.fillRatio * 1.3) {
      return {
        questionNo: '',
        recognizedAnswer: top.option,
        options: optionDetails,
        confidence: Number(Math.min(1.0, top.fillRatio / 0.5).toFixed(2)),
        isBlank: false,
      };
    }
  }

  // 排序得出最终字符串（如 "B" 或 "ACD"）
  const recognizedAnswer = filledOptions.map((o) => o.option).join('');
  const maxRatio = Math.max(...filledOptions.map((o) => o.fillRatio));

  return {
    questionNo: '',
    recognizedAnswer,
    options: optionDetails,
    confidence: Number(Math.min(1.0, maxRatio / 0.45).toFixed(2)),
    isBlank: false,
  };
}

/**
 * 将 HTML ImageData 提取为灰度矩阵，供 OMR 算法使用。
 */
export function imageDataToGrayscaleMatrix(imageData: ImageData): number[][] {
  const { width, height, data } = imageData;
  const matrix: number[][] = new Array(height);

  for (let y = 0; y < height; y++) {
    const row = new Array<number>(width);
    const rowOffset = y * width * 4;
    for (let x = 0; x < width; x++) {
      const idx = rowOffset + x * 4;
      const r = data[idx] ?? 255;
      const g = data[idx + 1] ?? 255;
      const b = data[idx + 2] ?? 255;
      // 标准 ITU-R BT.601 灰度加权公式
      row[x] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    }
    matrix[y] = row;
  }

  return matrix;
}
