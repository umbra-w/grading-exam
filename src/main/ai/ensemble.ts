/**
 * 多次运行分歧度 —— 解决"低置信度"的核心机制。
 *
 * 为什么需要它（这是本模块存在的全部理由）：
 *   让模型自评 confidence 是**弱信号**——模型普遍过度自信，且常机械地
 *   吐一个固定值。领域里对 LLM 置信度估计有专门的综述，说明这是开放问题，
 *   不是调参问题：https://arxiv.org/abs/2311.08298
 *
 *   自一致性（self-consistency）是**真实信号**：同一输入独立跑多次，
 *   结果散不散是模型自身不确定性的可观测表现。文献支撑见
 *   "Towards Reliable LLM Grading Through Self-Consistency and
 *    Selective Human Review: Higher Accuracy, Less Work"
 *
 * 本文件只做**统计与判定**，全部是纯函数；
 * 网络调用与重试在 client.ts（gradeQuestionMulti）。
 * 理由：统计错了会误判"稳定"，比网络出错危险得多——网络错会报错，
 * 统计错会静默地把不可靠的分数当成可靠。
 *
 * 一个关键区分（很容易搞错）：
 *   **一致 ≠ 正确。** 多次都给同一个错分，是最危险的情况——
 *   它不是噪声，是系统性盲区各有专门标记（contradictions / systematic）。
 */

import type { EnsembleSummary, GradeResult } from '../../shared/types';

/* ------------------------------------------------------------ 类型 */

export interface EnsembleOptions {
  /** 运行次数，默认 3（奇数便于取中位数；2 次的成本省不了多少却难定分歧） */
  runs?: number;
  /** 每次运行的采样温度；< 1 次则循环使用 */
  temperatures?: number[];
  /**
   * 分歧度阈值：超过则判为不可信，强制复核。
   * 0.5 的含义：多次结果的标准差超过 0.5 分（对 10 分制而言相当宽松）。
   */
  disagreementThreshold?: number;
}

export interface ScoreDistribution {
  scores: number[];
  n: number;
  mean: number;
  median: number;
  min: number;
  max: number;
  /** 极差 = max − min */
  range: number;
  /** 总体标准差 */
  stdDev: number;
  /** 平均绝对偏差（对中位数） */
  mad: number;
  /** 最常见值的占比（1.0 = 全部一致） */
  modeShare: number;
}

export const DEFAULT_ENSEMBLE: Required<EnsembleOptions> = {
  runs: 3,
  temperatures: [0, 0.7, 1.0],
  disagreementThreshold: 0.5,
};

/* -------------------------------------------------------- 统计 */

/** 中位数（偶数个时取中间两个的平均） */
export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

/** 总体标准差 */
export function stdDev(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

/** 平均绝对偏差（相对给定中心） */
export function meanAbsDeviation(xs: number[], center: number): number {
  if (xs.length === 0) return NaN;
  return xs.reduce((a, b) => a + Math.abs(b - center), 0) / xs.length;
}

/** 最常见值的占比。全一致时为 1 */
export function modeShare(xs: number[]): number {
  if (xs.length === 0) return 0;
  const counts = new Map<number, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best = 0;
  for (const c of counts.values()) best = Math.max(best, c);
  return best / xs.length;
}

/** 汇总一组分数为分布统计 */
export function summarizeScores(scores: number[]): ScoreDistribution {
  const clean = scores.filter((s) => Number.isFinite(s));
  if (clean.length === 0) {
    return {
      scores: [], n: 0, mean: NaN, median: NaN, min: NaN, max: NaN,
      range: NaN, stdDev: NaN, mad: NaN, modeShare: 0,
    };
  }
  const med = median(clean);
  return {
    scores: [...clean],
    n: clean.length,
    mean: clean.reduce((a, b) => a + b, 0) / clean.length,
    median: med,
    min: Math.min(...clean),
    max: Math.max(...clean),
    range: Math.max(...clean) - Math.min(...clean),
    stdDev: stdDev(clean),
    mad: meanAbsDeviation(clean, med),
    modeShare: modeShare(clean),
  };
}

/**
 * 分歧度 0~1 —— **归一化**后才可跨题比较。
 *
 * 为什么必须归一化：满分 10 分与满分 100 分的题，同样的标准差含义完全不同。
 * 直接用原始标准差会让高分值题一概被判为"不稳定"。
 *
 * 组合两种互补的信号：
 *  - `mad / fullScore`：分数散得有多开
 *  - `1 − modeShare`：有多少次没达成一致（对"两个值各占一半"更敏感）
 * 各占一半权重：单独用任一都会有盲区。
 */
export function disagreementOf(scores: number[], fullScore: number): number {
  const d = summarizeScores(scores);
  if (d.n === 0) return 1; // 完全没拿到分数 → 视为最大分歧（保守）
  if (d.n === 1) return 0; // 单次运行无法判断分歧（由调用方另加约束）

  const denom = fullScore > 0 ? fullScore : 1;
  const spread = Math.min(1, d.mad / (denom * 0.25)); // 差满 25% 满分即视为最大分散
  const unagreed = 1 - d.modeShare;

  return Math.max(0, Math.min(1, spread * 0.5 + unagreed * 0.5));
}

/* -------------------------------------------------------- 判定 */

export type Agreement = 'consistent' | 'minor' | 'major' | 'contradictory' | 'insufficient';

export interface EnsembleVerdict {
  agreement: Agreement;
  /** 归一化分歧度 0~1 */
  disagreement: number;
  /** 建议采用的分数（中位数——比均值更抗单个离群值） */
  suggestedScore: number;
  distribution: ScoreDistribution;
  /**
   * 是否必须人工复核。
   * 注意：**永远不能因为"AI 很自信"就取消复核**，只能因为"多次一致"而放宽。
   */
  requiresReview: boolean;
  /** 是否可进入自动提交候选（仍需满足自动提交的四个硬条件） */
  autoSubmitCandidate: boolean;
  /** 面向人的说明，直接写进日志或复核队列 */
  rationale: string;
  warnings: string[];
}

/**
 * 判定多次运行的一致性，并给出处置建议。
 *
 * 判定次序刻意如此（从确定到不确定）：
 *   1. 运行不足 → 明确说"无法判断"，不假装有结论
 *   2. 最低次数的模型自评置信度 → 取**最小值**而非平均
 *   3. 分歧度 → 决定是否复核
 *   4. 一致但全部很低 → 仍要复核（高分歧 + 低置信）
 */
export function judgeEnsemble(
  results: GradeResult[],
  fullScore: number,
  opts: EnsembleOptions = {},
): EnsembleVerdict {
  const cfg = { ...DEFAULT_ENSEMBLE, ...opts };
  const warnings: string[] = [];
  const valid = results.filter((r) => Number.isFinite(r.score));

  const scores = valid.map((r) => r.score);
  const dist = summarizeScores(scores);

  if (valid.length < 2) {
    // 只有一次运行：分歧无从谈起。**不能因此判定"一致"**——
    // 那会把"没测过"当成"测过且通过"，是典型的安全误判。
    return {
      agreement: 'insufficient',
      disagreement: NaN,
      suggestedScore: dist.n > 0 ? dist.median : NaN,
      distribution: dist,
      requiresReview: true,
      autoSubmitCandidate: false,
      rationale:
        `仅取得 ${valid.length} 次有效评分，无法判断一致性。` +
        `按保守原则需人工复核（"没测过"不等于"测过且通过"）。`,
      warnings: warnings.length ? warnings : ['运行次数不足，未做一致性判定'],
    };
  }

  const disagreement = disagreementOf(scores, fullScore);

  // 取**最小**自评置信度：多次运行里最悲观的那次最有信息量。
  // 用平均值会让一次自信的回答掩盖一次心虚的回答。
  const minConf = Math.min(...valid.map((r) => (Number.isFinite(r.confidence) ? r.confidence : 0)));

  let agreement: Agreement;
  if (dist.range === 0) {
    agreement = 'consistent';
  } else {
    // 用**归一化极差**判定，不能用绝对分差：
    // 早先用 `range <= 1.0` 判定"接近"，结果 100 分制题上 60 与 62 的差
    // 被当成 major 分歧——明明只差 2%。满分不同的题必须可比。
    const normalizedRange = dist.range / (fullScore > 0 ? fullScore : 1);
    if (normalizedRange <= 0.1) agreement = 'minor';
    else if (disagreement < cfg.disagreementThreshold) agreement = 'major';
    else agreement = 'contradictory';
  }

  if (dist.range === 0 && minConf < 0.5) {
    warnings.push(
      `多次结果完全一致（均为 ${dist.median}）但模型自评置信度仅 ${minConf.toFixed(2)}。` +
        `一致 ≠ 正确：多次给出同一个错分比随机波动更危险，应重点抽查。`,
    );
  }
  if (valid.length < cfg.runs) {
    warnings.push(`实际有效运行 ${valid.length} 次，少于配置的 ${cfg.runs} 次。`);
  }
  if (results.some((r) => r.warnings?.length)) {
    warnings.push('部分运行带清洗警告，建议查看原始输出。');
  }

  const requiresReview =
    agreement === 'contradictory' || agreement === 'major' || minConf < 0.75;

  const autoSubmitCandidate =
    agreement === 'consistent' && minConf >= 0.85 && !requiresReview;

  const rationale = (() => {
    switch (agreement) {
      case 'consistent':
        return minConf >= 0.85
          ? `${valid.length} 次运行结果完全一致（${dist.median}），可进入自动提交候选。`
          : `${valid.length} 次运行结果一致（${dist.median}），但自评置信度偏低（${minConf.toFixed(2)}），仍需复核。`;
      case 'minor':
        return `多次结果接近（极差 ${dist.range} 分，中位数 ${dist.median}），差异在可接受范围。`;
      case 'major':
        return `多次结果有明显分歧（极差 ${dist.range} 分，分歧度 ${disagreement.toFixed(2)}），需人工复核。`;
      default:
        return `多次结果严重矛盾（${scores.join(' / ')}），模型自身不确定，必须人工判定。`;
    }
  })();

  return {
    agreement,
    disagreement,
    suggestedScore: dist.median,
    distribution: dist,
    requiresReview,
    autoSubmitCandidate,
    rationale,
    warnings,
  };
}

/** 从多次运行结果导出可进日志/界面的汇总（与 types.ts 的 EnsembleSummary 对应） */
export function summarizeEnsemble(results: GradeResult[], verdict: EnsembleVerdict): EnsembleSummary {
  return {
    runs: verdict.distribution.n,
    scores: verdict.distribution.scores,
    disagreement: verdict.disagreement,
    agreement: verdict.agreement,
    commonMisses: commonMisses(results),
    contradictoryPoints: contradictoryPoints(results),
  };
}

/**
 * 找出各次评分**共同未命中**的得分点。
 *
 * 这是本模块最有价值的输出之一：共同盲区不是随机噪声，
 * 而是提示词或 rubric 的系统性缺陷——单跑一次永远发现不了。
 */
export function commonMisses(results: GradeResult[]): string[] {
  const valid = results.filter((r) => Array.isArray(r.missedPoints));
  if (valid.length < 2) return [];

  const counts = new Map<string, number>();
  for (const r of valid) {
    for (const p of new Set(r.missedPoints)) {
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
  }

  // 全部运行都判为"未命中" → 共同盲区
  return [...counts.entries()]
    .filter(([, c]) => c === valid.length)
    .map(([p]) => p);
}

/** 找出各次评分**互相矛盾**的得分点（有的命中、有的未命中） */
export function contradictoryPoints(results: GradeResult[]): string[] {
  const valid = results.filter((r) => Array.isArray(r.hitPoints) || Array.isArray(r.missedPoints));
  if (valid.length < 2) return [];

  const hit = new Map<string, number>();
  const miss = new Map<string, number>();
  for (const r of valid) {
    for (const p of new Set(r.hitPoints ?? [])) hit.set(p, (hit.get(p) ?? 0) + 1);
    for (const p of new Set(r.missedPoints ?? [])) miss.set(p, (miss.get(p) ?? 0) + 1);
  }

  const all = new Set([...hit.keys(), ...miss.keys()]);
  const out: string[] = [];
  for (const p of all) {
    const h = hit.get(p) ?? 0;
    const m = miss.get(p) ?? 0;
    if (h > 0 && m > 0) out.push(p);
  }
  return out;
}

/** 选择每次运行的采样温度；不足时循环取用 */
export function temperatureForRun(index: number, temps: number[]): number {
  if (temps.length === 0) return 0.7;
  return temps[index % temps.length]!;
}

/**
 * 合并多次运行的结果为单条 `GradeResult`（供下游沿用既有管线）。
 * 评语取分歧最小的那次——避免把互相矛盾的评语缝合在一起。
 */
export function mergeEnsemble(results: GradeResult[], verdict: EnsembleVerdict): GradeResult {
  const valid = results.filter((r) => Number.isFinite(r.score));
  if (valid.length === 0) throw new Error('mergeEnsemble: 无有效结果可合并');

  const target = verdict.suggestedScore;
  const closest = valid.reduce((best, r) =>
    Math.abs(r.score - target) < Math.abs(best.score - target) ? r : best,
  );

  return {
    ...closest,
    score: target,
    confidence: Math.min(...valid.map((r) => (Number.isFinite(r.confidence) ? r.confidence : 0))),
    reviewRequested: verdict.requiresReview,
    warnings: [...(closest.warnings ?? []), ...verdict.warnings],
    ensemble: summarizeEnsemble(results, verdict),
  };
}