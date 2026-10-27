import { describe, it, expect } from 'vitest';
import {
  normalizeMathString,
  parseMathExpression,
  verifyMathIntegrity,
} from '../src/main/ai/math-integrity';

describe('math-integrity (四则运算对账层 - sizhejisuan)', () => {
  describe('normalizeMathString', () => {
    it('规范化全角符号和空格', () => {
      expect(normalizeMathString(' 1 ＋ 2 ＝ 3 ')).toBe('1+2=3');
      expect(normalizeMathString('2加3等于5')).toBe('2+3=5');
    });

    it('空值保护', () => {
      expect(normalizeMathString('')).toBe('');
      // @ts-expect-error test invalid type
      expect(normalizeMathString(null)).toBe('');
    });
  });

  describe('parseMathExpression', () => {
    it('正确解析标准加法等式', () => {
      const res = parseMathExpression('1+2+2+0=5');
      expect(res).not.toBeNull();
      expect(res?.operands).toEqual([1, 2, 2, 0]);
      expect(res?.declaredResult).toBe(5);
      expect(res?.actualSum).toBe(5);
      expect(res?.isSelfConsistent).toBe(true);
    });

    it('正确解析浮点数加法', () => {
      const res = parseMathExpression('1.5 + 2.5 = 4.0');
      expect(res).not.toBeNull();
      expect(res?.operands).toEqual([1.5, 2.5]);
      expect(res?.actualSum).toBe(4);
      expect(res?.isSelfConsistent).toBe(true);
    });

    it('识别左右不相等的矛盾表达式', () => {
      const res = parseMathExpression('1+2=4');
      expect(res).not.toBeNull();
      expect(res?.actualSum).toBe(3);
      expect(res?.declaredResult).toBe(4);
      expect(res?.isSelfConsistent).toBe(false);
    });

    it('支持无等号的纯表达式', () => {
      const res = parseMathExpression('2+3+4');
      expect(res).not.toBeNull();
      expect(res?.operands).toEqual([2, 3, 4]);
      expect(res?.actualSum).toBe(9);
      expect(res?.isSelfConsistent).toBe(true);
    });

    it('非法表达式返回 null', () => {
      expect(parseMathExpression('abc')).toBeNull();
      expect(parseMathExpression('1+abc=3')).toBeNull();
      expect(parseMathExpression('1=2=3')).toBeNull();
    });
  });

  describe('verifyMathIntegrity', () => {
    it('完全一致时验证通过', () => {
      const r = verifyMathIntegrity({
        score: 5,
        subScores: [1, 2, 2, 0],
        mathExpression: '1+2+2+0=5',
      });
      expect(r.ok).toBe(true);
      expect(r.discrepancy).toBe(0);
      expect(r.reason).toBeUndefined();
    });

    it('捕获算式加和与总分不一致的幻觉', () => {
      const r = verifyMathIntegrity({
        score: 6, // 模型总分给了 6
        mathExpression: '1+2+2+0=5', // 但实际加和只有 5
      });
      expect(r.ok).toBe(false);
      expect(r.discrepancy).toBe(1);
      expect(r.suggestedScore).toBe(5);
      expect(r.reason).toContain('与总得分 (6) 不一致');
    });

    it('捕获小题列表和与总分不一致', () => {
      const r = verifyMathIntegrity({
        score: 7,
        subScores: [2, 2, 2], // 和为 6
      });
      expect(r.ok).toBe(false);
      expect(r.subSum).toBe(6);
      expect(r.suggestedScore).toBe(6);
      expect(r.reason).toContain('小题分列表求和 [2, 2, 2] = 6，与总得分 7 不一致');
    });

    it('捕获算式与小题列表矛盾', () => {
      const r = verifyMathIntegrity({
        score: 5,
        subScores: [2, 3], // 和为 5
        mathExpression: '1+2=3', // 算式和为 3
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('不一致');
    });

    it('仅传总分无辅助算式时默认通过', () => {
      const r = verifyMathIntegrity({
        score: 3,
      });
      expect(r.ok).toBe(true);
    });
  });
});
