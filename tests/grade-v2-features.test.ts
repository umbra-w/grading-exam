import { describe, it, expect } from 'vitest';
import { sanitizeGradeResult } from '../src/main/ai/client';
import { PROMPT_VERSION } from '../src/main/ai/prompts';
import { initialAutoState, nextAutoStep } from '../src/main/page/auto-orchestrator';
import type { AutoGradeConfig, GradeResult, PickResult } from '../src/shared/types';

describe('Phase D · 智阅内核加固功能 (四状态判决与四则运算对账)', () => {
  it('正确识别正常作答并保留得分与算式', () => {
    const raw = {
      paperState: 'normal',
      score: 5,
      subScores: [2, 3],
      mathExpression: '2+3=5',
      comment: '步骤完整，结论正确。',
      hitPoints: ['要点1', '要点2'],
      missedPoints: [],
      confidence: 0.95,
      reviewRequested: false,
    };
    const res = sanitizeGradeResult(raw, 10);
    expect(res).not.toBeNull();
    expect(res?.paperState).toBe('normal');
    expect(res?.score).toBe(5);
    expect(res?.subScores).toEqual([2, 3]);
    expect(res?.mathExpression).toBe('2+3=5');
    expect(res?.mathIntegrity?.ok).toBe(true);
    expect(res?.reviewRequested).toBe(false);
    expect(res?.promptVersion).toBe(PROMPT_VERSION);
  });

  it('正确识别空白卷并归零分，无需人工复核', () => {
    const raw = {
      paperState: 'blank',
      score: 0,
      comment: '学生未作答',
      confidence: 0.98,
      reviewRequested: false,
    };
    const res = sanitizeGradeResult(raw, 10);
    expect(res).not.toBeNull();
    expect(res?.paperState).toBe('blank');
    expect(res?.score).toBe(0);
    expect(res?.reviewRequested).toBe(false);
  });

  it('正确识别阅卷任务已完成提示图 (task_finished)', () => {
    const raw = {
      paperState: 'task_finished',
      score: 0,
      comment: '平台提示当前已无待评试卷',
      confidence: 0.99,
      reviewRequested: false,
    };
    const res = sanitizeGradeResult(raw, 10);
    expect(res).not.toBeNull();
    expect(res?.paperState).toBe('task_finished');
    expect(res?.score).toBe(0);
    expect(res?.reviewRequested).toBe(false);
    expect(res?.warnings.some((w) => w.includes('平台阅卷已完成'))).toBe(true);
  });

  it('识别题目错位/答非所问 (mismatched) 并强制降置信度推入复核队列', () => {
    const raw = {
      paperState: 'mismatched',
      score: 0,
      confidence: 0.85,
      reviewRequested: false,
    };
    const res = sanitizeGradeResult(raw, 10);
    expect(res).not.toBeNull();
    expect(res?.paperState).toBe('mismatched');
    expect(res?.score).toBe(0);
    expect(res?.confidence).toBeLessThanOrEqual(0.3);
    expect(res?.reviewRequested).toBe(true);
    expect(res?.warnings.some((w) => w.includes('疑似错位答卷'))).toBe(true);
  });

  it('捕获四则运算算术幻觉并强制要求人工复核', () => {
    const raw = {
      paperState: 'normal',
      score: 6, // 模型总分给了 6
      subScores: [2, 2, 1], // 但各项相加实际只有 5
      mathExpression: '2+2+1=5',
      comment: '各步骤得分。',
      confidence: 0.95,
      reviewRequested: false,
    };
    const res = sanitizeGradeResult(raw, 10);
    expect(res).not.toBeNull();
    expect(res?.mathIntegrity?.ok).toBe(false);
    expect(res?.mathIntegrity?.discrepancy).toBe(1);
    expect(res?.confidence).toBeLessThanOrEqual(0.6);
    expect(res?.reviewRequested).toBe(true);
    expect(res?.warnings.some((w) => w.includes('[算术对账]'))).toBe(true);
  });

  it('自动化网阅遇到 task_finished 自动安全停机，绝不填分或提交', () => {
    const mockPick: PickResult = {
      kind: 'scoreInput',
      mode: 'element',
      topX: 100,
      topY: 200,
      localX: 100,
      localY: 200,
      framePath: [],
      selector: '#score',
      width: 50,
      height: 20,
      tag: 'input',
      inIframe: false,
      pickedAt: 1,
    };

    const cfg: AutoGradeConfig = {
      pageUrl: 'https://test.com',
      kernel: 'chrome',
      mode: 'top',
      questionId: 'Q1',
      question: { stem: 'test', fullScore: 10, referenceAnswer: '', scoringPoints: [] },
      picks: { scoreInput: mockPick, submitButton: mockPick, questionRegion: mockPick },
      throttleMs: 1000,
      maxPapers: 10,
      nextPaperTimeoutMs: 5000,
    };

    const state = initialAutoState(cfg);
    state.phase = 'grading';
    state.submissionId = 'paper-finished-signal';

    const grade: GradeResult = {
      score: 0,
      comment: '当前无待阅试卷',
      hitPoints: [],
      missedPoints: [],
      confidence: 0.99,
      reviewRequested: false,
      warnings: [],
      paperState: 'task_finished',
      promptVersion: '2.0.0',
      promptHash: 'fake',
    };

    const next = nextAutoStep(state, { kind: 'grade', ok: true, grade });
    expect(next.outcome).toBeDefined();
    expect(next.outcome?.kind).toBe('done');
    expect(next.state.lastMessage).toContain('任务完成或无待阅卷指示图');
    expect(next.step).toBeNull(); // 绝无后续填分或提交步骤
  });
});
