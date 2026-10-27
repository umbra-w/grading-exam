/**
 * 学情分析与教学建议生成（SPEC F4.1）。
 *
 * 分布直方图与失分点聚合已由 `main/io/paper.ts` 算好（`PaperStats`）。
 * 本模块负责**解读** —— 把数字翻成"哪里值得讲评"。
 *
 * ── 三条纪律，每条都对应一类真实伤害 ────────────────────────────
 *
 * 1. **每条建议都必须能追溯到具体数据点**。`evidence` 字段强制含数字。
 *    一个编造的"建议多练习"不只是无用：它会让老师以为软件看出了什么，
 *    把注意力挪到不存在的问题上（与 §6.4「界面在说谎」同类）。
 *
 * 2. **数据不可信时先修数据，不再往下解读**。总分超出满分说明汇总本身
 *    有问题，此时再推荐"某题型是薄弱环节"就是把老师引向虚假结论 ——
 *    比什么都不说更糟。所以 `data_unreliable` 一旦成立，就**不再产出**
 *    依赖数据的建议。
 *
 * 3. **样本太少不下结论**。3 份卷子的得分率不构成"这个题型薄弱"的依据。
 *    边界明确设为 5：`< 5` 判不足，`= 5` 可下结论（有测试钉住）。
 *
 * 另外：本模块**绝不**产出"总体准确率"。客观题是确定性比对、
 * 主观题是统计一致性，SPEC §1.1 规定永远不合并成一个数字。
 */

import type { PaperStats, QuestionType, StratifiedStat } from '@shared/types';

/** 样本量下限：低于它就不下教学结论 */
export const MIN_SAMPLE_FOR_CONCLUSION = 5;

/** 得分率低于它算薄弱 */
export const WEAK_TYPE_RATE = 0.7;

/** 某失分点覆盖多少比例的学生才值得专题讲评 */
export const TOP_LOSS_SHARE = 0.3;

/** 两端（<60% 与 >=80%）各占多少才算两极分化 */
export const POLARIZED_EDGE_SHARE = 0.25;

/** 中段（70~89%）占多少才算"成绩集中" */
export const CONCENTRATED_MID_SHARE = 0.55;

/** 及格率低于它要单独提示 */
export const LOW_PASS_RATE = 0.6;

/** 复核率高于它说明分数还没确认，应先处理 */
export const HIGH_REVIEW_RATE = 0.3;

export type AdviceCode =
  | 'no_data'
  | 'data_unreliable'
  | 'insufficient_sample'
  | 'high_review_rate'
  | 'weak_type'
  | 'low_pass_rate'
  | 'top_loss'
  | 'polarized'
  | 'concentrated'
  | 'overall_solid';

export type AdviceSeverity = 'high' | 'medium' | 'low';

export interface TeachingAdvice {
  code: AdviceCode;
  severity: AdviceSeverity;
  title: string;
  detail: string;
  /** ★ 具体数据依据，强制含数字。没有依据的"建议"不许出现 */
  evidence: string;
}

const TYPE_CN: Record<QuestionType, string> = {
  choice: '选择',
  judge: '判断',
  fill: '填空',
  short: '简答',
  calc: '计算',
  essay: '论述',
};

export function typeLabel(t: QuestionType): string {
  return TYPE_CN[t] ?? String(t);
}

/** 把比例渲染成百分比字符串（保留 1 位，够读且不虚假精确） */
function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

/**
 * 描述统计里的数据问题。`buildTeachingAdvice` 与导出层共用同一套判断 ——
 * 两处各写一套的话，某天它们会对同一份数据给出不同结论。
 */
export function describeStatsProblems(st: PaperStats): string[] {
  const out: string[] = [];
  if (st.count === 0) out.push('还没有任何答卷。');
  if (!st.numberValid) {
    out.push('存在总分超出 [0, 满分] 的答卷，汇总数字不可信。');
  }
  if (st.mixedFullScore) {
    out.push(`本次答卷的满分不一致，统计以满分 ${st.fullTotal} 为基准。`);
  }
  return out;
}

/** 按题型里最薄弱的那个（得分率最低且低于阈值） */
function weakestType(byType: StratifiedStat[]): StratifiedStat | null {
  const usable = byType.filter(
    (t) => t.avgScoreRate !== null && Number.isFinite(t.avgScoreRate) && t.count > 0,
  );
  if (usable.length === 0) return null;
  const worst = usable.reduce((a, b) => (b.avgScoreRate! < a.avgScoreRate! ? b : a));
  return worst.avgScoreRate! < WEAK_TYPE_RATE ? worst : null;
}

const SEV_ORDER: Record<AdviceSeverity, number> = { high: 0, medium: 1, low: 2 };

/**
 * 生成教学建议。
 *
 * 返回按严重度排序的建议列表。**空列表不是失败** —— 它是"没有值得特别
 * 提出的问题"这个真实结论（此时会有一条 `overall_solid` 明说）。
 */
export function buildTeachingAdvice(st: PaperStats): TeachingAdvice[] {
  const out: TeachingAdvice[] = [];

  // ── 0. 没有数据：到此为止，绝不往下推断
  if (st.count === 0) {
    return [
      {
        code: 'no_data',
        severity: 'high',
        title: '还没有可用于分析的答卷',
        detail:
          '先在「整卷阅卷」里定义题目并录入成绩，汇总之后这里就会有分析。' +
          '在此之前任何关于学情的结论都是凭空编造的。',
        evidence: `答卷数 0，满分基准 ${st.fullTotal || 0}`,
      },
    ];
  }

  // ── 1. 数据可信度：一旦有问题，后面不再解读
  const dataProblems = describeStatsProblems(st);
  if (dataProblems.length > 0) {
    out.push({
      code: 'data_unreliable',
      severity: 'high',
      title: '先修数据，再看学情',
      detail: `${dataProblems.join('')} 在这些问题解决之前，本页不给出"哪个题型薄弱"这类结论 —— 基于错误数字推荐教学重点，比不给建议更糟。`,
      evidence: `答卷数 ${st.count}，满分基准 ${st.fullTotal}${st.mixedFullScore ? '（满分不一致）' : ''}`,
    });
    return out.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  }

  // ── 2. 样本量
  if (st.count < MIN_SAMPLE_FOR_CONCLUSION) {
    out.push({
      code: 'insufficient_sample',
      severity: 'medium',
      title: '样本量不足，暂不下教学结论',
      detail: `少于 ${MIN_SAMPLE_FOR_CONCLUSION} 份答卷时，得分率的随机波动远大于真实的班级差异。可以继续录入后回来看。`,
      evidence: `答卷数 ${st.count}（下限 ${MIN_SAMPLE_FOR_CONCLUSION}）`,
    });
    return out.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  }

  // ── 3. 复核率：分数还没确认时先说这件事
  const highReview = st.byType.filter((t) => t.reviewRate >= HIGH_REVIEW_RATE);
  if (highReview.length > 0) {
    const names = highReview.map((t) => typeLabel(t.type)).join('、');
    const maxRate = Math.max(...highReview.map((t) => t.reviewRate));
    out.push({
      code: 'high_review_rate',
      severity: 'high',
      title: '部分分数尚未经人工确认',
      detail: `${names} 的复核率偏高。这些分数在确认之前只是模型输出，把它们当作定论去安排讲评，风险在于错的地方可能根本没错。请先在「复核队列」里过一遍。`,
      evidence: `最高复核率 ${pct(maxRate)}（阈值 ${pct(HIGH_REVIEW_RATE)}）`,
    });
  }

  // ── 4. 薄弱题型（分层，不合并）
  const weak = weakestType(st.byType);
  if (weak) {
    out.push({
      code: 'weak_type',
      severity: 'medium',
      title: `${typeLabel(weak.type)}题是需要优先讲评的题型`,
      detail:
        `该题型的平均得分率在各题型中最低。注意这是**按题型分层**看的结果，` +
        `不与客观题合并成一个总体准确率 —— 两类题的判定方式本就不同。`,
      evidence: `${typeLabel(weak.type)}平均得分率 ${pct(weak.avgScoreRate!)}，共 ${weak.count} 个题次`,
    });
  }

  // ── 5. 高频失分点
  const top = st.lossRanking[0];
  if (top && st.count > 0) {
    const share = top.count / st.count;
    out.push({
      code: 'top_loss',
      severity: share >= TOP_LOSS_SHARE ? 'medium' : 'low',
      title: '最高频失分点',
      detail:
        share >= TOP_LOSS_SHARE
          ? `「${top.point}」出现在超过三成学生的答卷上，属于共性问题，适合做一次专题讲评。`
          : `「${top.point}」是当前占比最高的失分点，但覆盖比例不算高，可结合课堂情况决定是否专门讲。`,
      evidence: `「${top.point}」${top.count} 次，占 ${st.count} 份答卷的 ${pct(share)}`,
    });
  }

  // ── 6. 分布形态
  const dist = st.distribution.filter((b) => b.count > 0 || true);
  if (dist.length > 0) {
    const total = dist.reduce((a, b) => a + b.count, 0);
    if (total > 0) {
      const lowEdge = dist
        .filter((b) => b.bucket.startsWith('0~'))
        .reduce((a, b) => a + b.count, 0);
      const highEdge = dist
        .filter((b) => b.bucket.startsWith('80~') || b.bucket.startsWith('90~'))
        .reduce((a, b) => a + b.count, 0);
      const mid = dist
        .filter((b) => b.bucket.startsWith('70~') || b.bucket.startsWith('80~'))
        .reduce((a, b) => a + b.count, 0);

      const lowShare = lowEdge / total;
      const highShare = highEdge / total;
      const midShare = mid / total;

      if (lowShare >= POLARIZED_EDGE_SHARE && highShare >= POLARIZED_EDGE_SHARE) {
        out.push({
          code: 'polarized',
          severity: 'medium',
          title: '成绩两极分化',
          detail:
            '低分段和高分段都占了相当比例，整体平均分掩盖了班内差异。' +
            '这种情况下统一进度的讲评效果有限，分层任务或同伴互助通常更合适。',
          evidence: `低于 60% 的占 ${pct(lowShare)}，80% 以上的占 ${pct(highShare)}`,
        });
      } else if (midShare >= CONCENTRATED_MID_SHARE) {
        out.push({
          code: 'concentrated',
          severity: 'low',
          title: '成绩集中在中等区间',
          detail:
            '多数学生落在 70~89% 区间，说明基础掌握较一致。这类分布下提分的空间通常在中档题的规范性与细节上。',
          evidence: `70~89% 区间占 ${pct(midShare)}（阈值 ${pct(CONCENTRATED_MID_SHARE)}）`,
        });
      }
    }
  }

  // ── 7. 及格率
  if (st.passRate !== null && st.passRate < LOW_PASS_RATE) {
    out.push({
      code: 'low_pass_rate',
      severity: 'medium',
      title: '及格率偏低',
      detail:
        '及格线按**归一化得分率** 60% 判定，因此与本次满分制无关，不同卷子之间可比。偏低通常指向基础概念而非难题。',
      evidence: `及格率 ${pct(st.passRate)}（阈值 ${pct(LOW_PASS_RATE)}）`,
    });
  }

  // ── 8. 没有任何值得特别提出的问题：如实说明，而不是硬凑建议
  if (out.length === 0) {
    out.push({
      code: 'overall_solid',
      severity: 'low',
      title: '未发现需要特别干预的问题',
      detail:
        '各题型的得分率都在合理区间、不及格人数很少、也没有突出的共性失分点。' +
        '这不是"分析失败"，而是本次数据确实没有指向特定薄弱环节。',
      evidence: `答卷数 ${st.count}，及格率 ${st.passRate === null ? '—' : pct(st.passRate)}，平均分 ${st.average === null ? '—' : st.average.toFixed(2)}`,
    });
  }

  return out.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
}

/** 一行式概况。**刻意不含"准确率"**（SPEC §1.1） */
export function adviceSummary(st: PaperStats): string {
  const parts: string[] = [`${st.count} 份答卷`];
  parts.push(`平均分 ${st.average === null ? '—' : st.average.toFixed(2)}`);
  parts.push(`及格率 ${st.passRate === null ? '—' : pct(st.passRate)}`);
  parts.push(`题次数 ${st.byType.reduce((a, t) => a + t.count, 0)}`);
  return parts.join(' · ');
}