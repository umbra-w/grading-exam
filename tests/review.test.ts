/**
 * 复核队列与人工修正的单测。
 *
 * 这一层的失败模式是**静默放行**：该复核的没进队列，或者老师改了分数
 * 而总分没跟着变。两者都不会报错，成绩单看起来完全正常。
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_REVIEW_POLICY,
  REASON_TEXT,
  applyManualCorrection,
  applyManualVerdict,
  compactQueue,
  enqueueIfNeeded,
  explainReasons,
  isValidReviewItem,
  mergeIntoQueue,
  needsReview,
  partitionQueue,
  queueStats,
  reviewItemId,
  reviewReasons,
  signalsFromResult,
  sortQueue,
  type ReviewItem,
  type ReviewSignals,
} from '../src/main/ai/review';
import type { GradeResult, EnsembleSummary } from '../src/shared/types';

/** 造一份形态真实的 GradeResult（字段名照抄 shared/types.ts） */
function mkResult(p: Partial<GradeResult> = {}): GradeResult {
  return {
    score: 5,
    comment: '步骤基本完整',
    hitPoints: ['列方程'],
    missedPoints: ['单位'],
    confidence: 0.9,
    reviewRequested: false,
    warnings: [],
    promptVersion: 'v1',
    promptHash: 'abc',
    ...p,
  };
}

function mkEnsemble(agreement: EnsembleSummary['agreement']): EnsembleSummary {
  return {
    runs: 3,
    scores: [5, 5, 6],
    disagreement: agreement === 'consistent' ? 0 : 0.3,
    agreement,
    commonMisses: [],
    contradictoryPoints: [],
  };
}

const baseOpts = { paperId: 'P1', questionNo: '17', subject: '数学', fullScore: 6 };

describe('reviewReasons —— 进队列判定', () => {
  it('完全没问题时不需要复核', () => {
    const r = mkResult({ score: 5, confidence: 0.95 });
    expect(reviewReasons(r, 6, { disagreement: 'none' })).toEqual([]);
    expect(needsReview(r, 6, { disagreement: 'none' })).toBe(false);
  });

  it('置信度低于阈值 → low_confidence', () => {
    const r = mkResult({ confidence: 0.6 });
    expect(reviewReasons(r, 6, { disagreement: 'none' })).toContain('low_confidence');
  });

  it('刚好等于阈值不算低（严格小于）', () => {
    const r = mkResult({ confidence: DEFAULT_REVIEW_POLICY.confidenceThreshold });
    expect(reviewReasons(r, 6, { disagreement: 'none' })).not.toContain('low_confidence');
  });

  it('★ warnings 非空必须复核 —— 即使置信度很高', () => {
    // 这是"只增不减"原则的典型案例：置信度 0.99 也挡不住"输出不合规范"
    const r = mkResult({ confidence: 0.99, warnings: ['score 字段是字符串，已转换'] });
    expect(reviewReasons(r, 6, { disagreement: 'none' })).toContain('output_warnings');
  });

  it('★ 只跑一次（无 ensemble）必须复核：没测过 ≠ 测过且通过', () => {
    const r = mkResult({ confidence: 0.99 });
    const s = signalsFromResult(r);
    expect(s.disagreement).toBe('insufficient');
    expect(reviewReasons(r, 6, s)).toContain('ensemble_disagreement');
  });

  it('★ contradictory 归为 major，必须复核', () => {
    const r = mkResult({ confidence: 0.99, ensemble: mkEnsemble('contradictory') });
    const s = signalsFromResult(r);
    expect(s.disagreement).toBe('major');
    expect(reviewReasons(r, 6, s)).toContain('ensemble_disagreement');
  });

  it('consistent 且置信度高时不需要复核', () => {
    const r = mkResult({ confidence: 0.95, ensemble: mkEnsemble('consistent') });
    expect(reviewReasons(r, 6, signalsFromResult(r))).toEqual([]);
  });

  it('minor 分歧本身不强制复核', () => {
    const r = mkResult({ confidence: 0.95, ensemble: mkEnsemble('minor') });
    expect(reviewReasons(r, 6, signalsFromResult(r))).not.toContain('ensemble_disagreement');
  });

  it('图片质量差 / 客观题可疑 → 对应理由', () => {
    const r = mkResult({ confidence: 0.95 });
    const rs = reviewReasons(r, 6, { disagreement: 'none', poorImage: true, objectiveSuspect: true });
    expect(rs).toContain('poor_image');
    expect(rs).toContain('objective_suspect');
  });

  it('★ 极端分数 + 置信度不高 → 复核；置信度很高则不因极端而复核', () => {
    const zeroLow = reviewReasons(mkResult({ score: 0, confidence: 0.8 }), 6, { disagreement: 'none' });
    expect(zeroLow).toContain('extreme_score');

    const zeroHigh = reviewReasons(mkResult({ score: 0, confidence: 0.95 }), 6, { disagreement: 'none' });
    expect(zeroHigh).not.toContain('extreme_score');

    const fullHigh = reviewReasons(mkResult({ score: 6, confidence: 0.95 }), 6, { disagreement: 'none' });
    expect(fullHigh).not.toContain('extreme_score');
  });

  it('满分为 0 或非法时不做极端判定（不制造假警报）', () => {
    expect(reviewReasons(mkResult({ score: 0, confidence: 0.5 }), 0, { disagreement: 'none' })).not.toContain(
      'extreme_score',
    );
    expect(reviewReasons(mkResult({ score: 0, confidence: 0.5 }), NaN, { disagreement: 'none' })).not.toContain(
      'extreme_score',
    );
  });

  it('模型主动要求复核 → model_requested，不会被别的理由抵消', () => {
    const r = mkResult({ confidence: 0.99, reviewRequested: true });
    expect(reviewReasons(r, 6, { disagreement: 'none' })).toContain('model_requested');
  });

  it('★ 多条理由同时出现时全部保留（只增不减）', () => {
    const r = mkResult({ score: 0, confidence: 0.4, warnings: ['x'], reviewRequested: true });
    const rs = reviewReasons(r, 6, { disagreement: 'major', poorImage: true });
    expect(new Set(rs)).toEqual(
      new Set([
        'low_confidence', 'output_warnings', 'ensemble_disagreement',
        'poor_image', 'extreme_score', 'model_requested',
      ]),
    );
    expect(rs.length).toBe(6);
  });

  it('置信度是非法值（NaN）时按"低置信度"处理，不放过', () => {
    expect(reviewReasons(mkResult({ confidence: NaN }), 6, { disagreement: 'none' })).toContain(
      'low_confidence',
    );
  });

  it('policy 可覆盖：关掉 warnings 复核后不再因 warnings 入队', () => {
    const r = mkResult({ confidence: 0.95, warnings: ['x'] });
    const rs = reviewReasons(r, 6, { disagreement: 'none' }, {
      ...DEFAULT_REVIEW_POLICY, reviewOnWarnings: false,
    });
    expect(rs).toEqual([]);
  });

  it('理由说明文案覆盖全部理由类型（界面不会漏显示）', () => {
    const all: ReviewSignals = { disagreement: 'major', poorImage: true, objectiveSuspect: true };
    const rs = reviewReasons(mkResult({ score: 0, confidence: 0.1, warnings: ['w'], reviewRequested: true }), 6, all);
    const text = explainReasons(rs);
    expect(text.length).toBe(rs.length);
    for (const t of text) expect(t.length).toBeGreaterThan(0);
    for (const r of rs) expect(REASON_TEXT[r]).toBeTruthy();
  });
});

describe('enqueueIfNeeded / mergeIntoQueue', () => {
  it('不需要复核时返回 null（调用方据此决定是否打日志）', () => {
    const r = mkResult({ confidence: 0.95 });
    expect(enqueueIfNeeded(r, { ...baseOpts, signals: { disagreement: 'none' } })).toBeNull();
  });

  it('需要复核时建出 pending 条目', () => {
    const item = enqueueIfNeeded(mkResult({ confidence: 0.5 }), { ...baseOpts, now: 1000 })!;
    expect(item.status).toBe('pending');
    expect(item.createdAt).toBe(1000);
    expect(item.original.score).toBe(5);
    expect(item.effective).toBe(item.original);
    expect(item.history).toEqual([]);
    expect(item.fullScore).toBe(6);
    expect(item.id).toBe(reviewItemId('P1', '17'));
  });

  it('同一题重复入队不新增条目（幂等）', () => {
    const r = mkResult({ confidence: 0.5 });
    const a = mergeIntoQueue([], r, { ...baseOpts, now: 1000 });
    expect(a.added).toBe(true);
    const b = mergeIntoQueue(a.queue, r, { ...baseOpts, now: 2000 });
    expect(b.added).toBe(false);
    expect(b.queue).toHaveLength(1);
    expect(b.queue[0]!.updatedAt).toBe(2000);
  });

  it('★ 重复入队不覆盖人工结果，但会更新理由', () => {
    const r1 = mkResult({ confidence: 0.5 });
    const a = mergeIntoQueue([], r1, { ...baseOpts, now: 1000 });
    // 人工把它改对
    const fixed = applyManualCorrection(a.queue[0]!, { score: 6, note: '学生其实对了', now: 1500 }).item;
    // 模型重跑后仍然是低置信度
    const r2 = mkResult({ confidence: 0.55, warnings: ['新问题'] });
    const b = mergeIntoQueue([fixed], r2, { ...baseOpts, now: 2000 });
    expect(b.item!.effective.score).toBe(6); // 人工结果保住
    expect(b.item!.status).toBe('corrected');
    expect(b.item!.history).toHaveLength(1); // 历史没被冲掉
    expect(b.item!.reasons).toContain('output_warnings'); // 新理由进来了
  });

  it('★ 未被人处理过的条目，重跑评分会更新 effective', () => {
    const a = mergeIntoQueue([], mkResult({ confidence: 0.5, score: 5 }), { ...baseOpts, now: 1000 });
    const b = mergeIntoQueue(a.queue, mkResult({ confidence: 0.5, score: 4 }), { ...baseOpts, now: 2000 });
    expect(b.item!.effective.score).toBe(4);
    expect(b.item!.original.score).toBe(5);
  });

  it('mergeIntoQueue 不修改传入数组（纯函数）', () => {
    const original: ReviewItem[] = [];
    mergeIntoQueue(original, mkResult({ confidence: 0.5 }), baseOpts);
    expect(original).toEqual([]);
  });
});

describe('applyManualCorrection —— 手填总分', () => {
  const item = enqueueIfNeeded(mkResult({ confidence: 0.5 }), { ...baseOpts, now: 1000 })!;

  it('手填分数生效，状态变 corrected，original 不变', () => {
    const { item: out, warnings } = applyManualCorrection(item, { score: 6, note: '给满分', by: 'T1', now: 2000 });
    expect(out.effective.score).toBe(6);
    expect(out.original.score).toBe(5);
    expect(out.status).toBe('corrected');
    expect(out.history).toHaveLength(1);
    expect(out.history[0]).toMatchObject({ fromScore: 5, toScore: 6, note: '给满分', by: 'T1', at: 2000 });
    expect(warnings).toEqual([]);
  });

  it('人工处理过之后 reviewRequested 置 false，但置信度不伪造', () => {
    const p = mkResult({ confidence: 0.5, reviewRequested: true });
    const it0 = enqueueIfNeeded(p, { ...baseOpts, now: 1 })!;
    const { item: out } = applyManualCorrection(it0, { score: 6 });
    expect(out.effective.reviewRequested).toBe(false);
    // 不能把置信度改成 1.0 —— 那是"高度确信"，属于伪造
    expect(out.effective.confidence).toBe(0.5);
  });

  it('★ 超出满分的修正被夹紧，并给出警示（不静默）', () => {
    const { item: out, warnings } = applyManualCorrection(item, { score: 99 });
    expect(out.effective.score).toBe(6);
    expect(warnings.join()).toMatch(/夹紧/);
  });

  it('★ 负分被夹紧到 0，并给出警示', () => {
    const { item: out, warnings } = applyManualCorrection(item, { score: -3 });
    expect(out.effective.score).toBe(0);
    expect(warnings.join()).toMatch(/夹紧/);
  });

  it('非法数字不生效，并给出警示', () => {
    const { item: out, warnings } = applyManualCorrection(item, { score: Number.NaN });
    expect(out.effective.score).toBe(5);
    expect(out).toBe(item);
    expect(warnings.join()).toMatch(/不是有效数字/);
  });

  it('★ 没有实际变化时不写 history（避免历史全是噪声）', () => {
    const { item: out } = applyManualCorrection(item, { score: 5 });
    expect(out).toBe(item);
    expect(out.history).toEqual([]);
  });

  it('未提供任何修正输入时保持原状', () => {
    const { item: out, warnings } = applyManualCorrection(item, {});
    expect(out).toBe(item);
    expect(warnings).toEqual([]);
  });

  it('history 是 append-only：连续修正确实累积', () => {
    const a = applyManualCorrection(item, { score: 4, now: 2000 }).item;
    const b = applyManualCorrection(a, { score: 3, now: 3000 }).item;
    expect(b.history.map((h) => h.toScore)).toEqual([4, 3]);
    expect(b.history.map((h) => h.fromScore)).toEqual([5, 4]);
  });
});

describe('applyManualCorrection —— 评分点翻转', () => {
  const item = enqueueIfNeeded(mkResult({ confidence: 0.5 }), { ...baseOpts, now: 1000 })!;

  it('★ 提供各点分值时会重算总分', () => {
    // 命中「列方程」(2) + 翻转「单位」为命中(1) = 3
    const { item: out } = applyManualCorrection(item, {
      markHit: ['单位'],
      pointScores: [
        { point: '列方程', score: 2 },
        { point: '求解正确', score: 3 },
        { point: '单位', score: 1 },
      ],
    });
    expect(out.effective.hitPoints).toContain('单位');
    expect(out.effective.missedPoints).not.toContain('单位');
    expect(out.effective.score).toBe(3);
  });

  it('翻转多个评分点会全部计入求和', () => {
    const { item: out } = applyManualCorrection(item, {
      markHit: ['单位'],
      pointScores: [
        { point: '列方程', score: 2 },
        { point: '单位', score: 1 },
      ],
    });
    expect(out.effective.score).toBe(3);
  });

  it('★ 缺少某命中点的分值时不猜，保留原分数并明确警示', () => {
    // 若按"查到几个算几个"，总分会被系统性地算小 —— 静默的错误
    const { item: out, warnings } = applyManualCorrection(item, {
      markHit: ['单位'],
      pointScores: [{ point: '列方程', score: 2 }], // 缺「单位」
    });
    expect(out.effective.score).toBe(5);
    expect(warnings.join()).toMatch(/无法重算总分/);
    expect(warnings.join()).toMatch(/单位/);
    // 但评分点判定仍然更新了（老师看到的效果应该在）
    expect(out.effective.hitPoints).toContain('单位');
  });

  it('★ 未提供分值时不猜，保留原分数并提示手填', () => {
    const { item: out, warnings } = applyManualCorrection(item, { markHit: ['单位'] });
    expect(out.effective.score).toBe(5);
    expect(warnings.join()).toMatch(/未提供各点分值/);
  });

  it('未提供分值时，手填的 score 优先生效', () => {
    const { item: out, warnings } = applyManualCorrection(item, { markHit: ['单位'], score: 4 });
    expect(out.effective.score).toBe(4);
    expect(warnings.join()).toMatch(/未提供各点分值/);
  });

  it('★ 重算结果超过满分时夹紧并警示', () => {
    const { item: out, warnings } = applyManualCorrection(item, {
      markHit: ['单位'],
      pointScores: [
        { point: '列方程', score: 5 },
        { point: '单位', score: 5 },
      ],
    });
    expect(out.effective.score).toBe(6);
    expect(warnings.join()).toMatch(/夹紧/);
  });

  it('markMissed 把已命中的点翻成未命中', () => {
    const { item: out } = applyManualCorrection(item, {
      markMissed: ['列方程'],
      pointScores: [{ point: '单位', score: 1 }],
    });
    expect(out.effective.hitPoints).toEqual([]);
    expect(out.effective.missedPoints).toContain('列方程');
    expect(out.effective.score).toBe(0);
  });

  it('★ 不存在的评分点被忽略并警示', () => {
    const { warnings } = applyManualCorrection(item, {
      markHit: ['不存在的点'],
      pointScores: [{ point: '列方程', score: 2 }],
    });
    expect(warnings.join()).toMatch(/不在该题的评分点里/);
  });

  it('history 记录翻转明细（可回溯"谁把哪个点翻过来了"）', () => {
    const { item: out } = applyManualCorrection(item, {
      markHit: ['单位'],
      pointScores: [
        { point: '列方程', score: 2 },
        { point: '单位', score: 1 },
      ],
      note: '给了单位分',
    });
    expect(out.history[0]!.markedHit).toEqual(['单位']);
    expect(out.history[0]!.markedMissed).toEqual([]);
    expect(out.history[0]!.note).toBe('给了单位分');
  });

  it('翻转不产生实际变化时不写 history', () => {
    const { item: out } = applyManualCorrection(item, { markHit: ['列方程'] }); // 已经是命中
    expect(out).toBe(item);
    expect(out.history).toEqual([]);
  });

  it('★ 不修改输入条目的 effective（纯函数）', () => {
    const before = JSON.stringify(item);
    applyManualCorrection(item, { markHit: ['单位'], score: 1 });
    expect(JSON.stringify(item)).toBe(before);
  });
});

describe('applyManualVerdict', () => {
  const item = enqueueIfNeeded(mkResult({ confidence: 0.5 }), { ...baseOpts, now: 1000 })!;

  it('confirmed 不改分数，只记状态与历史', () => {
    const out = applyManualVerdict(item, 'confirmed', { now: 2000, note: '看过没问题' });
    expect(out.status).toBe('confirmed');
    expect(out.effective.score).toBe(5);
    expect(out.history[0]).toMatchObject({ fromScore: 5, toScore: 5, note: '看过没问题' });
  });

  it('excluded 记录默认说明', () => {
    const out = applyManualVerdict(item, 'excluded');
    expect(out.status).toBe('excluded');
    expect(out.history[0]!.note).toMatch(/不参与评分/);
  });
});

describe('queueStats', () => {
  const mk = (status: ReviewItem['status'], delta = 0, conf = 0.5): ReviewItem => {
    const it = enqueueIfNeeded(mkResult({ confidence: conf }), { ...baseOpts, now: 1 })!;
    return { ...it, status, effective: { ...it.effective, score: it.effective.score + delta } };
  };

  it('空队列时 correctionRate 为 null，不是 0', () => {
    // 「没测过」≠「测过且通过」（AGENTS §6.3）
    const s = queueStats([]);
    expect(s.total).toBe(0);
    expect(s.correctionRate).toBeNull();
  });

  it('★ 还没有人工结论时 correctionRate 也是 null，不是 0', () => {
    expect(queueStats([mk('pending')]).correctionRate).toBeNull();
  });

  it('corrected / confirmed 比例正确', () => {
    const s = queueStats([mk('corrected', 1), mk('confirmed'), mk('confirmed'), mk('pending')]);
    expect(s.total).toBe(4);
    expect(s.pending).toBe(1);
    expect(s.corrected).toBe(1);
    expect(s.confirmed).toBe(2);
    expect(s.correctionRate).toBeCloseTo(1 / 3, 6);
  });

  it('excluded 不计入 correctionRate 的分母（没改分也没有"模型对了"的含义）', () => {
    const s = queueStats([mk('corrected', 1), mk('excluded')]);
    expect(s.correctionRate).toBe(1);
    expect(s.excluded).toBe(1);
  });

  it('netScoreDelta 汇总人工修正的净变化', () => {
    const s = queueStats([mk('corrected', 1), mk('corrected', -2)]);
    expect(s.netScoreDelta).toBe(-1);
  });
});

describe('sortQueue —— 最需要人先看的排前面', () => {
  const mk = (id: string, status: ReviewItem['status'], conf: number, reasons: number, createdAt: number): ReviewItem =>
    ({
      id, paperId: 'P', questionNo: id, subject: '数学',
      createdAt, updatedAt: createdAt,
      original: mkResult({ confidence: conf }),
      effective: mkResult({ confidence: conf }),
      reasons: Array.from({ length: reasons }, () => 'low_confidence' as const),
      status, history: [], fullScore: 6,
    });

  it('★ 待处理的全部排在已处理之前（哪怕置信度更高）', () => {
    const q = [
      mk('a', 'confirmed', 0.1, 5, 1),
      mk('b', 'pending', 0.9, 1, 2),
    ];
    expect(sortQueue(q).map((x) => x.id)).toEqual(['b', 'a']);
  });

  it('理由更多的排前面', () => {
    const q = [mk('a', 'pending', 0.5, 1, 1), mk('b', 'pending', 0.5, 3, 2)];
    expect(sortQueue(q).map((x) => x.id)).toEqual(['b', 'a']);
  });

  it('理由数相同时置信度更低的排前面', () => {
    const q = [mk('a', 'pending', 0.7, 2, 1), mk('b', 'pending', 0.2, 2, 2)];
    expect(sortQueue(q).map((x) => x.id)).toEqual(['b', 'a']);
  });

  it('置信度也相同时更早入队的排前面', () => {
    const q = [mk('a', 'pending', 0.5, 2, 9), mk('b', 'pending', 0.5, 2, 3)];
    expect(sortQueue(q).map((x) => x.id)).toEqual(['b', 'a']);
  });

  it('不修改输入数组', () => {
    const q = [mk('a', 'pending', 0.5, 1, 1), mk('b', 'pending', 0.5, 3, 2)];
    const before = q.map((x) => x.id);
    sortQueue(q);
    expect(q.map((x) => x.id)).toEqual(before);
  });
});

describe('compactQueue —— 防止队列无限增长', () => {
  const mk = (
    id: string,
    status: ReviewItem['status'],
    updatedAt: number,
  ): ReviewItem => ({
    id,
    paperId: 'P',
    questionNo: id,
    subject: '数学',
    createdAt: 1,
    updatedAt,
    original: mkResult({ confidence: 0.5 }),
    effective: mkResult({ confidence: 0.5 }),
    reasons: ['low_confidence'],
    status,
    history: [],
    fullScore: 6,
  });

  const DAY = 24 * 3600 * 1000;
  const NOW = 100 * DAY;

  it('★ 待处理的条目永不被清理，哪怕极旧', () => {
    // 丢一条待处理的 = 丢一个没人看的可疑分数，且不会有任何提示
    const q = [mk('old-pending', 'pending', NOW - 999 * DAY)];
    const { queue, dropped } = compactQueue(q, { now: NOW });
    expect(queue.map((x) => x.id)).toEqual(['old-pending']);
    expect(dropped).toBe(0);
  });

  it('已处理且超期的条目被丢弃', () => {
    const q = [
      mk('fresh', 'corrected', NOW - 1 * DAY),
      mk('stale', 'confirmed', NOW - 30 * DAY),
    ];
    const { queue, dropped } = compactQueue(q, { now: NOW });
    expect(queue.map((x) => x.id)).toEqual(['fresh']);
    expect(dropped).toBe(1);
  });

  it('保留期内已处理的条目不被丢弃', () => {
    const q = [mk('a', 'confirmed', NOW - 6 * DAY)];
    expect(compactQueue(q, { now: NOW }).queue).toHaveLength(1);
  });

  it('★ 超出上限时只丢最旧的已处理条目，pending 全部保留', () => {
    const settled = [1, 2, 3, 4, 5].map((i) => mk(`s${i}`, 'confirmed', NOW - i * 1000));
    const pending = [mk('p1', 'pending', NOW), mk('p2', 'pending', NOW)];
    const { queue } = compactQueue([...settled, ...pending], { now: NOW, maxItems: 4 });
    // 2 个 pending 必须都在
    expect(queue.filter((x) => x.status === 'pending').map((x) => x.id).sort()).toEqual(['p1', 'p2']);
    expect(queue).toHaveLength(4);
    // 保留的是最新的已处理条目（s1 最新）
    expect(queue.filter((x) => x.status !== 'pending').map((x) => x.id)).toEqual(['s1', 's2']);
  });

  it('★ pending 数量本身就超过上限时，宁可超出也不丢 pending', () => {
    const q = [1, 2, 3].map((i) => mk(`p${i}`, 'pending', NOW));
    const { queue } = compactQueue(q, { now: NOW, maxItems: 1 });
    expect(queue).toHaveLength(3);
  });

  it('保留期可配置：设为 0 时丢掉全部已处理条目', () => {
    const q = [mk('a', 'confirmed', NOW)];
    expect(compactQueue(q, { now: NOW, retainDecidedMs: 0 }).queue).toHaveLength(0);
  });

  it('空队列安全', () => {
    expect(compactQueue([], { now: NOW })).toEqual({ queue: [], dropped: 0 });
  });

  it('不修改输入数组', () => {
    const q = [mk('stale', 'confirmed', NOW - 30 * DAY)];
    compactQueue(q, { now: NOW });
    expect(q).toHaveLength(1);
  });

  it('dropped 数量与实际丢弃数一致', () => {
    const q = [
      mk('a', 'confirmed', NOW - 30 * DAY),
      mk('b', 'corrected', NOW - 40 * DAY),
      mk('c', 'pending', NOW - 40 * DAY),
    ];
    const { queue, dropped } = compactQueue(q, { now: NOW });
    expect(dropped).toBe(2);
    expect(q.length - queue.length).toBe(2);
  });
});

describe('isValidReviewItem / partitionQueue —— 磁盘读回的校验', () => {
  const good = enqueueIfNeeded(mkResult({ confidence: 0.5 }), { ...baseOpts, now: 1 })!;

  it('正常条目通过校验', () => {
    expect(isValidReviewItem(good)).toBe(true);
  });

  it('★ 各类坏形状都被判无效（半截写入不能让整个列表崩）', () => {
    const bad: unknown[] = [
      null,
      undefined,
      42,
      'item',
      [],
      {},
      { ...good, id: '' },
      { ...good, id: 123 },
      { ...good, status: 'whatever' },
      { ...good, reasons: 'not-an-array' },
      { ...good, history: null },
      { ...good, original: undefined },
      { ...good, original: { score: '5' } },
      { ...good, effective: {} },
      { ...good, fullScore: Number.NaN },
      { ...good, questionNo: 7 },
    ];
    for (const b of bad) {
      expect(isValidReviewItem(b), JSON.stringify(b)?.slice(0, 60)).toBe(false);
    }
  });

  it('四种合法状态都通过（校验不能把合法状态误判成坏数据）', () => {
    for (const s of ['pending', 'corrected', 'confirmed', 'excluded'] as const) {
      expect(isValidReviewItem({ ...good, status: s }), s).toBe(true);
    }
  });

  it('partitionQueue 分离可用与损坏，并给出损坏数', () => {
    const { items, invalid } = partitionQueue([good, null, { ...good, id: 'x' }, 'junk']);
    expect(items.map((x) => x.id)).toEqual([good.id, 'x']);
    expect(invalid).toBe(2);
  });

  it('★ 全坏时不静默返回空：invalid 数等于输入长度', () => {
    const { items, invalid } = partitionQueue([null, 1, 'x']);
    expect(items).toEqual([]);
    expect(invalid).toBe(3);
  });

  it('空输入安全', () => {
    expect(partitionQueue([])).toEqual({ items: [], invalid: 0 });
  });
});

describe('不变量', () => {
  it('★ 需要复核 ⟺ reviewReasons 非空（两个入口不给出一致性矛盾）', () => {
    const confs = [0, 0.5, 0.75, 0.9, 1];
    const disagreements: Array<ReviewSignals['disagreement']> = [undefined, 'none', 'minor', 'major', 'insufficient'];
    for (const c of confs) {
      for (const d of disagreements) {
        for (const w of [[], ['x']]) {
          const r = mkResult({ confidence: c, warnings: w });
          const sig: ReviewSignals = { disagreement: d };
          expect(needsReview(r, 6, sig)).toBe(reviewReasons(r, 6, sig).length > 0);
        }
      }
    }
  });

  it('★ 人工修正后，总分始终在 [0, fullScore] 内', () => {
    const base = enqueueIfNeeded(mkResult({ confidence: 0.5 }), { ...baseOpts, now: 1 })!;
    const inputs = [
      { score: 99 }, { score: -99 }, { score: 3.5 },
      { markHit: ['单位'], pointScores: [{ point: '列方程', score: 2 }, { point: '单位', score: 1 }] },
      { markMissed: ['列方程'], pointScores: [{ point: '单位', score: 1 }] },
      { markHit: ['单位'], pointScores: [{ point: '列方程', score: 99 }, { point: '单位', score: 99 }] },
    ];
    for (const inp of inputs) {
      const out = applyManualCorrection(base, inp).item;
      expect(out.effective.score, JSON.stringify(inp)).toBeGreaterThanOrEqual(0);
      expect(out.effective.score, JSON.stringify(inp)).toBeLessThanOrEqual(6);
    }
  });

  it('★ 修正历史只增不减：任何操作都不会缩短 history', () => {
    let it = enqueueIfNeeded(mkResult({ confidence: 0.5 }), { ...baseOpts, now: 1 })!;
    expect(it.history).toHaveLength(0);
    it = applyManualCorrection(it, { score: 4, now: 2 }).item;
    expect(it.history).toHaveLength(1);
    it = applyManualCorrection(it, { score: 3, now: 3 }).item;
    expect(it.history).toHaveLength(2);
    it = applyManualVerdict(it, 'confirmed', { now: 4 });
    expect(it.history).toHaveLength(3);
  });

  it('★ original 在任何修正后都与模型原始输出完全一致', () => {
    const orig = mkResult({ confidence: 0.4, score: 5 });
    let it = enqueueIfNeeded(orig, { ...baseOpts, now: 1 })!;
    it = applyManualCorrection(it, { score: 6, note: 'x', now: 2 }).item;
    it = applyManualCorrection(it, { markMissed: ['列方程'], now: 3 }).item;
    expect(it.original).toEqual(orig);
  });
});