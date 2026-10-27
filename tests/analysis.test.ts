import { describe, expect, it } from 'vitest';
import {
  type AdviceCode,
  buildTeachingAdvice,
  describeStatsProblems,
  adviceSummary,
} from '../src/renderer/analysis';
import type { PaperStats, StratifiedStat } from '../src/shared/types';

/*
 * 学情分析建议生成（F4.1）。
 *
 * 本模块最重要的一条纪律：**每条建议都必须能追溯到具体的数据点。**
 * 一个编造的"建议多练习"不只是无用，它会让老师误以为软件真的看出了
 * 什么，从而把注意力挪到不存在的问题上 —— 与 §6.4 的"界面在说谎"同类。
 */

function mkStats(p: Partial<PaperStats> = {}): PaperStats {
  return {
    count: 30,
    average: 21,
    max: 25,
    min: 12,
    passRate: 0.8,
    fullTotal: 25,
    mixedFullScore: false,
    numberValid: true,
    distribution: [
      { bucket: '0~59%', count: 2 },
      { bucket: '60~69%', count: 3 },
      { bucket: '70~79%', count: 8 },
      { bucket: '80~89%', count: 12 },
      { bucket: '90~100%', count: 5 },
    ],
    lossRanking: [
      { point: '单位未写', count: 12 },
      { point: '公式套错', count: 7 },
    ],
    byType: [
      { type: 'calc', count: 30, avgScoreRate: 0.68, reviewRate: 0.1 },
      { type: 'short', count: 30, avgScoreRate: 0.85, reviewRate: 0.05 },
    ],
    ...p,
  };
}

function mkType(p: Partial<StratifiedStat> & { type: StratifiedStat['type'] }): StratifiedStat {
  return { count: 30, avgScoreRate: 0.7, reviewRate: 0.1, ...p };
}

const codes = (s: PaperStats): AdviceCode[] => buildTeachingAdvice(s).map((a) => a.code);

/* ══════════════════════════════════════════════ 空与不足 */

describe('★ 数据不足时不下结论', () => {
  it('零答卷 → 明确说"还没有数据"，且不产出任何依赖数据的建议', () => {
    const a = buildTeachingAdvice(mkStats({ count: 0, average: null, max: null, min: null, passRate: null, distribution: [], lossRanking: [], byType: [] }));
    const c = a.map((x) => x.code);
    expect(c).toContain('no_data');
    // ★ 不能凭"没有数据"推断出"学生薄弱环节"之类
    expect(c).not.toContain('weak_type');
    expect(c).not.toContain('top_loss');
    expect(c).not.toContain('polarized');
  });

  it('★ 样本太少（< 5 份）→ 提示样本不足，且**不**据此推荐教学动作', () => {
    const a = buildTeachingAdvice(mkStats({ count: 3 }));
    const c = a.map((x) => x.code);
    expect(c).toContain('insufficient_sample');
    // 三份卷子的得分率不构成"这个题型是薄弱环节"的依据
    expect(c).not.toContain('weak_type');
  });

  it('恰好 5 份 → 视为可下结论（边界）', () => {
    expect(codes(mkStats({ count: 5 }))).not.toContain('insufficient_sample');
  });

  it('恰好 4 份 → 仍判样本不足（边界）', () => {
    expect(codes(mkStats({ count: 4 }))).toContain('insufficient_sample');
  });
});

/* ══════════════════════════════════════════════ 数据可信度优先 */

describe('★ 数据可信度问题必须排在建议最前面', () => {
  it('总分超满分 → 第一条就是"数据不可信"', () => {
    const a = buildTeachingAdvice(mkStats({ numberValid: false }));
    expect(a[0]!.code).toBe('data_unreliable');
    expect(a[0]!.severity).toBe('high');
  });

  it('满分混合 → 也报数据可信度问题', () => {
    const a = buildTeachingAdvice(mkStats({ mixedFullScore: true }));
    expect(a.some((x) => x.code === 'data_unreliable')).toBe(true);
  });

  it('★★ 数据不可信时，不再给出"哪个题型薄弱"这类结论', () => {
    /*
     * 这是本模块最关键的一条。数字本身算错了，还基于它推荐教学重点，
     * 等于把老师的注意力引向一个不存在的问题 —— 比什么都不说更糟。
     */
    const s = mkStats({ numberValid: false });
    const c = codes(s);
    expect(c).toContain('data_unreliable');
    expect(c).not.toContain('weak_type');
  });
});

/* ══════════════════════════════════════════════ 分层解读 */

describe('分层统计解读（按题型，不合并为单一准确率）', () => {
  it('★ 得分率明显偏低的题型被点出来，并带上具体数字作为依据', () => {
    const a = buildTeachingAdvice(mkStats());
    const w = a.find((x) => x.code === 'weak_type');
    expect(w).toBeDefined();
    // 证据里必须出现真实数字，不能是空话
    expect(w!.evidence).toContain('68');
    expect(w!.evidence).toContain('计算');
  });

  it('★ 绝不合并成一个总体准确率（SPEC §1.1）', () => {
    /*
     * 只检查 title / evidence —— 那是**真正产出的结论**。
     *
     * 第一版连 detail 一起查，结果抓到了我自己写的口径声明
     * （"不与客观题合并成一个总体准确率"）。把禁止词用在解释性文案上
     * 是合理的，被断言误伤说明断言的口径太粗。
     */
    const a = buildTeachingAdvice(mkStats());
    for (const x of a) {
      expect(x.title).not.toContain('准确率');
      expect(x.evidence).not.toContain('准确率');
    }
  });

  it('★ 关于"不合并"的口径说明必须出现在分层建议里（读者要知道边界）', () => {
    const w = buildTeachingAdvice(mkStats()).find((x) => x.code === 'weak_type');
    expect(w).toBeDefined();
    expect(w!.detail).toContain('分层');
  });

  it('全部题型都很好 → 不硬找薄弱项', () => {
    const c = codes(
      mkStats({
        byType: [mkType({ type: 'calc', avgScoreRate: 0.92 }), mkType({ type: 'short', avgScoreRate: 0.88 })],
      }),
    );
    expect(c).not.toContain('weak_type');
  });

  it('自评满分（avgScoreRate 为 null）不参与薄弱判定，也不崩', () => {
    const s = mkStats({ byType: [mkType({ type: 'calc', avgScoreRate: null })] });
    const c = codes(s);
    expect(c).not.toContain('weak_type');
    expect(() => buildTeachingAdvice(s)).not.toThrow();
  });

  it('★ 只有一个题型时也能判定薄弱（不因缺少对比就不报）', () => {
    const s = mkStats({ byType: [mkType({ type: 'essay', avgScoreRate: 0.4 })] });
    expect(codes(s)).toContain('weak_type');
  });
});

/* ══════════════════════════════════════════════ 失分点 */

describe('高频失分点解读', () => {
  it('★ 最高频失分点被点出，并带上出现次数', () => {
    const a = buildTeachingAdvice(mkStats());
    const t = a.find((x) => x.code === 'top_loss');
    expect(t).toBeDefined();
    expect(t!.evidence).toContain('单位未写');
    expect(t!.evidence).toContain('12');
  });

  it('没有失分点数据 → 不编造', () => {
    expect(codes(mkStats({ lossRanking: [] }))).not.toContain('top_loss');
  });

  it('★ 同一失分点的集中度被量化（占比可直接判断是否值得讲评）', () => {
    const t = buildTeachingAdvice(mkStats()).find((x) => x.code === 'top_loss')!;
    // 12/30 = 40% —— 数字必须出现在证据里，老师才能自己判断
    expect(t.evidence).toContain('40');
  });
});

/* ══════════════════════════════════════════════ 两极分化 */

describe('成绩分布解读', () => {
  it('★ 两端都有较多学生 → 报"两极分化"（讲评策略不同）', () => {
    const s = mkStats({
      distribution: [
        { bucket: '0~59%', count: 10 },
        { bucket: '60~69%', count: 5 },
        { bucket: '70~79%', count: 5 },
        { bucket: '80~89%', count: 5 },
        { bucket: '90~100%', count: 10 },
      ],
    });
    expect(codes(s)).toContain('polarized');
  });

  it('集中在中段 → 报"成绩集中"，不误报分化', () => {
    const s = mkStats({
      distribution: [
        { bucket: '0~59%', count: 1 },
        { bucket: '60~69%', count: 5 },
        { bucket: '70~79%', count: 18 },
        { bucket: '80~89%', count: 5 },
        { bucket: '90~100%', count: 1 },
      ],
    });
    const c = codes(s);
    expect(c).toContain('concentrated');
    expect(c).not.toContain('polarized');
  });

  it('★ 及格率偏低 → 单独报，且给出归一化口径的说明', () => {
    const a = buildTeachingAdvice(mkStats({ passRate: 0.35 }));
    const p = a.find((x) => x.code === 'low_pass_rate');
    expect(p).toBeDefined();
    expect(p!.detail).toContain('得分率');
  });

  it('分布为空（无法分箱）→ 不据此编造结论', () => {
    const c = codes(mkStats({ distribution: [] }));
    expect(c).not.toContain('polarized');
    expect(c).not.toContain('concentrated');
  });
});

/* ══════════════════════════════════════════════ 复核提示 */

describe('复核率解读', () => {
  it('★ 复核率偏高 → 提示先解决"分数可信度"再谈学情', () => {
    const s = mkStats({
      byType: [mkType({ type: 'calc', avgScoreRate: 0.7, reviewRate: 0.45 })],
    });
    expect(codes(s)).toContain('high_review_rate');
  });

  it('复核率正常 → 不报', () => {
    expect(codes(mkStats())).not.toContain('high_review_rate');
  });

  it('★ 复核率高时明确说明"这些分数还没确认"，避免被当定论', () => {
    const s = mkStats({ byType: [mkType({ type: 'calc', reviewRate: 0.5 })] });
    const r = buildTeachingAdvice(s).find((x) => x.code === 'high_review_rate')!;
    expect(r.detail).toMatch(/确认|复核/);
  });
});

/* ══════════════════════════════════════════════ 结构 */

describe('建议的输出契约', () => {
  it('每条建议都有 code / severity / title / detail / evidence', () => {
    for (const a of buildTeachingAdvice(mkStats())) {
      expect(a.code).toBeTruthy();
      expect(['high', 'medium', 'low']).toContain(a.severity);
      expect(a.title.trim().length).toBeGreaterThan(0);
      expect(a.detail.trim().length).toBeGreaterThan(0);
      expect(a.evidence.trim().length).toBeGreaterThan(0);
    }
  });

  it('★ evidence 必须是具体数据，不是"建议多练习"这种空话', () => {
    for (const a of buildTeachingAdvice(mkStats())) {
      // 每条证据都必须含数字，否则它就不是"依据"
      expect(a.evidence).toMatch(/\d/);
    }
  });

  it('按 severity 排序：high 在前', () => {
    const a = buildTeachingAdvice(mkStats({ numberValid: false, passRate: 0.3 }));
    const order = { high: 0, medium: 1, low: 2 };
    for (let i = 1; i < a.length; i++) {
      expect(order[a[i]!.severity]).toBeGreaterThanOrEqual(order[a[i - 1]!.severity]);
    }
  });

  it('不修改入参', () => {
    const s = mkStats();
    const snapshot = JSON.stringify(s);
    buildTeachingAdvice(s);
    expect(JSON.stringify(s)).toBe(snapshot);
  });

  it('数据完整时不产出任何数据类告警（避免狼来了）', () => {
    const c = codes(mkStats({ byType: [mkType({ type: 'calc', avgScoreRate: 0.5 })] }));
    expect(c).not.toContain('data_unreliable');
    expect(c).not.toContain('no_data');
    expect(c).not.toContain('insufficient_sample');
  });
});

/* ══════════════════════════════════════════════ 汇总与问题描述 */

describe('adviceSummary / describeStatsProblems', () => {
  it('★ 汇总里不出现"准确率"这个词（客观与主观不合并）', () => {
    const s = adviceSummary(mkStats());
    expect(s).not.toContain('准确率');
  });

  it('汇总包含答卷数', () => {
    expect(adviceSummary(mkStats())).toContain('30');
  });

  it('describeStatsProblems 在数据无问题时返回空', () => {
    expect(describeStatsProblems(mkStats())).toEqual([]);
  });

  it('★ describeStatsProblems 与 buildTeachingAdvice 的可信度判断一致', () => {
    const bad = mkStats({ numberValid: false });
    expect(describeStatsProblems(bad).length).toBeGreaterThan(0);
    expect(buildTeachingAdvice(bad)[0]!.code).toBe('data_unreliable');
  });
});