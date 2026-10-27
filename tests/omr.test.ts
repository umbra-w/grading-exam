import { describe, expect, it } from 'vitest';
import {
  detectBubbleMarks,
  imageDataToGrayscaleMatrix,
} from '../src/renderer/sheet/omr';

describe('OMR 纯前端客观题填涂识别引擎', () => {
  /**
   * 构造一个全白的基准矩阵 (height x width)，灰度 240 (接近白纸)
   */
  function createBlankPaper(width = 200, height = 40): number[][] {
    return Array.from({ length: height }, () => Array(width).fill(240));
  }

  /**
   * 在特定选项槽内涂黑模拟 2B 铅笔 (灰度 30~50)
   */
  function fillOption(
    matrix: number[][],
    optionIndex: number,
    optionCount = 4,
    darkness = 40
  ): void {
    const width = matrix[0].length;
    const height = matrix.length;
    const slotW = width / optionCount;
    const startX = Math.floor(optionIndex * slotW + slotW * 0.2);
    const endX = Math.floor((optionIndex + 1) * slotW - slotW * 0.2);
    const startY = Math.floor(height * 0.2);
    const endY = Math.floor(height * 0.8);

    for (let y = startY; y < endY; y++) {
      for (let x = startX; x < endX; x++) {
        matrix[y][x] = darkness;
      }
    }
  }

  it('空白未作答试卷能准确识别为 isBlank: true', () => {
    const matrix = createBlankPaper();
    const result = detectBubbleMarks(matrix, { optionCount: 4 });

    expect(result.isBlank).toBe(true);
    expect(result.recognizedAnswer).toBe('');
    expect(result.confidence).toBeGreaterThan(0.9);
    expect(result.options.every((o) => !o.isFilled)).toBe(true);
  });

  it('涂黑第 2 个槽位 (B) 应准确识别为 B', () => {
    const matrix = createBlankPaper();
    fillOption(matrix, 1, 4, 35); // 1 对应 B

    const result = detectBubbleMarks(matrix, { optionCount: 4 });

    expect(result.isBlank).toBe(false);
    expect(result.recognizedAnswer).toBe('B');
    expect(result.options[1].isFilled).toBe(true);
    expect(result.options[0].isFilled).toBe(false);
    expect(result.options[2].isFilled).toBe(false);
    expect(result.options[3].isFilled).toBe(false);
    expect(result.confidence).toBeGreaterThan(0.6);
  });

  it('涂黑第 1 个槽位 (A) 应准确识别为 A', () => {
    const matrix = createBlankPaper();
    fillOption(matrix, 0, 4, 30); // 0 对应 A

    const result = detectBubbleMarks(matrix, { optionCount: 4 });

    expect(result.isBlank).toBe(false);
    expect(result.recognizedAnswer).toBe('A');
    expect(result.options[0].isFilled).toBe(true);
  });

  it('涂黑第 4 个槽位 (D) 应准确识别为 D', () => {
    const matrix = createBlankPaper();
    fillOption(matrix, 3, 4, 30); // 3 对应 D

    const result = detectBubbleMarks(matrix, { optionCount: 4 });

    expect(result.isBlank).toBe(false);
    expect(result.recognizedAnswer).toBe('D');
    expect(result.options[3].isFilled).toBe(true);
  });

  it('多选模式下同时填涂 A 和 C 应识别为 AC', () => {
    const matrix = createBlankPaper();
    fillOption(matrix, 0, 4, 35); // A
    fillOption(matrix, 2, 4, 35); // C

    const result = detectBubbleMarks(matrix, {
      optionCount: 4,
      allowMultiple: true,
    });

    expect(result.isBlank).toBe(false);
    expect(result.recognizedAnswer).toBe('AC');
    expect(result.options[0].isFilled).toBe(true);
    expect(result.options[1].isFilled).toBe(false);
    expect(result.options[2].isFilled).toBe(true);
    expect(result.options[3].isFilled).toBe(false);
  });

  it('单选模式下若有明显优势填涂（主填B + 极弱污迹A），能滤除弱污迹选出B', () => {
    const matrix = createBlankPaper();
    fillOption(matrix, 1, 4, 20); // 浓墨填 B
    // 在 A 处填微弱浅痕
    fillOption(matrix, 0, 4, 140);

    const result = detectBubbleMarks(matrix, {
      optionCount: 4,
      allowMultiple: false,
    });

    expect(result.recognizedAnswer).toBe('B');
  });

  it('支持 5 选项 (A, B, C, D, E) 扩展题型', () => {
    const matrix = createBlankPaper(250, 40);
    fillOption(matrix, 4, 5, 30); // E

    const result = detectBubbleMarks(matrix, { optionCount: 5 });

    expect(result.recognizedAnswer).toBe('E');
    expect(result.options.length).toBe(5);
    expect(result.options[4].option).toBe('E');
    expect(result.options[4].isFilled).toBe(true);
  });

  it('空矩阵能安全兜底不报错', () => {
    const res1 = detectBubbleMarks([]);
    expect(res1.isBlank).toBe(true);
    expect(res1.recognizedAnswer).toBe('');

    const res2 = detectBubbleMarks([[]]);
    expect(res2.isBlank).toBe(true);
    expect(res2.recognizedAnswer).toBe('');
  });

  it('imageDataToGrayscaleMatrix 正确进行 ITU-R BT.601 加权运算', () => {
    // 构造纯红、纯绿、纯蓝、纯白 4 个像素 (2x2)
    const rawData = new Uint8ClampedArray([
      255, 0, 0, 255,   // (0,0) Red: 0.299*255 = 76
      0, 255, 0, 255,   // (1,0) Green: 0.587*255 = 150
      0, 0, 255, 255,   // (0,1) Blue: 0.114*255 = 29
      255, 255, 255, 255, // (1,1) White: 255
    ]);

    const fakeImageData = {
      width: 2,
      height: 2,
      data: rawData,
    } as unknown as ImageData;

    const gray = imageDataToGrayscaleMatrix(fakeImageData);
    expect(gray.length).toBe(2);
    expect(gray[0].length).toBe(2);
    expect(gray[0][0]).toBe(76);
    expect(gray[0][1]).toBe(150);
    expect(gray[1][0]).toBe(29);
    expect(gray[1][1]).toBe(255);
  });
});
