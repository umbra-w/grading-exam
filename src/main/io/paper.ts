/**
 * 整卷聚合 —— 把逐题批改结果汇总成 `PaperReport`。
 *
 * 为什么单独成模块：`io/export.ts` **消费** `PaperReport`（生成 Excel/Markdown），
 * 但从没有人**生产** `stats`。导出通道早就通了，却没有任何东西能填满它，
 * 而这是**不会报错**的缺失——导出会正常生成一份所有统计都是占位的文件。
 *
 * 本模块是纯函数（不碰 fs、不联网），因此能被 vitest 完整覆盖。
 *
 * ── 三条贯穿全模块的口径，每条都对应一类静默失败 ────────────────
 *
 * 1. **「没有数据」≠「0」**。空集合的 average/max/min/passRate 一律返回
 *    `null`。返回 0 会让一份还没导入答卷的班级显示"平均分 0、及格率 0%"，
 *    看起来像一个真实且灾难性的结果。
 *
 * 2. **一切比例按归一化得分率算，不按绝对分**（§6.2）。按绝对分 60 判及格，
 *    一份 10 分制的卷子永远不可能及格，及格率恒为 0%，而看起来完全正常。
 *
 * 3. **数据有问题时不"修正"，而是暴露**。总分超过满分时不去裁剪它 ——
 *    裁剪等于替教师决定，还会掩盖缺陷。只把 `numberValid` 置 false，
 *    让界面加警告。
 */

import type {
  GradingDetail,
  PaperReport,
  PaperStats,
  QuestionType,
  StratifiedStat,
  StudentResult,
} from '@shared/types';

/** 及格线（归一化得分率）。0.6 是通行口径，且与满分制无关 */
export const PASS_RATE = 0.6;

/** 分箱边界（归一化得分率百分比的下界） */
export const BUCKET_EDGES = [0, 60, 70, 80, 90] as const;

/** 汇总所需的最小输入：只要有总分与满分就能算 */
export interface ScorePair {
  total: number;
  fullTotal: number;
}

/** 一个题目的元信息（当前只用到题型；保留 fullScore 供调用方对齐） */
export interface QuestionMeta {
  questionId: string;
  type: QuestionType;
  fullScore: number;
}

export interface AggregateInput {
  paperId: string;
  paperTitle: string;
  results: StudentResult[];
  questionsMeta?: QuestionMeta[];
  /** 注入时间源，便于测试（默认 Date.now） */
  now?: () => number;
}

/* ══════════════════════════════════════════════════ 分数汇总 */

/**
 * 汇总总分统计。
 *
 * 空集合返回 `null` —— 见文件头口径 1。
 */
export function summarizeScores(pairs: ScorePair[]): Omit<PaperStats, 'distribution' | 'lossRanking' | 'byType'> | null {
  if (pairs.length === 0) return null;

  const totals = pairs.map((p) => p.total);
  const sum = totals.reduce((a, b) => a + b, 0);

  // ── 满分基准：取人数最多的那个（并列取较大的）
  const freq = new Map<number, number>();
  for (const p of pairs) freq.set(p.fullTotal, (freq.get(p.fullTotal) ?? 0) + 1);
  let fullTotal = 0;
  let bestCount = -1;
  for (const [ft, c] of freq) {
    // 并列时取较大：取值本身不重要，重要的是**确定且可解释**
    if (c > bestCount || (c === bestCount && ft > fullTotal)) {
      fullTotal = ft;
      bestCount = c;
    }
  }
  const mixedFullScore = freq.size > 1;

  // ── 及格率：按归一化得分率，满分非正数的样本不计入分母
  let passDenom = 0;
  let passNum = 0;
  for (const p of pairs) {
    if (!(p.fullTotal > 0)) continue;
    passDenom++;
    if (p.total / p.fullTotal >= PASS_RATE) passNum++;
  }

  // ── 数值有效性：总分必须在 [0, 满分] 内，且满分 > 0
  const numberValid = pairs.every((p) => p.fullTotal > 0 && p.total >= 0 && p.total <= p.fullTotal);

  return {
    count: pairs.length,
    average: Number((sum / pairs.length).toFixed(2)),
    max: Math.max(...totals),
    min: Math.min(...totals),
    passRate: passDenom > 0 ? Number((passNum / passDenom).toFixed(4)) : null,
    fullTotal,
    mixedFullScore,
    numberValid,
  };
}

/* ══════════════════════════════════════════════════ 分箱直方图 */

/** 一个得分率落在哪一箱（返回 BUCKET_EDGES 里的下界） */
export function bucketOf(rate: number): number {
  // 从高往低找第一个不超过 rate 的下界；100% 归入最高箱
  for (let i = BUCKET_EDGES.length - 1; i >= 0; i--) {
    if (rate * 100 >= BUCKET_EDGES[i]!) return BUCKET_EDGES[i]!;
  }
  return BUCKET_EDGES[0]!;
}

/**
 * 生成分数分布直方图。
 *
 * 按**归一化得分率**分箱（口径 2），空箱保留 ——
 * 省略空箱会让"全班都考 80 分"和"分布在 60/70/80/90"看起来一样。
 */
export function buildDistribution(pairs: ScorePair[]): Array<{ bucket: string; count: number }> {
  const usable = pairs.filter((p) => p.fullTotal > 0);
  if (usable.length === 0) return [];

  const counts = new Map<number, number>();
  for (const e of BUCKET_EDGES) counts.set(e, 0);
  for (const p of usable) {
    const b = bucketOf(p.total / p.fullTotal);
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }

  return BUCKET_EDGES.map((lo, i) => {
    const hi = BUCKET_EDGES[i + 1];
    const bucket = hi === undefined ? `${lo}~100%` : `${lo}~${hi - 1}%`;
    return { bucket, count: counts.get(lo) ?? 0 };
  });
}

/* ══════════════════════════════════════════════════ 失分点聚合 */

/**
 * 聚合高频失分点，按次数降序。
 *
 * 同一次作答里重复的失分点只算一次：否则一道写错三遍"单位"的题
 * 会把这个失分点的权重算成 3，讲评时被错误地提到最前面。
 *
 * `maxCount` 不做默认截断 —— 高频失分点是改提示词/讲评的主要依据，
 * 一个默认"只显示前 10 条"会让第 11 条永远不被看见。
 */
export function buildLossRanking(
  details: Array<Pick<GradingDetail, 'missedPoints'>>,
  maxCount?: number,
): Array<{ point: string; count: number }> {
  const freq = new Map<string, number>();
  for (const d of details) {
    const seen = new Set<string>();
    for (const raw of d.missedPoints ?? []) {
      const point = raw.trim();
      // 空串不是"一个失分点"
      if (point === '' || seen.has(point)) continue;
      seen.add(point);
      freq.set(point, (freq.get(point) ?? 0) + 1);
    }
  }

  const rows = [...freq.entries()].map(([point, count]) => ({ point, count }));
  // 次数降序；次数相同按名称升序 —— 保证导出可重复，不因输入顺序抖动
  rows.sort((a, b) => (b.count - a.count) || a.point.localeCompare(b.point, 'zh-CN'));
  return maxCount === undefined ? rows : rows.slice(0, Math.max(0, maxCount));
}

/* ══════════════════════════════════════════════════ 分层统计 */

/**
 * 按题型分层统计（F3.6）。
 *
 * 只输出**实际出现过**的题型：一份卷子没有判断题，就不该在分层表里
 * 显示"判断：平均得分率 0%"—— 那会让人觉得全班判断题全错，
 * 而实际是根本没这题型。
 *
 * ⚠ 本函数刻意**不**额外产出一个"总体准确率"：SPEC §1.1 规定
 * 客观题（确定性比对）与主观题（统计一致性）**永远不要合并成一个数字**。
 */
export function stratifiedByType(
  details: GradingDetail[],
  _meta?: QuestionMeta[],
): StratifiedStat[] {
  const groups = new Map<QuestionType, GradingDetail[]>();
  for (const d of details) {
    const list = groups.get(d.type);
    if (list) list.push(d);
    else groups.set(d.type, [d]);
  }

  const out: StratifiedStat[] = [];
  for (const [type, rows] of groups) {
    // 满分非正数的样本不进分子也不进分母：避免除零，也避免拉低得分率
    const usable = rows.filter((r) => r.fullScore > 0);
    const rate = usable.length > 0
      ? Number((usable.reduce((a, r) => a + r.score / r.fullScore, 0) / usable.length).toFixed(4))
      : null;
    const reviewNum = rows.filter((r) => r.reviewRequested).length;
    out.push({
      type,
      count: rows.length,
      avgScoreRate: rate,
      reviewRate: Number((reviewNum / rows.length).toFixed(4)),
    });
  }

  // 顺序固定：样本多的在前，再按题型名 —— 保证导出可重复
  out.sort((a, b) => (b.count - a.count) || String(a.type).localeCompare(String(b.type), 'zh-CN'));
  return out;
}

/* ══════════════════════════════════════════════════ 组装 */

/** 把逐题结果汇总成一份完整的 `PaperReport` */
export function aggregatePaper(input: AggregateInput): PaperReport {
  const { paperId, paperTitle, results } = input;
  const now = input.now ?? Date.now;

  const pairs: ScorePair[] = results.map((r) => ({ total: r.total, fullTotal: r.fullTotal }));
  const allDetails = results.flatMap((r) => r.details);

  const base = summarizeScores(pairs);

  const stats: PaperStats = {
    // 无答卷时给出全 null 的骨架，而不是 0 —— 见文件头口径 1
    count: base?.count ?? 0,
    average: base?.average ?? null,
    max: base?.max ?? null,
    min: base?.min ?? null,
    passRate: base?.passRate ?? null,
    fullTotal: base?.fullTotal ?? 0,
    mixedFullScore: base?.mixedFullScore ?? false,
    numberValid: base?.numberValid ?? true,
    distribution: buildDistribution(pairs),
    lossRanking: buildLossRanking(allDetails),
    byType: stratifiedByType(allDetails, input.questionsMeta),
  };

  return { paperId, paperTitle, results, stats, generatedAt: now() };
}