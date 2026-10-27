/**
 * 复核队列与人工修正 —— 纯逻辑（无网络、无 IO、无计时器）。
 *
 * ── 为什么必须有这一层 ──────────────────────────────────────────────────────
 *
 * 在此之前，`main.ts` 的评分日志会写「（已入复核队列）」，而**队列不存在**。
 * 这是本项目最不能接受的一类缺陷：界面/日志声称做了实际没做的事，
 * 用户看到"已入队列"就放心了，于是**一个低置信度的分数直接生效**。
 *
 * 复核队列存在的唯一目的：把"模型自己也不确定的分数"**拦住**，
 * 交给人做一次判断。它不需要聪明，只需要不放过。
 *
 * ── 关于数据形状（踩过一次）────────────────────────────────────────────────
 *
 * 第一版我按"`GradeResult.details: GradingDetail[]`，每项带 `got`"来写修正逻辑。
 * 那是我**手抄错的一份类型副本**——真实的 `GradeResult` 根本没有 `details`，
 * 它给的是 `hitPoints` / `missedPoints` 两个字符串数组（见 `shared/types.ts`）。
 * 手抄副本不会报错，只会静默错（AGENTS.md §7.4）。
 *
 * 所以修正的建模按真实形状来：老师能改的是**某个评分点命中与否**，
 * 以及总分。总分只有在知道各评分点分值时才由程序重算，
 * 否则**不猜**——见 `applyManualCorrection` 里的说明。
 */
import type {
  CorrectionRecord,
  GradeResult,
  ReviewItem,
  ReviewReason,
  ReviewStats,
  ReviewStatus,
} from '../../shared/types';

/*
 * 数据形状定义在 `shared/types.ts`（跨进程契约，唯一真源）。
 * 这里 re-export，调用方从逻辑模块导入即可，不必知道定义在哪 ——
 * 但**绝不在这里再写一份**：手抄副本漂移时不报错（§7.4）。
 */
export type { CorrectionRecord, ReviewItem, ReviewReason, ReviewStats, ReviewStatus };

/* --------------------------------------------------------- 队列操作 */

/**
 * 进队列的判定。
 *
 * ★ 设计原则：**只增不减**。每多一条理由只是让复核更必要；
 *   任何一条理由都不应被另一条"抵消"。用单一分数阈值做判定的教训是：
 *   一条严重的 warnings 会因为置信度恰好 0.77（高于 0.75）而被放过。
 */
export const DEFAULT_REVIEW_CONFIDENCE = 0.75;

export interface ReviewPolicy {
  /** 低于该置信度进队列 */
  confidenceThreshold: number;
  /** 是否把 warnings 非空视为必须复核 */
  reviewOnWarnings: boolean;
  /** 极端分数：置信度低于此值且分数为 0 分/满分时复核 */
  extremeScoreMinConfidence: number;
}

export const DEFAULT_REVIEW_POLICY: ReviewPolicy = {
  confidenceThreshold: DEFAULT_REVIEW_CONFIDENCE,
  reviewOnWarnings: true,
  extremeScoreMinConfidence: 0.9,
};

export interface ReviewSignals {
  /** 多次运行的分歧度；undefined = 未做多次运行 */
  disagreement?: 'none' | 'minor' | 'major' | 'insufficient';
  /** 图片质量差 */
  poorImage?: boolean;
  /** 客观题判定为 suspect */
  objectiveSuspect?: boolean;
}

/**
 * 从评分结果本身推导信号。
 *
 * 为什么需要它：`signals.disagreement` 与 `GradeResult.ensemble.agreement`
 * 是同一个量。若让每个调用点各自映射一次，早晚有一处映射错或漏传，
 * 而漏传的后果是**该复核的没复核**、且不报错。所以映射只留这一处。
 *
 * `poorImage` / `objectiveSuspect` 来自结果之外（图片质检、本地比对），
 * 必须由调用方传入，这里只负责把结果里已有的信息抽出来。
 */
export function signalsFromResult(
  result: GradeResult,
  extra: Omit<ReviewSignals, 'disagreement'> = {},
): ReviewSignals {
  const agreement = result.ensemble?.agreement;
  const disagreement: ReviewSignals['disagreement'] = agreement
    ? // 'contradictory' 是最严重的一种（各次判断互相矛盾），按 major 处置
      agreement === 'contradictory'
      ? 'major'
      : agreement === 'consistent'
        ? 'none'
        : agreement === 'minor'
          ? 'minor'
          : 'insufficient'
    : // 没有 ensemble 信息 = 只跑了一次。**不能**当"一致"处理（§6.3）
      'insufficient';
  return { ...extra, disagreement };
}

/**
 * 判定一份评分结果是否需要人工复核。
 *
 * @returns 理由列表；空表示无需复核。**顺序稳定**，便于测试与展示。
 */
export function reviewReasons(
  result: GradeResult,
  fullScore: number,
  signals: ReviewSignals = {},
  policy: ReviewPolicy = DEFAULT_REVIEW_POLICY,
): ReviewReason[] {
  const reasons: ReviewReason[] = [];

  if (!Number.isFinite(result.confidence) || result.confidence < policy.confidenceThreshold) {
    reasons.push('low_confidence');
  }

  if (policy.reviewOnWarnings && result.warnings.length > 0) {
    reasons.push('output_warnings');
  }

  // 'insufficient' 与 'major' 都要复核：
  //   · insufficient = 只跑了一次，**没测过**不等于**测过且通过**（AGENTS §6.3）
  //   · major = 模型自己都不一致，不能就这么用
  if (signals.disagreement === 'major' || signals.disagreement === 'insufficient') {
    reasons.push('ensemble_disagreement');
  }

  if (signals.poorImage) reasons.push('poor_image');
  if (signals.objectiveSuspect) reasons.push('objective_suspect');

  // 极端分数本身不是问题（确实有人考满分，也确实有人得零分），
  // 但"模型不太确定 + 极端分数"是典型的高代价错误组合。
  const total = Number.isFinite(fullScore) && fullScore > 0 ? fullScore : 0;
  if (total > 0) {
    const ratio = result.score / total;
    const extreme = ratio <= 0 || ratio >= 1;
    const confidentEnough =
      Number.isFinite(result.confidence) && result.confidence >= policy.extremeScoreMinConfidence;
    if (extreme && !confidentEnough) reasons.push('extreme_score');
  }

  // 模型自己要求复核 —— 尊重它，不给"被别的理由抵消"的机会
  if (result.reviewRequested) reasons.push('model_requested');

  return reasons;
}

export function needsReview(
  result: GradeResult,
  fullScore: number,
  signals: ReviewSignals = {},
  policy: ReviewPolicy = DEFAULT_REVIEW_POLICY,
): boolean {
  return reviewReasons(result, fullScore, signals, policy).length > 0;
}

/* --------------------------------------------------------- 队列操作 */

export interface EnqueueOptions {
  paperId: string;
  questionNo: string;
  subject: string;
  fullScore: number;
  signals?: ReviewSignals;
  policy?: ReviewPolicy;
  now?: number;
}

/** 稳定 id：同一份答卷的同一题只应有一条待复核项 */
export function reviewItemId(paperId: string, questionNo: string): string {
  return `${paperId}::${questionNo}`;
}

/**
 * 入队判定 + 建条目。
 *
 * @returns 需要复核时返回新条目；否则 null（调用方据此决定是否打日志）
 */
export function enqueueIfNeeded(result: GradeResult, opts: EnqueueOptions): ReviewItem | null {
  const policy = opts.policy ?? DEFAULT_REVIEW_POLICY;
  const reasons = reviewReasons(result, opts.fullScore, opts.signals ?? {}, policy);
  if (reasons.length === 0) return null;

  const now = opts.now ?? Date.now();
  return {
    id: reviewItemId(opts.paperId, opts.questionNo),
    paperId: opts.paperId,
    questionNo: opts.questionNo,
    subject: opts.subject,
    createdAt: now,
    updatedAt: now,
    original: result,
    effective: result,
    reasons,
    status: 'pending',
    history: [],
    fullScore: opts.fullScore,
  };
}

/**
 * 并入队列（幂等）。
 *
 * 同一份答卷可能因为重跑评分而再次入队。此时**不新建条目**，
 * 而是更新原因，但**保留原有 original 与 history**——
 * 把人的修正记录冲掉是最不该发生的事。
 */
export function mergeIntoQueue(
  queue: readonly ReviewItem[],
  result: GradeResult,
  opts: EnqueueOptions,
): { queue: ReviewItem[]; item: ReviewItem | null; added: boolean } {
  const fresh = enqueueIfNeeded(result, opts);
  if (!fresh) return { queue: [...queue], item: null, added: false };

  const idx = queue.findIndex((x) => x.id === fresh.id);
  if (idx < 0) return { queue: [...queue, fresh], item: fresh, added: true };

  const prev = queue[idx]!;
  const merged: ReviewItem = {
    ...prev,
    // 已被人处理过的条目：重跑评分**不覆盖**人工结果，
    // 但更新 reasons（模型这次可能又有了新问题，人需要知道）
    effective: prev.history.length > 0 ? prev.effective : fresh.effective,
    reasons: fresh.reasons,
    updatedAt: fresh.updatedAt,
  };
  const next = [...queue];
  next[idx] = merged;
  return { queue: next, item: merged, added: false };
}

/* --------------------------------------------------------- 人工修正 */

/** 一个评分点的分值（老师修正评分点时用它重算总分） */
export interface PointScore {
  /** 评分点文字，须与 `hitPoints` / `missedPoints` 里的条目一致 */
  point: string;
  score: number;
}

export interface CorrectionInput {
  /** 直接改总分 */
  score?: number;
  /** 改为命中的评分点（文字须在 missedPoints 里） */
  markHit?: string[];
  /** 改为未命中的评分点（文字须在 hitPoints 里） */
  markMissed?: string[];
  /**
   * 各评分点分值。**只有提供了它**，翻点评分点时才会重算总分；
   * 否则保持原分数并给出警示（见下方说明）。
   */
  pointScores?: PointScore[];
  note?: string;
  by?: string;
  now?: number;
}

export interface CorrectionOutcome {
  item: ReviewItem;
  /** 需要提醒人的事（总分未能重算、被夹紧、条目不存在等）——**不能静默** */
  warnings: string[];
}

/**
 * 应用人工修正。
 *
 * 关键规则：
 *   1. 翻转评分点后，**只有知道各点分值才重算总分**；不知道就不猜，
 *      保留原分数并明确告知。凭空编一个"简单平均"会让分数悄悄变错。
 *   2. 总分夹紧到 `[0, fullScore]`，夹紧时给出警示
 *   3. `original` 永不改动，修正写进 `history`（append-only）
 *   4. 没有实际改动就不写 history（避免历史里全是噪声记录）
 */
export function applyManualCorrection(
  item: ReviewItem,
  input: CorrectionInput,
): CorrectionOutcome {
  const warnings: string[] = [];
  const now = input.now ?? Date.now();
  const full = Number.isFinite(item.fullScore) && item.fullScore > 0 ? item.fullScore : 0;

  const markHit = input.markHit ?? [];
  const markMissed = input.markMissed ?? [];

  const before = item.effective;
  const hit = new Set(before.hitPoints);
  const missed = new Set(before.missedPoints);
  const actuallyMarkedHit: string[] = [];
  const actuallyMarkedMissed: string[] = [];

  for (const p of markHit) {
    if (missed.delete(p)) {
      hit.add(p);
      actuallyMarkedHit.push(p);
    } else if (!hit.has(p)) {
      warnings.push(`评分点「${p}」不在该题的评分点里，已忽略。`);
    }
  }
  for (const p of markMissed) {
    if (hit.delete(p)) {
      missed.add(p);
      actuallyMarkedMissed.push(p);
    } else if (!missed.has(p)) {
      warnings.push(`评分点「${p}」不在该题的评分点里，已忽略。`);
    }
  }

  const pointsChanged = actuallyMarkedHit.length > 0 || actuallyMarkedMissed.length > 0;

  let nextScore: number;
  let scoreSource: 'manual' | 'recomputed' | 'unchanged';

  if (pointsChanged) {
    const ps = input.pointScores;
    if (ps && ps.length > 0) {
      const table = new Map(ps.map((x) => [x.point, x.score]));
      // ★ 一次查找、一处处理缺失。
      //
      // 前一版先 `filter(!table.has(p))` 收集 unknown，再另起一个循环
      // `table.get(p)!` 求和 —— 两次独立查表。探针（改用 `?? 0`）能通过测试，
      // 因为那次修改只影响了第二个循环，而第一个循环仍然发出了警示，
      // 于是测试"因为别的原因"变绿。**合起来查一次**以后，
      // 不确定性的来源就只剩这一个地方，不存在被另一处掩盖的可能。
      let sum = 0;
      const unknown: string[] = [];
      for (const p of hit) {
        const v = table.get(p);
        if (v === undefined) unknown.push(p);
        else sum += v;
      }

      if (unknown.length > 0) {
        // 有命中的评分点查不到分值 → 重算出来的总分必然偏小。
        // 宁可不动分数并说清楚，也不能给出一个系统性偏低的分数。
        warnings.push(
          `无法重算总分：评分点「${unknown.join('、')}」缺少分值定义，` +
            `分数保持 ${before.score} 不变，请直接手填总分。`,
        );
        nextScore = before.score;
        scoreSource = 'unchanged';
      } else {
        const rounded = Math.round(sum * 100) / 100;
        nextScore = clampScore(rounded, full, warnings);
        scoreSource = 'recomputed';
      }
    } else {
      warnings.push(
        '已更新评分点判定，但未提供各点分值，无法自动重算总分——' +
          `总分仍是 ${before.score}，请确认是否需要手填。`,
      );
      nextScore = before.score;
      scoreSource = 'unchanged';
    }
    // 评分点变了但总分没变时，手填的 score 优先（老师可能就是想手填）
    if (scoreSource === 'unchanged' && input.score !== undefined) {
      if (Number.isFinite(input.score)) {
        nextScore = clampScore(input.score, full, warnings);
        scoreSource = 'manual';
      } else {
        warnings.push('修正分数不是有效数字，已忽略。');
      }
    }
  } else if (input.score !== undefined) {
    if (!Number.isFinite(input.score)) {
      warnings.push('修正分数不是有效数字，已忽略。');
      nextScore = before.score;
      scoreSource = 'unchanged';
    } else {
      nextScore = clampScore(input.score, full, warnings);
      scoreSource = 'manual';
    }
  } else {
    nextScore = before.score;
    scoreSource = 'unchanged';
  }

  const changed = nextScore !== before.score || pointsChanged;
  if (!changed) {
    return { item, warnings };
  }

  const record: CorrectionRecord = {
    at: now,
    by: input.by ?? '',
    fromScore: before.score,
    toScore: nextScore,
    markedHit: actuallyMarkedHit,
    markedMissed: actuallyMarkedMissed,
    note: input.note ?? '',
  };

  const nextEffective: GradeResult = {
    ...before,
    score: nextScore,
    hitPoints: [...hit],
    missedPoints: [...missed],
    // 人工处理过之后模型那套置信度不再有意义。
    // 但**不能填 1.0**（那是"高度确信"，属于伪造）；
    // 用 reviewRequested:false + status:'corrected' 表达"已由人处理"。
    reviewRequested: false,
  };

  void scoreSource;
  return {
    item: {
      ...item,
      effective: nextEffective,
      status: 'corrected',
      history: [...item.history, record],
      updatedAt: now,
      ...(input.note ? { note: input.note } : {}),
    },
    warnings,
  };
}

function clampScore(v: number, full: number, warnings: string[]): number {
  if (full <= 0) return v;
  if (v > full) {
    warnings.push(`分数 ${v} 超过满分 ${full}，已夹紧到满分。`);
    return full;
  }
  if (v < 0) {
    warnings.push(`分数 ${v} 为负，已夹紧到 0。`);
    return 0;
  }
  return v;
}

/** 不改分数，只标记处理状态（确认模型没错 / 排除该题） */
export function applyManualVerdict(
  item: ReviewItem,
  status: Extract<ReviewStatus, 'confirmed' | 'excluded'>,
  input: { note?: string; by?: string; now?: number } = {},
): ReviewItem {
  const now = input.now ?? Date.now();
  const record: CorrectionRecord = {
    at: now,
    by: input.by ?? '',
    fromScore: item.effective.score,
    toScore: item.effective.score,
    markedHit: [],
    markedMissed: [],
    note: input.note ?? (status === 'confirmed' ? '人工确认模型结果正确' : '人工判定该题不参与评分'),
  };
  return {
    ...item,
    status,
    history: [...item.history, record],
    updatedAt: now,
    ...(input.note ? { note: input.note } : {}),
  };
}

/* --------------------------------------------------------- 汇总 */

/**
 * 队列统计的别名。
 *
 * 真实定义在 `shared/types.ts`（要经 IPC 传给界面，属于契约）。
 * 这里保留别名只是因为 `queueStats` 早先返回这个名字，
 * **不是**第二份定义——不要在这里加字段。
 */
export type QueueStats = ReviewStats;

/**
 * 队列统计。
 *
 * `correctionRate` 是**模型质量的直接信号**：人工复核后有多大比例真的改分了。
 * 它超过 0.5 说明模型在这个题型上不可用，应该先改提示词/rubric，
 * 而不是继续加大人工复核的量。
 */
export function queueStats(items: readonly ReviewItem[]): ReviewStats {
  const by = (s: ReviewStatus) => items.filter((x) => x.status === s).length;
  const corrected = by('corrected');
  const confirmed = by('confirmed');
  const decided = corrected + confirmed;
  let delta = 0;
  for (const x of items) delta += x.effective.score - x.original.score;
  return {
    total: items.length,
    pending: by('pending'),
    corrected,
    confirmed,
    excluded: by('excluded'),
    correctionRate: decided === 0 ? null : corrected / decided,
    netScoreDelta: Math.round(delta * 100) / 100,
  };
}

/**
 * 队列排序：**最需要人先看的排前面**。
 *
 * 依据（依次比较）：待处理优先 → 理由更多优先 → 原始置信度更低优先 → 更早入队优先。
 *
 * 刻意**不按试卷/题号排**：那种排序会把"最可疑的那一题"埋在第 50 行。
 */
export function sortQueue(items: readonly ReviewItem[]): ReviewItem[] {
  const rank = (s: ReviewStatus) => (s === 'pending' ? 0 : 1);
  return [...items].sort((a, b) => {
    if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
    if (a.reasons.length !== b.reasons.length) return b.reasons.length - a.reasons.length;
    if (a.original.confidence !== b.original.confidence) {
      return a.original.confidence - b.original.confidence;
    }
    return a.createdAt - b.createdAt;
  });
}

/** 理由的中文说明。界面不该自己拼文案，否则两边会不一致 */
export const REASON_TEXT: Record<ReviewReason, string> = {
  low_confidence: '模型置信度低于阈值',
  output_warnings: '模型输出不合规范，已被程序修正',
  ensemble_disagreement: '多次运行结果分歧，或未做多次运行',
  poor_image: '图片质量差，识别不可靠',
  objective_suspect: '客观题判定可疑',
  extreme_score: '分数处于极端值（0 分或满分）且置信度不高',
  model_requested: '模型主动要求人工复核',
};

export function explainReasons(reasons: readonly ReviewReason[]): string[] {
  return reasons.map((r) => REASON_TEXT[r]);
}

/* --------------------------------------------------------- 持久化校验 */

/**
 * 判断一条从磁盘读回的值是否是**结构可用**的复核条目。
 *
 * 为什么需要：`store.ts` 存的是 `unknown[]`（不该反向依赖 `ai/`），
 * 一个半截写入的条目会让整个复核列表崩——而崩掉意味着
 * **所有待复核分数都不见了**，且用户不知道发生了什么。
 *
 * 也用于统计"有多少条被隐藏了"：只丢弃不报数，等于让队列悄悄变短。
 */
export function isValidReviewItem(x: unknown): x is ReviewItem {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return false;
  const it = x as Partial<ReviewItem>;
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  return (
    typeof it.id === 'string' &&
    it.id.length > 0 &&
    typeof it.status === 'string' &&
    (['pending', 'corrected', 'confirmed', 'excluded'] as const).includes(
      it.status as ReviewItem['status'],
    ) &&
    Array.isArray(it.reasons) &&
    Array.isArray(it.history) &&
    num((it.original as { score?: unknown } | undefined)?.score) &&
    num((it.effective as { score?: unknown } | undefined)?.score) &&
    num(it.fullScore) &&
    typeof it.questionNo === 'string'
  );
}

/** 分离出可用条目与被丢弃的坏条目数（读取路径统一走它） */
export function partitionQueue(raw: readonly unknown[]): { items: ReviewItem[]; invalid: number } {
  const items: ReviewItem[] = [];
  let invalid = 0;
  for (const x of raw) {
    if (isValidReviewItem(x)) items.push(x);
    else invalid++;
  }
  return { items, invalid };
}

/* --------------------------------------------------------- 队列清理 */

export interface CompactOptions {
  /** 已处理条目保留多久（毫秒）。默认 7 天 */
  retainDecidedMs?: number;
  /** 上限：超过时优先丢弃最旧的已处理条目。默认 2000 条 */
  maxItems?: number;
  now?: number;
}

export const DEFAULT_RETAIN_DECIDED_MS = 7 * 24 * 3600 * 1000;
export const DEFAULT_MAX_QUEUE_ITEMS = 2000;

/**
 * 压缩队列，防止无限增长。
 *
 * 为什么需要：每次评分只要触发任一理由就会入队，而**已处理的条目不会自己消失**。
 * 长期使用下磁盘上会积累成千上万条历史，读一次就要全部反序列化，
 * 启动越来越慢，最后用户会去删配置文件——把待复核的也一起删掉。
 *
 * 清理规则（顺序即优先级）：
 *   1. **待处理的条目永不被清理**。丢一条待处理的，就是丢一个没人看的可疑分数，
 *      而且**不会有任何提示**。
 *   2. 已处理的条目按 `updatedAt` 保留 `retainDecidedMs`；超期的丢弃。
 *   3. 若仍超过 `maxItems`，从**最旧的已处理**条目开始丢，直到不超。
 */
export function compactQueue(
  items: readonly ReviewItem[],
  opts: CompactOptions = {},
): { queue: ReviewItem[]; dropped: number } {
  const now = opts.now ?? Date.now();
  const retain = opts.retainDecidedMs ?? DEFAULT_RETAIN_DECIDED_MS;
  const max = opts.maxItems ?? DEFAULT_MAX_QUEUE_ITEMS;

  // 严格小于：`retainDecidedMs: 0` 的语义是"一条已处理的都不留"。
  // 用 `<=` 会让 age 恰好为 0 的条目（就是刚刚处理的）留下来，
  // 于是"清空已处理"这个操作看起来生效了、其实没清。
  const pending = items.filter((x) => x.status === 'pending');
  const settled = items
    .filter((x) => x.status !== 'pending')
    .filter((x) => now - x.updatedAt < retain)
    // 越新的排前面（与"最该先看的在前面"一致）
    .sort((a, b) => b.updatedAt - a.updatedAt);

  let kept = [...pending, ...settled];
  let dropped = items.length - kept.length;

  if (kept.length > max) {
    // 只从已处理的尾部丢 —— pending 永远保留（哪怕因此超出上限）
    const budget = Math.max(0, max - pending.length);
    const keptSettled = settled.slice(0, budget);
    const before = kept.length;
    kept = [...pending, ...keptSettled];
    dropped += before - kept.length;
  }

  return { queue: kept, dropped };
}