/**
 * 判分流水线纯逻辑测试（grade-pipeline.ts）。
 *
 * 每条纪律对应一类真实假分事故：
 *   · 客观题没参考答案 → 无法判分，绝不交模型猜
 *   · 缺答案 → 0 分 + 强制复核（≠ 真零分）
 *   · AI 结果缺失/ungradable → 未评分口径（confidence 0 + 复核）
 *   · buildScoreLine 的空格子 = 未录入口径，parseScoresText 会拦
 */
import { describe, expect, it } from 'vitest';
import { buildScoreLine, gradeSubmissionPure, planGrading } from '../src/renderer/grade-pipeline';
import type { PaperQuestion } from '../src/renderer/paper-entry';
import type { GradeResult, StudentSubmission } from '@shared/types';

const QUESTIONS: PaperQuestion[] = [
  { questionId: 'Q1', type: 'choice', fullScore: 3, referenceAnswer: 'B' },
  { questionId: 'Q2', type: 'fill', fullScore: 4, referenceAnswer: '3' },
  { questionId: 'Q3', type: 'choice', fullScore: 3 }, // 故意缺参考答案
  { questionId: 'Q4', type: 'calc', fullScore: 10, scoringPoints: ['列出方程', '解对'] },
  { questionId: 'Q5', type: 'essay', fullScore: 10 }, // 主观题无得分点
];

function submission(answers: Record<string, string>, id = '2024001'): StudentSubmission {
  return {
    id,
    name: '张三',
    examNo: id,
    answers: Object.entries(answers).map(([questionId, text]) => ({ questionId, text })),
  };
}

function aiResult(score: number, conf = 0.9): GradeResult {
  return {
    score,
    comment: '按要点给分',
    hitPoints: ['列出方程'],
    missedPoints: score >= 10 ? [] : ['解对'],
    confidence: conf,
    reviewRequested: conf < 0.75,
    warnings: [],
    promptVersion: 't',
    promptHash: 't',
  };
}

describe('planGrading —— 分流', () => {
  it('客观题有参考答案 → objective；主观题 → ai', () => {
    const p = planGrading(submission({ Q1: 'B', Q2: '3', Q4: 'x=1' }), QUESTIONS);
    const m = new Map(p.items.map((i) => [i.questionId, i.method]));
    expect(m.get('Q1')).toBe('objective');
    expect(m.get('Q2')).toBe('objective');
    expect(m.get('Q4')).toBe('ai');
  });

  it('客观题没参考答案 → ungradeable（绝不交给模型猜）', () => {
    const p = planGrading(submission({ Q3: 'A' }), QUESTIONS);
    const q3 = p.items.find((i) => i.questionId === 'Q3');
    expect(q3?.method).toBe('ungradeable');
    expect(q3?.reason).toMatch(/未提供参考答案/);
  });

  it('识别缺答案 → ungradeable，studentText 为 null（缺答案 ≠ 空字符串答案）', () => {
    const p = planGrading(submission({ Q1: 'B' }), QUESTIONS);
    const q4 = p.items.find((i) => i.questionId === 'Q4');
    expect(q4?.method).toBe('ungradeable');
    expect(q4?.studentText).toBeNull();
    expect(q4?.reason).toMatch(/未识别出/);
  });

  it('主观题无得分点 → 仍走 ai，但必须警告"依据不足"', () => {
    const p = planGrading(submission({ Q5: '论述正文' }), QUESTIONS);
    expect(p.items.find((i) => i.questionId === 'Q5')?.method).toBe('ai');
    expect(p.warnings.join()).toMatch(/Q5/);
    expect(p.warnings.join()).toMatch(/评分要点/);
  });

  it('计划是确定性的：同一输入两次结果一致', () => {
    const s = submission({ Q1: 'B', Q2: '3', Q4: 'x=1', Q5: '文' });
    expect(planGrading(s, QUESTIONS)).toEqual(planGrading(s, QUESTIONS));
  });
});

describe('gradeSubmissionPure —— 组装', () => {
  const NOW = 1_700_000_000_000;

  it('客观题比对：对 → 满分；错 → 0（无部分分）；写法不同且未给备选 → wrong 不复核', () => {
    // Q1='B' 对（满分 3）；Q2 写 '三' 而标准 '3'：
    // acceptable/optionText 本轮未在 UI 提供入口，pipeline 用默认 opts ——
    // 等价答案应由教师写在参考答案备选里（口径在 objective.ts，未接前不猜）。
    const out = gradeSubmissionPure(
      submission({ Q1: 'B', Q2: '三' }),
      QUESTIONS,
      new Map(),
      NOW,
    );
    const d1 = out.result.details.find((d) => d.questionId === 'Q1')!;
    const d2 = out.result.details.find((d) => d.questionId === 'Q2')!;
    expect(d1.score).toBe(3);
    expect(d1.local).toBe(true);
    expect(d2.score).toBe(0);
    expect(d2.reviewRequested).toBe(false);
    expect(d2.comment).toMatch(/不一致/);
  });

  it('缺答案的题：0 分 + confidence 0 + 强制复核，且不编造得分点', () => {
    const out = gradeSubmissionPure(submission({ Q1: 'B' }), QUESTIONS, new Map(), NOW);
    const d4 = out.result.details.find((d) => d.questionId === 'Q4')!;
    expect(d4.score).toBe(0);
    expect(d4.confidence).toBe(0);
    expect(d4.reviewRequested).toBe(true);
    expect(d4.hitPoints).toEqual([]);
    expect(d4.missedPoints).toEqual([]);
    expect(d4.comment).toMatch(/未识别出/);
  });

  it('AI 结果正常组装：分数/要点/复核标记透传', () => {
    const out = gradeSubmissionPure(
      submission({ Q4: '解：x=1' }),
      QUESTIONS,
      new Map([['Q4', aiResult(7)]]),
      NOW,
    );
    const d4 = out.result.details.find((d) => d.questionId === 'Q4')!;
    expect(d4.score).toBe(7);
    expect(d4.local).toBe(false);
    expect(d4.hitPoints).toEqual(['列出方程']);
  });

  it('AI 结果缺失 → 未评分口径（0 分 + confidence 0 + 复核）并进 missingAi 警告', () => {
    const out = gradeSubmissionPure(submission({ Q4: '解' }), QUESTIONS, new Map(), NOW);
    const d4 = out.result.details.find((d) => d.questionId === 'Q4')!;
    expect(d4.score).toBe(0);
    expect(d4.confidence).toBe(0);
    expect(d4.reviewRequested).toBe(true);
    expect(out.missingAi).toEqual(['Q4']);
    expect(out.warnings.join()).toMatch(/未拿到 AI 评分结果/);
  });

  it('AI ungradable 结果 → 不当真零分：0 分 + 复核 + 原因进 comment', () => {
    const ungradable = aiResult(0, 0);
    ungradable.ungradable = true;
    ungradable.warnings = ['图片质量不合格'];
    const out = gradeSubmissionPure(
      submission({ Q4: '解' }),
      QUESTIONS,
      new Map([['Q4', ungradable]]),
      NOW,
    );
    const d4 = out.result.details.find((d) => d.questionId === 'Q4')!;
    expect(d4.score).toBe(0);
    expect(d4.confidence).toBe(0);
    expect(d4.comment).toMatch(/图片质量不合格/);
  });

  it('total/fullTotal 汇总正确；需复核数进 comment', () => {
    const out = gradeSubmissionPure(
      submission({ Q1: 'B', Q2: '3', Q3: 'A', Q4: '解', Q5: '文' }),
      QUESTIONS,
      new Map([
        ['Q4', aiResult(10)],
        ['Q5', aiResult(6)],
      ]),
      NOW,
    );
    // Q1=3 对 + Q2=4 对 + Q3=0（无参考答案，复核）+ Q4=10 + Q5=6
    expect(out.result.total).toBe(23);
    expect(out.result.fullTotal).toBe(30);
    expect(out.result.comment).toMatch(/需人工复核/);
  });

  it('不改入参', () => {
    const s = submission({ Q1: 'B', Q4: '解' });
    const snap = JSON.parse(JSON.stringify(s));
    gradeSubmissionPure(s, QUESTIONS, new Map([['Q4', aiResult(5)]]), NOW);
    expect(s).toEqual(snap);
  });
});

describe('buildScoreLine —— 成绩行回填', () => {
  const NOW = 1_700_000_000_000;

  it('正常行：姓名,考号,每题分数（与录入区表头同构）', () => {
    const out = gradeSubmissionPure(
      submission({ Q1: 'B', Q2: '3', Q3: 'A', Q4: '解', Q5: '文' }),
      QUESTIONS,
      new Map([
        ['Q4', aiResult(10)],
        ['Q5', aiResult(6)],
      ]),
      NOW,
    );
    const line = buildScoreLine(out.result, QUESTIONS);
    // Q3 无参考答案 → 空格子（未录入口径）
    expect(line.startsWith('张三,2024001,3,4,,10,6')).toBe(true);
  });

  it('confidence 0 的题留空（0 分 ≠ 未评分），AI 真实 0 分照填', () => {
    const out = gradeSubmissionPure(
      submission({ Q4: '空白作答', Q5: '文' }),
      QUESTIONS,
      new Map([
        ['Q4', aiResult(0, 0.95)], // AI 确认的 0 分
        // Q1 缺答案 → confidence 0
      ]),
      NOW,
    );
    const line = buildScoreLine(out.result, QUESTIONS);
    const cells = line.split(',');
    expect(cells[2]).toBe(''); // Q1 缺答案 → 空
    expect(cells[5]).toBe('0'); // Q4 AI 真 0 分 → 填 0
  });

  it('姓名含逗号时 CSV 转义，不切错列', () => {
    const s = submission({ Q1: 'B' });
    s.name = '张,三';
    const out = gradeSubmissionPure(s, QUESTIONS, new Map(), NOW);
    const line = buildScoreLine(out.result, QUESTIONS);
    expect(line.startsWith('"张,三",')).toBe(true);
  });
});