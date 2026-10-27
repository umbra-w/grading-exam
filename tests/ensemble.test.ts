/**
 * 多次运行分歧度单测。
 *
 * 为什么这组测试特别重要：
 *   网络错误会报错（人能看到），**统计错误会静默地把不可靠的分数当成可靠**。
 *   所以这里重点覆盖三类边界：
 *     ① 只有一次运行绝不能判"一致"
 *     ② 一致但低置信度仍须复核（一致 ≠ 正确）
 *     ③ 分歧度必须归一化，高分值题不能被误判为不稳定
 */
import { describe, it, expect } from 'vitest';
import {
  median,
  stdDev,
  meanAbsDeviation,
  modeShare,
  summarizeScores,
  disagreementOf,
  judgeEnsemble,
  commonMisses,
  contradictoryPoints,
  temperatureForRun,
  mergeEnsemble,
  summarizeEnsemble,
  DEFAULT_ENSEMBLE,
} from '../src/main/ai/ensemble';
import type { GradeResult } from '@shared/types';

function g(over: Partial<GradeResult> = {}): GradeResult {
  return {
    score: 6,
    comment: '尚可',
    hitPoints: [],
    missedPoints: [],
    confidence: 0.9,
    reviewRequested: false,
    warnings: [],
    promptVersion: '1.0.0',
    promptHash: 'abc',
    ...over,
  };
}

/* --------------------------------------------------------- 统计 */

describe('median', () => {
  it('奇数个取中间', () => {
    expect(median([5.5, 7, 6])).toBe(6);
    expect(median([1])).toBe(1);
  });

  it('偶数个取中间两个的平均', () => {
    expect(median([6, 7])).toBe(6.5);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('★ 不受离群值影响（这是选它当建议分的原因）', () => {
    // 均值会被 10 拉高到 7.4
    expect(median([5, 6, 10])).toBe(6);
  });

  it('空数组返回 NaN（不是 0）', () => {
    expect(Number.isNaN(median([]))).toBe(true);
  });
});

describe('stdDev / meanAbsDeviation / modeShare', () => {
  it('全一致时标准差为 0', () => {
    expect(stdDev([6, 6, 6])).toBe(0);
  });

  it('已知标准差', () => {
    // [2,4,4,4,5,5,7,9] 总体标准差 = 2
    expect(stdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2, 10);
  });

  it('MAD 相对中位数', () => {
    expect(meanAbsDeviation([5, 6, 7], 6)).toBeCloseTo(0.6667, 3);
  });

  it('modeShare：全一致为 1', () => {
    expect(modeShare([6, 6, 6])).toBe(1);
  });

  it('modeShare：两个值各占一半为 0.5', () => {
    expect(modeShare([6, 6, 5, 5])).toBe(0.5);
  });

  it('modeShare：全不同时为 1/n', () => {
    expect(modeShare([5, 6, 7])).toBeCloseTo(1 / 3, 6);
  });

  it('空数组安全', () => {
    expect(Number.isNaN(stdDev([]))).toBe(true);
    expect(modeShare([])).toBe(0);
  });
});

describe('summarizeScores', () => {
  it('汇总已知分布', () => {
    const d = summarizeScores([5.5, 6, 6.5]);
    expect(d.n).toBe(3);
    expect(d.median).toBe(6);
    expect(d.min).toBe(5.5);
    expect(d.max).toBe(6.5);
    expect(d.range).toBe(1);
    expect(d.modeShare).toBeCloseTo(1 / 3, 6);
  });

  it('★ 过滤 NaN / Infinity（坏结果不能污染统计）', () => {
    const d = summarizeScores([6, NaN, 7, Infinity, 6]);
    expect(d.n).toBe(3);
    expect(d.scores.sort()).toEqual([6, 6, 7]);
  });

  it('全为坏值 → n=0 且各统计为 NaN', () => {
    const d = summarizeScores([NaN, Infinity]);
    expect(d.n).toBe(0);
    expect(Number.isNaN(d.median)).toBe(true);
  });
});

/* ------------------------------------------------------- 分歧度 */

describe('disagreementOf —— 必须归一化才能跨题比较', () => {
  it('全一致 → 分歧度 0', () => {
    expect(disagreementOf([6, 6, 6], 10)).toBe(0);
  });

  it('★ 完全矛盾（两极各半）→ 分歧度接近 1', () => {
    const d = disagreementOf([0, 10, 0, 10], 10);
    expect(d).toBeGreaterThan(0.7);
  });

  it('★ 同一相对离散度下，10 分制与 100 分制应给出相同分歧度', () => {
    // 这是归一化的核心价值：不归一化的话高分值题全被判为不稳定
    const low = disagreementOf([6, 7, 8], 10); // 极差 = 10%
    const high = disagreementOf([60, 70, 80], 100); // 极差 = 10%
    expect(low).toBeCloseTo(high, 6);
  });

  it('分歧随离散度单调不减', () => {
    const a = disagreementOf([6, 6, 6], 10);
    const b = disagreementOf([6, 6, 7], 10);
    const c = disagreementOf([5, 6, 7], 10);
    const d = disagreementOf([2, 6, 10], 10);
    expect(b).toBeGreaterThanOrEqual(a);
    expect(c).toBeGreaterThanOrEqual(b);
    expect(d).toBeGreaterThanOrEqual(c);
  });

  it('★ 单次运行返回 0（分歧无从判断，由调用方另加约束）', () => {
    expect(disagreementOf([6], 10)).toBe(0);
  });

  it('★ 无有效分数返回 1（保守：视为最大分歧）', () => {
    expect(disagreementOf([NaN], 10)).toBe(1);
  });

  it('fullScore 为 0 或负数时不产生 NaN / Infinity', () => {
    expect(Number.isFinite(disagreementOf([6, 7], 0))).toBe(true);
    expect(Number.isFinite(disagreementOf([6, 7], -5))).toBe(true);
  });

  it('结果始终落在 [0, 1]', () => {
    for (const scores of [[0, 100], [-50, 500], [1, 2, 3], [10, 10, 10]]) {
      const d = disagreementOf(scores, 10);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(1);
    }
  });
});

/* -------------------------------------------------------- 判定 */

describe('judgeEnsemble —— 一致性与处置', () => {
  it('★ 三次完全一致且高置信 → 一致 + 可进自动提交候选', () => {
    const v = judgeEnsemble([g({ score: 6 }), g({ score: 6 }), g({ score: 6 })], 10);
    expect(v.agreement).toBe('consistent');
    expect(v.disagreement).toBe(0);
    expect(v.suggestedScore).toBe(6);
    expect(v.requiresReview).toBe(false);
    expect(v.autoSubmitCandidate).toBe(true);
  });

  it('★★ 只有一次运行 → insufficient，且必须复核', () => {
    // 最重要的一条：不能把"没测过"当成"测过且通过"
    const v = judgeEnsemble([g({ score: 6 })], 10);
    expect(v.agreement).toBe('insufficient');
    expect(v.requiresReview).toBe(true);
    expect(v.autoSubmitCandidate).toBe(false);
    expect(v.rationale).toContain('无法判断');
  });

  it('★ 零次运行也安全（不抛异常，判需复核）', () => {
    const v = judgeEnsemble([], 10);
    expect(v.agreement).toBe('insufficient');
    expect(v.requiresReview).toBe(true);
  });

  it('★ 三次一致但低置信 → 一致但仍须复核（一致 ≠ 正确）', () => {
    const v = judgeEnsemble(
      [g({ score: 6, confidence: 0.4 }), g({ score: 6, confidence: 0.4 }), g({ score: 6, confidence: 0.4 })],
      10,
    );
    expect(v.agreement).toBe('consistent');
    expect(v.requiresReview).toBe(true);
    expect(v.autoSubmitCandidate).toBe(false);
    expect(v.warnings.join('')).toContain('一致 ≠ 正确');
  });

  it('小幅波动 → minor，不强制复核（若置信度够）', () => {
    const v = judgeEnsemble(
      [g({ score: 6, confidence: 0.9 }), g({ score: 6.5, confidence: 0.9 }), g({ score: 6, confidence: 0.9 })],
      10,
    );
    expect(v.agreement).toBe('minor');
    expect(v.suggestedScore).toBe(6);
    expect(v.requiresReview).toBe(false);
  });

  it('★ 严重矛盾 → 必须复核，且评语列出各次分数', () => {
    const v = judgeEnsemble([g({ score: 3 }), g({ score: 9 }), g({ score: 6 })], 10);
    expect(['major', 'contradictory']).toContain(v.agreement);
    expect(v.requiresReview).toBe(true);
    expect(v.autoSubmitCandidate).toBe(false);
    expect(v.rationale).toContain('3');
  });

  it('★ 建议分取中位数而非均值（抗离群）', () => {
    const v = judgeEnsemble([g({ score: 5 }), g({ score: 6 }), g({ score: 10 })], 10);
    expect(v.suggestedScore).toBe(6); // 均值是 7
  });

  it('★ 置信度取最小值，不用平均', () => {
    // 平均值会被自信的那次掩盖心虚的那次
    const v = judgeEnsemble(
      [g({ score: 6, confidence: 0.95 }), g({ score: 6, confidence: 0.95 }), g({ score: 6, confidence: 0.3 })],
      10,
    );
    expect(v.requiresReview).toBe(true); // 0.3 < 0.75
  });

  it('★ 100 分制题不会因为分值大就被误判为不稳定', () => {
    const v = judgeEnsemble(
      [g({ score: 60, confidence: 0.95 }), g({ score: 62, confidence: 0.95 }), g({ score: 60, confidence: 0.95 })],
      100,
    );
    expect(v.disagreement).toBeLessThan(DEFAULT_ENSEMBLE.disagreementThreshold);
    expect(v.requiresReview).toBe(false);
  });

  it('有效运行少于配置次数时给出警告', () => {
    const v = judgeEnsemble([g({ score: 6 }), { ...g({ score: NaN }) }], 10);
    expect(v.agreement).toBe('insufficient');
    expect(judgeEnsemble([g({ score: 6 }), g({ score: 6 }), { ...g({ score: NaN }) }], 10).warnings.join('')).toContain(
      '少于配置',
    );
  });

  it('★ 结果字段不含 NaN 的 suggestedScore（可用性保证）', () => {
    const v = judgeEnsemble([g({ score: 6 }), g({ score: 6 })], 10);
    expect(Number.isFinite(v.suggestedScore)).toBe(true);
  });

  it('分歧度阈值可配置（在 same 分数下改变判定）', () => {
    // 置信度统一给高值，隔离出"阈值"这一个变量。
    // 分数极差 4 分（归一化 0.4）已超出 minor 分支，因此判定完全由阈值决定：
    //   loose 阈值 0.99 → 分歧度(~0.4) < 0.99 → major
    //   strict 阈值 0.01 → 分歧度(~0.4) ≥ 0.01 → contradictory
    const mk = (s: number): GradeResult => g({ score: s, confidence: 0.95 });
    const scores = [2, 6, 6, 6];
    const loose = judgeEnsemble(scores.map(mk), 10, { disagreementThreshold: 0.99 });
    const strict = judgeEnsemble(scores.map(mk), 10, { disagreementThreshold: 0.01 });
    expect(loose.agreement).toBe('major');
    expect(strict.agreement).toBe('contradictory');
  });
});

/* ----------------------------------------------- 得分点级分析 */

describe('commonMisses —— 系统性盲区（单跑一次发现不了）', () => {
  it('★ 三次都漏同一点 → 判为共同盲区', () => {
    const r = [g({ missedPoints: ['单位'] }), g({ missedPoints: ['单位'] }), g({ missedPoints: ['单位'] })];
    expect(commonMisses(r)).toEqual(['单位']);
  });

  it('只有部分次漏 → 不算共同盲区', () => {
    const r = [g({ missedPoints: ['单位'] }), g({ missedPoints: [] }), g({ missedPoints: ['单位'] })];
    expect(commonMisses(r)).toEqual([]);
  });

  it('★ 少于两次运行不判定（无从谈"共同"）', () => {
    expect(commonMisses([g({ missedPoints: ['单位'] })])).toEqual([]);
  });

  it('重复出现的同一得分点只计一次', () => {
    const r = [g({ missedPoints: ['单位', '单位'] }), g({ missedPoints: ['单位'] })];
    expect(commonMisses(r)).toEqual(['单位']);
  });

  it('多个共同盲区全部列出', () => {
    const r = [g({ missedPoints: ['单位', '符号'] }), g({ missedPoints: ['单位', '符号'] })];
    expect(commonMisses(r).sort()).toEqual(['单位', '符号'].sort());
  });
});

describe('contradictoryPoints —— 互相矛盾的得分点', () => {
  it('★ 有人判命中、有人判未命中 → 矛盾', () => {
    const r = [g({ hitPoints: ['单位'] }), g({ missedPoints: ['单位'] })];
    expect(contradictoryPoints(r)).toEqual(['单位']);
  });

  it('一致命中不算矛盾', () => {
    const r = [g({ hitPoints: ['单位'] }), g({ hitPoints: ['单位'] })];
    expect(contradictoryPoints(r)).toEqual([]);
  });

  it('一致未命中不算矛盾（那是共同盲区）', () => {
    const r = [g({ missedPoints: ['单位'] }), g({ missedPoints: ['单位'] })];
    expect(contradictoryPoints(r)).toEqual([]);
  });
});

/* --------------------------------------------------- 温度与合并 */

describe('temperatureForRun', () => {
  it('按序取用', () => {
    expect(temperatureForRun(0, [0, 0.7, 1.0])).toBe(0);
    expect(temperatureForRun(2, [0, 0.7, 1.0])).toBe(1.0);
  });

  it('★ 超出长度时循环取用（不报错、不返回 undefined）', () => {
    expect(temperatureForRun(3, [0, 0.7])).toBe(0.7); // 3 % 2 = 1
    expect(temperatureForRun(4, [0, 0.7])).toBe(0); // 4 % 2 = 0
    expect(temperatureForRun(7, [0, 0.7])).toBe(0.7);
    expect(Number.isFinite(temperatureForRun(99, [0.5]))).toBe(true);
  });

  it('空温度数组回退到默认值', () => {
    expect(temperatureForRun(0, [])).toBe(0.7);
  });
});

describe('mergeEnsemble', () => {
  it('★ 合并后分数为中位数、置信度为最小值、复核标记来自判定', () => {
    const results = [
      g({ score: 5, confidence: 0.9, comment: 'a' }),
      g({ score: 6, confidence: 0.5, comment: 'b' }),
      g({ score: 10, confidence: 0.8, comment: 'c' }),
    ];
    const v = judgeEnsemble(results, 10);
    const merged = mergeEnsemble(results, v);
    expect(merged.score).toBe(6);
    expect(merged.confidence).toBe(0.5);
    expect(merged.reviewRequested).toBe(true);
  });

  it('★ 评语取分歧最小的那次，不缝合互相矛盾的评语', () => {
    const results = [
      g({ score: 6, comment: '贴题' }),
      g({ score: 3, comment: '完全跑题' }),
      g({ score: 9, comment: '优秀' }),
    ];
    const v = judgeEnsemble(results, 10);
    const merged = mergeEnsemble(results, v);
    expect(merged.score).toBe(6);
    expect(merged.comment).toBe('贴题'); // 与中位数最近的那次
  });

  it('★ 带上 ensemble 汇总，供复核界面展示证据', () => {
    const results = [g({ score: 6, missedPoints: ['单位'] }), g({ score: 6, missedPoints: ['单位'] })];
    const merged = mergeEnsemble(results, judgeEnsemble(results, 10));
    expect(merged.ensemble!.runs).toBe(2);
    expect(merged.ensemble!.scores).toEqual([6, 6]);
    expect(merged.ensemble!.commonMisses).toEqual(['单位']);
    expect(merged.ensemble!.agreement).toBe('consistent');
  });

  it('★ summarizeEnsemble 与 mergeEnsemble 写出的汇总一致（单一真源）', () => {
    const results = [g({ score: 5, hitPoints: ['步骤'] }), g({ score: 7, missedPoints: ['步骤'] })];
    const v = judgeEnsemble(results, 10);
    const direct = summarizeEnsemble(results, v);
    const merged = mergeEnsemble(results, v);
    expect(merged.ensemble).toEqual(direct);
    expect(direct.contradictoryPoints).toEqual(['步骤']);
  });

  it('全为坏结果时抛异常（不返回垃圾）', () => {
    const bad = [g({ score: NaN })];
    expect(() => mergeEnsemble(bad, judgeEnsemble(bad, 10))).toThrow();
  });

  it('保留原有警告并附加判定警告', () => {
    const results = [g({ score: 6, warnings: ['百分比已归一化'] }), g({ score: 6 })];
    const merged = mergeEnsemble(results, judgeEnsemble(results, 10));
    expect(merged.warnings).toContain('百分比已归一化');
  });
});