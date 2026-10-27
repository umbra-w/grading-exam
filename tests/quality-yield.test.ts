import { describe, expect, it } from 'vitest';
import { gradeYield, ungradableResult } from '../src/main/page/quality';
import type { QualityReport } from '../src/main/page/quality';

/*
 * 闸门 → 评分结果 的转换。
 *
 * 为什么需要这个纯函数，而不是在适配器里现写：
 *   "图看不清"必须变成一份**显式的、可入复核队列的结果**。
 *   适配器里现写的话，这段映射逻辑就没法单测，而它决定的是
 *   "看不清楚的卷子会不会被静默打 0 分" —— 正是 §6.1 那类静默失败。
 *
 * 签名：ungradableResult(report, paperId, fullScore, promptHash)
 *       gradeYield(report, grade, paperId, fullScore, promptHash)
 */

const HASH = 'PROMPT_SET_HASH_DEMO';

function mkReport(over: Partial<QualityReport> = {}): QualityReport {
  return {
    verdict: 'ok',
    mustReview: false,
    shouldReview: false,
    devicePixelRatio: 1,
    effectiveWidth: 1200,
    effectiveHeight: 500,
    longestEdge: 1200,
    checks: { size: 'pass', blank: 'pass', aspect: 'pass' },
    reasons: [],
    advice: [],
    ...over,
  };
}

describe('ungradableResult', () => {
  it('产出 0 分、confidence 0、并要求复核', () => {
    const r = ungradableResult(mkReport({ verdict: 'too_small' }), 'MATH-CALC-0001', 10, HASH);
    expect(r.score).toBe(0);
    expect(r.confidence).toBe(0);
    expect(r.reviewRequested).toBe(true);
  });

  it('**不假装做过评分**：没有任何得分点被判定命中', () => {
    const r = ungradableResult(mkReport({ verdict: 'too_small' }), 'X', 10, HASH);
    // 若这里给出 hitPoints，界面会显示"命中了某点"，等于捏造评分过程
    expect(r.hitPoints).toEqual([]);
    expect(r.missedPoints).toEqual([]);
  });

  it('把所有质量问题都写进 warnings，不只第一条', () => {
    const r = ungradableResult(
      mkReport({ verdict: 'too_small', reasons: ['尺寸过小', '压缩率异常', '长宽比异常'] }),
      'X',
      10,
      HASH,
    );
    expect(r.warnings.length).toBe(3);
    expect(r.warnings.join()).toContain('压缩率异常');
  });

  it('comment 里带上处置建议（老师要知道怎么办，不只是"质量差"）', () => {
    const r = ungradableResult(
      mkReport({ verdict: 'too_small', reasons: ['尺寸过小'], advice: ['重新拾取题目区域'] }),
      'X',
      10,
      HASH,
    );
    expect(r.comment).toContain('重新拾取题目区域');
  });

  it('comment 里带上卷子标识与满分，便于从日志直接定位', () => {
    const r = ungradableResult(mkReport({ verdict: 'too_small' }), 'MATH-CALC-0001', 12.5, HASH);
    expect(r.comment).toContain('MATH-CALC-0001');
    expect(r.comment).toContain('12.5');
  });

  it('没有 reasons 时也要给出可读说明，不留空评论', () => {
    const r = ungradableResult(mkReport({ verdict: 'insufficient' }), 'X', 10, HASH);
    expect(r.comment.trim().length).toBeGreaterThan(0);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('带上提示词版本指纹：入复核队列的结果必须可回溯', () => {
    const r = ungradableResult(mkReport({ verdict: 'too_small' }), 'X', 10, HASH);
    expect(r.promptVersion).toBeTruthy();
    expect(r.promptHash).toBe(HASH);
  });
});

describe('gradeYield', () => {
  const good = mkReport();

  it('质量合格 → 用真实评分结果', () => {
    const g = { score: 7, comment: '好', promptHash: HASH, promptVersion: '1.0.0', warnings: [], confidence: 0.9 };
    const r = gradeYield(good, g, 'MATH-1', 10, HASH);
    expect(r.result).toBe(g);
    expect(r.poorImage).toBe(false);
    expect(r.blockedApiCall).toBe(false);
  });

  it('图片不合格 → 用不可评分结果，且真实评分被丢弃（**故意的**）', () => {
    /*
     * 为什么必须丢弃而不是"参考一下"：
     * 图看不清时模型给出的是猜测。把猜测留在队列"供参考"，
     * 复核的人会倾向于采信它，等于让一个不可靠的数字锚定了人。
     * 所以：宁可什么都不给，也不要给一个编的分。
     */
    const g = { score: 7, comment: '好', promptHash: HASH, promptVersion: '1.0.0', warnings: [], confidence: 0.95 };
    const r = gradeYield(mkReport({ verdict: 'mostly_blank' }), g, 'MATH-1', 10, HASH);
    expect(r.result).not.toBe(g);
    expect(r.result.score).not.toBe(7);
    expect(r.result.comment).not.toBe('好');
    expect(r.result.reviewRequested).toBe(true);
  });

  it('**只认 verdict**：报告里的 mustReview 字段与 verdict 矛盾时，以 verdict 为准', () => {
    /*
     * 这是本模块最关键的一条不变量。
     * mustReview 与 verdict 由不同代码路径产生，可能不同步。
     * 若下游信任字段，一个 verdict='too_small' 却 mustReview=false 的
     * 对象会让看不清的卷子被放行 —— 正是闸门要防的事。
     * 所以 gradeYield 从 MUST_REVIEW_VERDICTS 自己算。
     */
    const contradictory = mkReport({ verdict: 'too_small', mustReview: false, shouldReview: false });
    const g = { score: 9, comment: '满分', promptHash: HASH, promptVersion: '1.0.0', warnings: [], confidence: 0.99 };
    const r = gradeYield(contradictory, g, 'MATH-1', 10, HASH);
    expect(r.poorImage).toBe(true);
    expect(r.blockedApiCall).toBe(true);
    expect(r.result.score).toBe(0);
  });

  it('blockedApiCall：必须复核时标记"这次评分不该发生"', () => {
    const r = gradeYield(mkReport({ verdict: 'aspect_suspect' }), undefined, 'MATH-1', 10, HASH);
    expect(r.blockedApiCall).toBe(true);
  });

  it('没有真实评分（blocked 路径）+ 质量合格 → 如实报 blocked，不编结果', () => {
    // 不该出现的组合（合格图却没有结果），但不能静默返回一个假分
    const r = gradeYield(good, undefined, 'MATH-1', 10, HASH);
    expect(r.result.reviewRequested).toBe(true);
    expect(r.poorImage).toBe(true);
    expect(r.blockedApiCall).toBe(true);
    expect(r.result.warnings.join()).toContain('评分流程未产出结果');
  });

  it('poorImage 与 MUST_REVIEW_VERDICTS 严格对应，不依赖字段', () => {
    const mustReview = new Set(['too_small', 'mostly_blank', 'aspect_suspect', 'insufficient']);
    for (const v of ['ok', 'marginal', 'too_small', 'mostly_blank', 'aspect_suspect', 'insufficient'] as const) {
      // 故意把字段写成错的，验证判定仍由 verdict 决定
      const rep = mkReport({ verdict: v, mustReview: false, shouldReview: false });
      const r = gradeYield(rep, { score: 5, comment: 'x', promptHash: HASH, promptVersion: '1.0.0', warnings: [], confidence: 0.8 }, 'p', 10, HASH);
      expect(r.poorImage).toBe(mustReview.has(v));
    }
  });

  it('marginal（建议复核但不强制）不被当作图片不合格', () => {
    // marginal 的问题在"不够可靠"，不在"看不清"，两者处置不同：
    // 前者仍可自信地输出模型分并要求复核，后者必须拒绝给分
    const g = { score: 6, comment: '还行', promptHash: HASH, promptVersion: '1.0.0', warnings: [], confidence: 0.8 };
    const r = gradeYield(mkReport({ verdict: 'marginal', shouldReview: true }), g, 'p', 10, HASH);
    expect(r.result).toBe(g);
    expect(r.poorImage).toBe(false);
    expect(r.blockedApiCall).toBe(false);
  });

  it('分数保持原值，不做四舍五入或夹取 —— 那是 objective/ensemble 的职责', () => {
    // 这个函数只管"这张图能不能用"，不改分数。混进分数处理会让口径分叉
    const g = { score: 6.5, comment: 'c', promptHash: HASH, promptVersion: '1.0.0', warnings: [], confidence: 0.8 };
    expect(gradeYield(good, g, 'p', 10, HASH).result.score).toBe(6.5);
  });
});