import { describe, expect, it } from 'vitest';
import {
  type AggregateInput,
  type QuestionMeta,
  aggregatePaper,
  buildDistribution,
  buildLossRanking,
  stratifiedByType,
  summarizeScores,
} from '../src/main/io/paper';
import type { GradingDetail, StudentResult } from '../src/shared/types';

/* ---------------------------------------------------------------- 工厂 */

function mkDetail(p: Partial<GradingDetail> = {}): GradingDetail {
  return {
    questionId: 'Q1',
    index: 0,
    type: 'short',
    score: 6,
    fullScore: 10,
    comment: '',
    hitPoints: [],
    missedPoints: [],
    confidence: 0.9,
    reviewRequested: false,
    ...p,
  };
}

function mkStudent(p: Partial<StudentResult> = {}, details?: GradingDetail[]): StudentResult {
  const d = details ?? [mkDetail()];
  return {
    submissionId: p.submissionId ?? 'S1',
    name: p.name ?? '张三',
    examNo: p.examNo ?? '001',
    details: d,
    total: p.total ?? d.reduce((a, x) => a + x.score, 0),
    fullTotal: p.fullTotal ?? d.reduce((a, x) => a + x.fullScore, 0),
    comment: p.comment ?? '',
    gradedAt: p.gradedAt ?? 1_700_000_000_000,
    ...p,
  };
}

const META: QuestionMeta[] = [
  { questionId: 'Q1', type: 'choice', fullScore: 5 },
  { questionId: 'Q2', type: 'short', fullScore: 10 },
];

/* ══════════════════════════════════════════════ 分数汇总 */

describe('summarizeScores：总分汇总', () => {
  it('空集合返回 null 而不是 0 —— 「没数据」与「全 0 分」必须区分', () => {
    /*
     * 这是本模块最重要的一条口径。
     * 返回 0 会让一份没导入任何答卷的班级显示"平均分 0、及格率 0%"，
     * 看起来像一个真实（且灾难性）的结果。返回 null 才能让界面说
     * "还没有数据"。§6.1 的静默失败正是这类。
     */
    expect(summarizeScores([])).toBeNull();
  });

  it('单个学生：平均/最高/最低都是他自己', () => {
    const s = summarizeScores([{ total: 80, fullTotal: 100 }]);
    expect(s).not.toBeNull();
    expect(s!.count).toBe(1);
    expect(s!.average).toBe(80);
    expect(s!.max).toBe(80);
    expect(s!.min).toBe(80);
    expect(s!.fullTotal).toBe(100);
  });

  it('多个学生：平均分保留两位，最高最低正确', () => {
    const s = summarizeScores([
      { total: 90, fullTotal: 100 },
      { total: 60, fullTotal: 100 },
      { total: 75, fullTotal: 100 },
    ]);
    expect(s!.count).toBe(3);
    expect(s!.average).toBe(75);
    expect(s!.max).toBe(90);
    expect(s!.min).toBe(60);
  });

  it('★ 及格率按**归一化**比例算，不是按绝对分 —— 100 分制 60 及格，10 分制就是 6', () => {
    /*
     * §6.2 的规则：任何阈值判定涉及不同满分值的，一律归一化。
     * 若按绝对分 60 判定，一份 10 分制的卷子永远不可能及格，
     * 及格率恒为 0%，而**看起来完全正常**。
     */
    const full = summarizeScores([
      { total: 6, fullTotal: 10 },
      { total: 5.9, fullTotal: 10 },
    ]);
    expect(full!.passRate).toBe(0.5);

    const full100 = summarizeScores([
      { total: 60, fullTotal: 100 },
      { total: 59, fullTotal: 100 },
    ]);
    expect(full100!.passRate).toBe(0.5);
  });

  it('刚好 60% 算及格（边界含在内）', () => {
    const s = summarizeScores([{ total: 6, fullTotal: 10 }]);
    expect(s!.passRate).toBe(1);
  });

  it('★ 满分不一致时不静默混算 —— 用"人数最多"的满分为基准并如实标注', () => {
    /*
     * 一份卷子里混进不同满分是数据问题，但不能因此崩溃或瞎算。
     * 取众数作基准，并把不一致的事实**暴露出来**（mixedFullScore=true），
     * 由界面提示教师去查，而不是悄悄按第一次见到的满分算。
     */
    const s = summarizeScores([
      { total: 90, fullTotal: 100 },
      { total: 9, fullTotal: 10 },
      { total: 80, fullTotal: 100 },
    ]);
    expect(s!.fullTotal).toBe(100);
    expect(s!.mixedFullScore).toBe(true);
  });

  it('满分一致时不报 mixedFullScore', () => {
    const s = summarizeScores([
      { total: 90, fullTotal: 100 },
      { total: 80, fullTotal: 100 },
    ]);
    expect(s!.mixedFullScore).toBe(false);
  });

  it('满分众数并列时取较大的那个（宁可高估基准，不低估）', () => {
    const s = summarizeScores([
      { total: 90, fullTotal: 100 },
      { total: 9, fullTotal: 10 },
    ]);
    // 各 1 人并列 → 取 100。取值本身不重要，重要的是**确定且可解释**
    expect(s!.fullTotal).toBe(100);
  });

  it('★ 超过满分的分数使平均值失效，但不猜原因', () => {
    /*
     * 学生总分超过满分（漏改、重复计分）是必须报出来的数据问题。
     * 本模块不"修正"它 —— 修正等于替教师决定，而且会掩盖缺陷。
     * 只把 numberValid 置 false，让上层决定怎么处置。
     */
    const s = summarizeScores([{ total: 120, fullTotal: 100 }]);
    expect(s!.numberValid).toBe(false);
  });

  it('负数总分同样使平均值失效', () => {
    const s = summarizeScores([{ total: -1, fullTotal: 100 }]);
    expect(s!.numberValid).toBe(false);
  });

  it('满分非正数使平均值失效（无法归一化）', () => {
    const s = summarizeScores([{ total: 0, fullTotal: 0 }]);
    expect(s!.numberValid).toBe(false);
  });

  it('全部在 [0, 满分] 内时 numberValid 为 true', () => {
    const s = summarizeScores([
      { total: 0, fullTotal: 100 },
      { total: 100, fullTotal: 100 },
    ]);
    expect(s!.numberValid).toBe(true);
  });
});

/* ══════════════════════════════════════════════ 分箱直方图 */

describe('buildDistribution：分数分布分箱', () => {
  it('空集合返回空数组（不是全 0 的箱子）', () => {
    expect(buildDistribution([])).toEqual([]);
  });

  it('★ 分箱按**归一化得分率**，不是绝对分 —— 否则 10 分制全挤进「0-59」箱', () => {
    /*
     * 若按绝对分分箱，一份 10 分制的卷子所有人的分数都落在「0-59」，
     * 分布图看起来"全班不及格"，而实际上可能全是满分。
     */
    const d = buildDistribution([
      { total: 9, fullTotal: 10 },
      { total: 10, fullTotal: 10 },
    ]);
    // 90% 与 100% 应落在最高两箱，而不是「0-59」
    expect(d.some((b) => b.bucket.includes('90'))).toBe(true);
    expect(d.find((b) => b.bucket.includes('0-'))?.count ?? 0).toBe(0);
  });

  it('箱子的总人数等于输入人数（不漏不重）', () => {
    const students = [
      { total: 95, fullTotal: 100 },
      { total: 85, fullTotal: 100 },
      { total: 62, fullTotal: 100 },
      { total: 30, fullTotal: 100 },
    ];
    const d = buildDistribution(students);
    expect(d.reduce((a, b) => a + b.count, 0)).toBe(4);
  });

  it('满分的 100% 落在最后一箱，0 分落在第一箱', () => {
    const d = buildDistribution([
      { total: 100, fullTotal: 100 },
      { total: 0, fullTotal: 100 },
    ]);
    expect(d[0]!.count).toBe(1);
    expect(d[d.length - 1]!.count).toBe(1);
  });

  it('箱子顺序固定从低到高，且不因空箱被省略（省略会看不出分布形状）', () => {
    const d = buildDistribution([{ total: 65, fullTotal: 100 }]);
    // 所有箱都在，空箱 count 为 0
    expect(d.length).toBeGreaterThanOrEqual(5);
    expect(d.every((b) => typeof b.count === 'number')).toBe(true);
    for (let i = 1; i < d.length; i++) {
      expect(d[i]!.bucket).not.toBe(d[i - 1]!.bucket);
    }
  });

  it('满分非正数的样本被排除在分箱外，而不是硬塞进某一箱', () => {
    const d = buildDistribution([
      { total: 0, fullTotal: 0 },
      { total: 80, fullTotal: 100 },
    ]);
    expect(d.reduce((a, b) => a + b.count, 0)).toBe(1);
  });
});

/* ══════════════════════════════════════════════ 失分点聚合 */

describe('buildLossRanking：高频失分点', () => {
  it('空输入返回空数组', () => {
    expect(buildLossRanking([])).toEqual([]);
  });

  it('按出现次数降序排列', () => {
    const r = buildLossRanking([
      { missedPoints: ['代入计算', '单位'] },
      { missedPoints: ['代入计算'] },
      { missedPoints: ['代入计算', '作图'] },
    ]);
    expect(r[0]!.point).toBe('代入计算');
    expect(r[0]!.count).toBe(3);
    expect(r[1]!.count).toBe(1);
  });

  it('★ 同一次作答里重复的失分点只算一次 —— 否则一道题的权重被重复计算', () => {
    const r = buildLossRanking([{ missedPoints: ['单位', '单位', '单位'] }]);
    expect(r[0]!.count).toBe(1);
  });

  it('空白失分点被忽略（空串不是"一个失分点"）', () => {
    const r = buildLossRanking([{ missedPoints: ['', '  ', '单位'] }]);
    expect(r).toHaveLength(1);
    expect(r[0]!.point).toBe('单位');
  });

  it('次数相同的按名称稳定排序（保证导出可重复）', () => {
    const a = buildLossRanking([{ missedPoints: ['甲', '乙'] }]);
    const b = buildLossRanking([{ missedPoints: ['乙', '甲'] }]);
    expect(a).toEqual(b);
  });

  it('★ 长尾不截断，但调用方可限制条数 —— 截断必须由调用方显式决定', () => {
    /*
     * 为什么不在本函数里默认截断：高频失分点是改提示词/讲评的主要依据，
     * 一个"只显示前 10 条"的默认值会让第 11 条永远不被看见。
     * 若要截断，调用方传 maxCount 并自行决定。
     */
    const many = Array.from({ length: 30 }, (_, i) => ({ missedPoints: [`点${i}`] }));
    expect(buildLossRanking(many)).toHaveLength(30);
    expect(buildLossRanking(many, 10)).toHaveLength(10);
  });
});

/* ══════════════════════════════════════════════ 分层统计 */

describe('stratifiedByType：按题型分层', () => {
  it('空输入返回空数组', () => {
    expect(stratifiedByType([], META)).toEqual([]);
  });

  it('★ 按题型分层，且题型之间不混算', () => {
    const rows = [
      mkDetail({ questionId: 'Q1', type: 'choice', score: 5, fullScore: 5 }),
      mkDetail({ questionId: 'Q2', type: 'short', score: 5, fullScore: 10 }),
    ];
    const s = stratifiedByType(rows, META);
    const choice = s.find((x) => x.type === 'choice')!;
    const short = s.find((x) => x.type === 'short')!;
    expect(choice.avgScoreRate).toBe(1);
    expect(short.avgScoreRate).toBe(0.5);
  });

  it('★ 只包含**实际出现过**的题型，不凭空补 0 行', () => {
    /*
     * 一份卷子没有判断题，就不该在分层表里显示"判断：平均得分率 0%"。
     * 那会让人以为全班判断题全错 —— 而实际是根本没这题型。
     */
    const s = stratifiedByType([mkDetail({ type: 'choice', questionId: 'Q1' })], META);
    expect(s.map((x) => x.type)).toEqual(['choice']);
  });

  it('每个分层的样本数如实统计', () => {
    const rows = [
      mkDetail({ questionId: 'Q1', type: 'choice' }),
      mkDetail({ questionId: 'Q1', type: 'choice' }),
      mkDetail({ questionId: 'Q2', type: 'short' }),
    ];
    const s = stratifiedByType(rows, META);
    expect(s.find((x) => x.type === 'choice')!.count).toBe(2);
    expect(s.find((x) => x.type === 'short')!.count).toBe(1);
  });

  it('★ 需复核率也分层统计 —— 否则无法判断"哪类题最不可靠"', () => {
    const rows = [
      mkDetail({ questionId: 'Q1', type: 'choice', reviewRequested: true }),
      mkDetail({ questionId: 'Q1', type: 'choice', reviewRequested: false }),
      mkDetail({ questionId: 'Q2', type: 'short', reviewRequested: true }),
    ];
    const s = stratifiedByType(rows, META);
    expect(s.find((x) => x.type === 'choice')!.reviewRate).toBe(0.5);
    expect(s.find((x) => x.type === 'short')!.reviewRate).toBe(1);
  });

  it('满分非正数的样本不计入分子也不计入分母（避免除零与假数据）', () => {
    const rows = [mkDetail({ questionId: 'Q1', type: 'choice', score: 0, fullScore: 0 })];
    const s = stratifiedByType(rows, META);
    expect(s.find((x) => x.type === 'choice')!.avgScoreRate).toBeNull();
  });

  it('★ 分层按题型，绝不合并成"总体准确率" —— 客观题与主观题不可合并', () => {
    /*
     * SPEC §1.1：客观题是确定性比对，主观题是统计一致性，
     * **永远不要合并成一个"准确率"数字**。
     * 这里的分层结果必须是可分别引用的，不能只有一个总和。
     */
    const rows = [
      mkDetail({ questionId: 'Q1', type: 'choice', score: 5, fullScore: 5 }),
      mkDetail({ questionId: 'Q2', type: 'short', score: 5, fullScore: 10 }),
    ];
    const s = stratifiedByType(rows, META);
    expect(s).toHaveLength(2);
  });
});

/* ══════════════════════════════════════════════ 整体组装 */

describe('aggregatePaper：组装成 PaperReport', () => {
  const input: AggregateInput = {
    paperId: 'P1',
    paperTitle: '第一次月考',
    results: [mkStudent({ submissionId: 'S1' }), mkStudent({ submissionId: 'S2', name: '李四' })],
    questionsMeta: META,
    now: () => 1_700_000_000_000,
  };

  it('★ 无答卷时统计字段为 null，而不是 0 —— 界面要能说"还没有数据"', () => {
    const r = aggregatePaper({ ...input, results: [] });
    expect(r.stats.count).toBe(0);
    expect(r.stats.average).toBeNull();
    expect(r.stats.max).toBeNull();
    expect(r.stats.min).toBeNull();
    expect(r.stats.passRate).toBeNull();
    expect(r.stats.distribution).toEqual([]);
  });

  it('有答卷时各统计字段齐全', () => {
    const r = aggregatePaper(input);
    expect(r.stats.count).toBe(2);
    expect(r.stats.average).not.toBeNull();
    expect(r.stats.distribution.length).toBeGreaterThan(0);
  });

  it('★ 分层统计与失分点聚合都在报告里（F3.6 / F4.1 的落点）', () => {
    const r = aggregatePaper(input);
    expect(r.stats.byType.length).toBeGreaterThan(0);
  });

  it('失分点从明细里聚合出来', () => {
    const r = aggregatePaper({
      ...input,
      results: [
        mkStudent({}, [mkDetail({ missedPoints: ['单位'] })]),
        mkStudent({ submissionId: 'S2' }, [mkDetail({ missedPoints: ['单位'] })]),
      ],
    });
    expect(r.stats.lossRanking[0]).toEqual({ point: '单位', count: 2 });
  });

  it('paperId / paperTitle / generatedAt 原样带入', () => {
    const r = aggregatePaper(input);
    expect(r.paperId).toBe('P1');
    expect(r.paperTitle).toBe('第一次月考');
    expect(r.generatedAt).toBe(1_700_000_000_000);
  });

  it('★ 不修改入参（纯函数）—— 教师数据不能被"顺手"改动', () => {
    const before = JSON.stringify(input.results);
    aggregatePaper(input);
    expect(JSON.stringify(input.results)).toBe(before);
  });

  it('★ numberValid=false 时 average 仍给出，但问题被显式暴露', () => {
    /*
     * 不把 average 抹成 null：教师仍然需要看到算出来的数字才能定位问题。
     * 但 `numberValid=false` 必须让界面加上警告 —— 给出数字而不说明
     * 它不可信，正是 §6.1 那类静默失败。
     */
    const r = aggregatePaper({
      ...input,
      results: [mkStudent({ submissionId: 'S1', total: 120, fullTotal: 100 })],
    });
    expect(r.stats.average).not.toBeNull();
    expect(r.stats.numberValid).toBe(false);
  });

  it('★ 缺题型的明细不参与分层（题型是分层的唯一依据）', () => {
    const r = aggregatePaper({
      ...input,
      results: [mkStudent({}, [mkDetail({ type: 'choice', questionId: 'Q9' })])],
    });
    // Q9 的题干信息不在 META 里，但题型来自明细本身，仍应能分层
    expect(r.stats.byType.map((x) => x.type)).toContain('choice');
  });
});