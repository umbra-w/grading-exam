/**
 * F3.4 判分流水线 —— 识别出的答案 → 逐题判分 → 成绩行（纯逻辑）。
 *
 * ── 在链路里的位置 ────────────────────────────────────────────────
 *
 *   批量导入（answer-import）→ StudentSubmission
 *     → **本模块**：分流（本地比对 / AI / 无法判分）→ 组装 StudentResult
 *     → buildScoreLine 产出「姓名,考号,分,分,…」成绩行 → 回填粘贴录入区
 *     → 既有链路（parseScoresText 校验 → aggregate 汇总 → 导出）
 *
 * 回填粘贴区而不是直接 aggregate，是刻意的：判分结果必须经过老师
 * 「校验并解析」那一关（错误行会被拦下、未录 入会标复核），
 * 不存在绕过校验直接进报表的通道。
 *
 * ── 分流的诚实纪律 ────────────────────────────────────────────────
 *
 * 1. 客观题**没有参考答案就判"无法判分"**，绝不交给模型猜字母 ——
 *    模型对"这像不像正确选项"的直觉是最典型的假分来源。
 * 2. 缺答案 ≠ 0 分：识别不出答案的题给 0 分但**强制复核**，
 *    与 paper-entry「未录入」同口径（comment 写明，绝不静默）。
 * 3. AI 结果缺失（调用失败/没调）→ 该题按"未评分"处理（confidence 0
 *    + 强制复核），绝不拿 0 分冒充评分结果。
 */
import { compareObjective, toDetailFields } from '@shared/objective';
import type { ObjectiveResult } from '@shared/objective';
import type {
  GradeResult,
  GradingDetail,
  QuestionType,
  StudentResult,
  StudentSubmission,
} from '@shared/types';
import type { PaperQuestion } from './paper-entry';

/** 客观题型：本地归一化比对，不消耗 token（SPEC F3.2） */
const OBJECTIVE_TYPES: ReadonlySet<QuestionType> = new Set<QuestionType>(['choice', 'judge', 'fill']);

export type GradeMethod = 'objective' | 'ai' | 'ungradeable';

export interface GradePlanItem {
  questionId: string;
  /** 1-based 序号（试卷定义顺序），GradingDetail.index 用 */
  index: number;
  type: QuestionType;
  fullScore: number;
  method: GradeMethod;
  /** 学生答案原文；null = 识别结果里没有这题（缺答案） */
  studentText: string | null;
  /** 为什么要这么分流 —— 直接展示给老师，不让她猜 */
  reason: string;
}

export interface GradePlan {
  items: GradePlanItem[];
  warnings: string[];
}

export interface GradeOutcomePure {
  result: StudentResult;
  /** 计划里 method='ai' 且**没有**拿到 AI 结果的题（调用方据此提示重试） */
  missingAi: string[];
  warnings: string[];
}

/**
 * 生成分流计划。纯函数：不改入参，同一输入永远同一计划
 * （判分闸门必须可复现，计划抖动会让"这次本地比对了、下次走 AI"
 * 这种成本与结果漂移无从查起）。
 */
export function planGrading(
  submission: StudentSubmission,
  questions: readonly PaperQuestion[],
): GradePlan {
  const warnings: string[] = [];
  const byId = new Map(submission.answers.map((a) => [a.questionId, a.text]));

  const items = questions.map((q, i): GradePlanItem => {
    const index = i + 1;
    const studentText = byId.get(q.questionId) ?? null;

    if (studentText === null) {
      return {
        questionId: q.questionId,
        index,
        type: q.type,
        fullScore: q.fullScore,
        method: 'ungradeable',
        studentText: null,
        reason: '答卷未识别出该题答案（缺答案 ≠ 0 分，将强制复核）',
      };
    }

    if (OBJECTIVE_TYPES.has(q.type)) {
      const ref = (q.referenceAnswer ?? '').trim();
      if (!ref) {
        return {
          questionId: q.questionId,
          index,
          type: q.type,
          fullScore: q.fullScore,
          method: 'ungradeable',
          studentText,
          reason: '未提供参考答案，无法本地比对（客观题不交给模型猜）',
        };
      }
      return {
        questionId: q.questionId,
        index,
        type: q.type,
        fullScore: q.fullScore,
        method: 'objective',
        studentText,
        reason: '本地归一化比对，零 token',
      };
    }

    // 主观题走 AI。没有得分点也能评，但依据不足 —— 必须提醒
    const points = q.scoringPoints ?? [];
    if (points.length === 0) {
      warnings.push(`第 ${index} 题（${q.questionId}）未提供评分要点，AI 评分依据不足，结果请重点核对`);
    }
    return {
      questionId: q.questionId,
      index,
      type: q.type,
      fullScore: q.fullScore,
      method: 'ai',
      studentText,
      reason: '主观题，由 AI 按评分要点评分',
    };
  });

  return { items, warnings };
}

/** 组装整份 StudentResult（纯）。`now` 由调用方传入以保证可测。 */
export function gradeSubmissionPure(
  submission: StudentSubmission,
  questions: readonly PaperQuestion[],
  aiResults: ReadonlyMap<string, GradeResult>,
  now: number,
): GradeOutcomePure {
  const plan = planGrading(submission, questions);
  const details: GradingDetail[] = [];
  const warnings: string[] = [];
  const missingAi: string[] = [];
  const reviewCount: string[] = [];

  for (const item of plan.items) {
    const base = {
      questionId: item.questionId,
      index: item.index,
      type: item.type,
      fullScore: item.fullScore,
    };

    if (item.method === 'objective') {
      const q = questions[item.index - 1]!;
      const cmp: ObjectiveResult = compareObjective(item.studentText ?? '', q.referenceAnswer ?? '');
      const f = toDetailFields(cmp);
      details.push({
        ...base,
        score: f.score * item.fullScore,
        comment: f.comment,
        hitPoints: f.hitPoints,
        missedPoints: f.missedPoints,
        local: true,
        confidence: f.confidence,
        reviewRequested: f.reviewRequested,
      });
      if (f.reviewRequested) reviewCount.push(item.questionId);
      continue;
    }

    if (item.method === 'ungradeable') {
      // 缺答案 / 缺参考答案：0 分 + 强制复核 + comment 说明。绝不编造得分点。
      details.push({
        ...base,
        score: 0,
        comment: item.reason,
        hitPoints: [],
        missedPoints: [],
        local: true,
        confidence: 0,
        reviewRequested: true,
      });
      reviewCount.push(item.questionId);
      continue;
    }

    // ai
    const grade = aiResults.get(item.questionId);
    if (!grade) {
      missingAi.push(item.questionId);
      details.push({
        ...base,
        score: 0,
        comment: 'AI 评分未返回（调用失败或尚未执行），请人工评分后改分',
        hitPoints: [],
        missedPoints: [],
        local: false,
        confidence: 0,
        reviewRequested: true,
      });
      reviewCount.push(item.questionId);
      continue;
    }

    // ⚠ ungradable 的 AI 结果（图质量不合格等）：score 0 但**不是真 0 分**
    if (grade.ungradable) {
      details.push({
        ...base,
        score: 0,
        comment: `AI 无法评分：${grade.warnings[0] ?? '未给出原因'}。请人工评分。`,
        hitPoints: [],
        missedPoints: [],
        local: false,
        confidence: 0,
        reviewRequested: true,
      });
      reviewCount.push(item.questionId);
      continue;
    }

    details.push({
      ...base,
      score: grade.score,
      comment: grade.comment,
      hitPoints: grade.hitPoints,
      missedPoints: grade.missedPoints,
      local: false,
      confidence: grade.confidence,
      reviewRequested: grade.reviewRequested,
    });
    if (grade.reviewRequested) reviewCount.push(item.questionId);
  }

  if (missingAi.length > 0) {
    warnings.push(`${missingAi.length} 题未拿到 AI 评分结果（${missingAi.join('、')}），已按"未评分"计入并强制复核`);
  }
  if (reviewCount.length > 0) {
    warnings.push(`${reviewCount.length} 题需要人工复核（得分可能变动，汇总前请先处理）`);
  }

  const total = details.reduce((s, d) => s + d.score, 0);
  const fullTotal = details.reduce((s, d) => s + d.fullScore, 0);

  return {
    result: {
      submissionId: submission.id,
      name: submission.name,
      examNo: submission.examNo,
      details,
      total,
      fullTotal,
      comment: reviewCount.length > 0 ? `${reviewCount.length} 题需人工复核` : '',
      gradedAt: now,
    },
    missingAi,
    warnings,
  };
}

/**
 * 把判分结果转成一行「姓名,考号,分,分,…」，直接可粘进上方录入区。
 *
 * 哪些格子留空（= 未录入口径，parseScoresText 会标复核）：
 * confidence === 0 的题（缺答案 / AI 未返回 / AI 无法评分）——
 * 它们的 0 分**不是确认过的 0 分**，填 0 会把"没评上"伪装成"真零分"。
 * AI 真实给出的 0 分（confidence > 0）照填。
 */
export function buildScoreLine(
  result: StudentResult,
  questions: readonly PaperQuestion[],
): string {
  const detailById = new Map(result.details.map((d) => [d.questionId, d]));
  const cells = questions.map((q) => {
    const d = detailById.get(q.questionId);
    if (!d || d.confidence === 0) return '';
    return String(d.score);
  });
  return [escapeCsvCell(result.name), escapeCsvCell(result.examNo), ...cells].join(',');
}

/** CSV 单元格转义（与 answer-import 同口径；姓名含逗号时不转义会切错列） */
function escapeCsvCell(s: string): string {
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}