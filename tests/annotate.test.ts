import { describe, expect, it, vi } from 'vitest';
import {
  generateStampsForSheet,
  renderStamps,
} from '../src/renderer/sheet/annotate';
import type { SheetGradeResult } from '../src/shared/sheet-types';

describe('红笔批注与印章渲染 (Phase A4)', () => {
  const mockSheet: SheetGradeResult = {
    sheetId: 'sheet-001',
    fileName: 'student_01.jpg',
    studentName: '张三',
    totalScore: 85,
    maxScore: 100,
    gradedAt: '2026-10-26T17:00:00Z',
    questions: [
      {
        questionNo: '1',
        type: 'objective',
        fullScore: 5,
        awardedScore: 5,
        status: 'full',
        studentAnswer: 'B',
        comment: '',
        confidence: 0.98,
        rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
      },
      {
        questionNo: '2',
        type: 'objective',
        fullScore: 5,
        awardedScore: 0,
        status: 'zero',
        studentAnswer: 'C',
        comment: '错选C，正确为A',
        confidence: 0.95,
        rect: { x: 0.5, y: 0.2, width: 0.3, height: 0.1 },
      },
      {
        questionNo: '3',
        type: 'subjective',
        fullScore: 10,
        awardedScore: 6,
        status: 'partial',
        studentAnswer: '部分答对',
        comment: '步骤二未写出公式',
        confidence: 0.85,
        rect: { x: 0.1, y: 0.4, width: 0.8, height: 0.3 },
      },
    ],
  };

  it('generateStampsForSheet 自动产出卷头总分印章与逐题对应图元', () => {
    const stamps = generateStampsForSheet(mockSheet);

    // 卷头总分双圈章
    const totalStamp = stamps.find((s) => s.type === 'total_badge');
    expect(totalStamp).toBeDefined();
    expect(totalStamp?.score).toBe(85);
    expect(totalStamp?.text).toBe('85分');

    // 满分题应生成 checkmark
    const checkmark = stamps.find((s) => s.type === 'checkmark');
    expect(checkmark).toBeDefined();
    expect(checkmark?.score).toBe(5);

    // 零分题应生成 cross
    const cross = stamps.find((s) => s.type === 'cross');
    expect(cross).toBeDefined();
    expect(cross?.score).toBe(0);

    // 部分分应生成 half_check
    const halfCheck = stamps.find((s) => s.type === 'half_check');
    expect(halfCheck).toBeDefined();
    expect(halfCheck?.score).toBe(6);

    // 应生成得分徽章
    const scoreBadges = stamps.filter((s) => s.type === 'score_badge');
    expect(scoreBadges.length).toBe(3);

    // 应包含扣分评语
    const commentStamps = stamps.filter((s) => s.type === 'text_comment');
    expect(commentStamps.length).toBeGreaterThan(0);
    expect(commentStamps.some((s) => s.text?.includes('步骤二'))).toBe(true);
  });

  it('drawStamp 和 renderStamps 能正常调用 Canvas 2D 指令', () => {
    const mockCtx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      arc: vi.fn(),
      fillText: vi.fn(),
      fillRect: vi.fn(),
      measureText: vi.fn().mockReturnValue({ width: 50 }),
    } as unknown as CanvasRenderingContext2D;

    const stamps = generateStampsForSheet(mockSheet);
    renderStamps(mockCtx, stamps, 1000, 1400);

    expect(mockCtx.save).toHaveBeenCalled();
    expect(mockCtx.restore).toHaveBeenCalled();
    expect(mockCtx.stroke).toHaveBeenCalled();
    expect(mockCtx.fillText).toHaveBeenCalled();
  });
});
