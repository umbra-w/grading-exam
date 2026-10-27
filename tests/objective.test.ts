/**
 * 客观题本地比对单测 —— 对应 PLAN v2.0 P5-2 / P5-3。
 *
 * 为什么这个模块值得最严格的测试：
 *   它是整条链路里**唯一不经过 AI 的判定**，因此也是唯一"错了没人兜底"的判定。
 *   主观题判歪了，教师看评语能发现；客观题静默判错，成绩单上什么异常都没有。
 *
 * 本文件的三类用例对应三类真实伤害：
 *   1. 正确性：常见等价写法必须判对（否则学生申诉）
 *   2. **安全性**：不该判对的一律不得判对（否则成绩虚高且无人发现）
 *   3. 零网络：断言比对过程不触发任何网络请求（P5-2 的验收条件）
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  toHalfWidth,
  stripInvisible,
  normalizeAnswer,
  isBlank,
  compareObjective,
  matchOptionLetter,
  compareBatch,
  type BatchItem,
} from '@shared/objective';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('全角转半角', () => {
  it('转换全角 ASCII 变体：数字、字母、括号', () => {
    expect(toHalfWidth('ＡＢＣ１２３')).toBe('ABC123');
    expect(toHalfWidth('（１２）')).toBe('(12)');
  });

  it('**不转 `！` `？`** —— 它们本身就是中文标点(全角感叹/问号)，不是 ASCII 变体', () => {
    // U+FF01 / U+FF1F 属中文标点体系，转成 ! ? 会改变语义（尤其语文科目）
    expect(toHalfWidth('真的吗？好！')).toBe('真的吗？好！');
  });

  it('不转全角逗号/句号/分号/冒号', () => {
    expect(toHalfWidth('一，二。三；四：五')).toBe('一，二。三；四：五');
  });

  it('全角空格转普通空格', () => {
    expect(toHalfWidth('a\u3000b')).toBe('a b');
  });

  it('不动中文文字', () => {
    expect(toHalfWidth('碳酸钙')).toBe('碳酸钙');
  });

  it('**不动中文标点** —— 语文答案里标点可能是答案的一部分', () => {
    // 「，」U+FF0C 落在全角区间内，但绝不能转成 ','
    // 否则「他说，好」这类答案会被破坏
    expect(toHalfWidth('他说，好。')).toBe('他说，好。');
  });
});

describe('不可见字符清除', () => {
  it('清除零宽字符', () => {
    expect(stripInvisible('a\u200bb')).toBe('ab');
    expect(stripInvisible('a\ufeffb')).toBe('ab');
  });

  it('清除 PDF 软连字符', () => {
    expect(stripInvisible('碳\u00ad酸钙')).toBe('碳酸钙');
  });

  it('保留制表与换行（它们是可见的排版信息）', () => {
    expect(stripInvisible('a\tb\nc')).toBe('a\tb\nc');
  });

  it('清除 C0 控制字符', () => {
    expect(stripInvisible('a\u0001b')).toBe('ab');
  });
});

describe('答案归一化', () => {
  it('默认忽略大小写与空白', () => {
    expect(normalizeAnswer('  Apple  Pie ')).toBe('applepie');
  });

  it('可保留大小写 —— 化学符号 "Co" 与 "CO" 是不同物质', () => {
    expect(normalizeAnswer('Co', { ignoreCase: false })).toBe('Co');
    expect(normalizeAnswer('CO', { ignoreCase: false })).toBe('CO');
    expect(normalizeAnswer('Co', { ignoreCase: false })).not.toBe(
      normalizeAnswer('CO', { ignoreCase: false }),
    );
  });

  it('统一常见中英标点变体（只在比对时，不改原文）', () => {
    expect(normalizeAnswer('他说：好')).toBe(normalizeAnswer('他说:好'));
    expect(normalizeAnswer('（3）')).toBe(normalizeAnswer('(3)'));
  });

  it('不忽略空白时也要收敛连续空白', () => {
    expect(normalizeAnswer('a  b', { ignoreSpace: false })).toBe('a b');
    expect(normalizeAnswer(' a b ', { ignoreSpace: false })).toBe('a b');
  });

  it('空答案归一化后仍为空 —— 全角空格/零宽字符不算内容', () => {
    expect(isBlank('')).toBe(true);
    expect(isBlank('   ')).toBe(true);
    expect(isBlank('\u3000')).toBe(true);
    expect(isBlank('\u200b\ufeff')).toBe(true);
    expect(isBlank('a')).toBe(false);
  });
});

describe('比对：判对的情形', () => {
  it('完全一致', () => {
    const r = compareObjective('3.14', '3.14');
    expect(r.verdict).toBe('correct');
    expect(r.awarded).toBe(true);
    expect(r.needsReview).toBe(false);
  });

  it('大小写与空白差异不影响判定', () => {
    expect(compareObjective('  Apple ', 'apple').awarded).toBe(true);
    expect(compareObjective('A B', 'ab').awarded).toBe(true);
  });

  it('全角输入判对 —— 中文输入法手滑是最常见的"看起来一样却判错"', () => {
    expect(compareObjective('３．１４', '3.14').awarded).toBe(true);
    expect(compareObjective('（３）', '(3)').awarded).toBe(true);
  });

  it('带不可见字符判对 —— 复制粘贴常见', () => {
    expect(compareObjective('3.14\u200b', '3.14').awarded).toBe(true);
    expect(compareObjective('\ufeff碳酸钙', '碳酸钙').awarded).toBe(true);
  });

  it('备选答案判对并说明来源', () => {
    const r = compareObjective('三', '3', { acceptable: ['三', '叁'] });
    expect(r.verdict).toBe('correct_alt');
    expect(r.awarded).toBe(true);
    expect(r.reason).toContain('备选答案');
  });

  it('中文标点差异判对', () => {
    expect(compareObjective('他说，好', '他说,好').awarded).toBe(true);
  });
});

describe('比对：绝不能判对的情形（安全性）', () => {
  it('**空标准答案不得给分** —— 否则整题所有学生全对', () => {
    const r = compareObjective('随便写的', '');
    expect(r.awarded).toBe(false);
    expect(r.needsReview).toBe(true);
    expect(r.reason).toContain('标准答案为空');
  });

  it('**空学生答案不得给分**，哪怕标准答案也是空', () => {
    expect(compareObjective('', '').awarded).toBe(false);
    expect(compareObjective('   ', '').awarded).toBe(false);
    expect(compareObjective('\u3000', '').awarded).toBe(false);
  });

  it('**只由不可见字符组成的学生答案不得给分**', () => {
    // 看起来"有内容"（零宽字符占位），但学生实际没作答
    expect(compareObjective('\u200b\u200b', '3.14').awarded).toBe(false);
  });

  it('未作答与做错区分开 —— 缺考率与错误率是两回事', () => {
    expect(compareObjective('', '3.14').verdict).toBe('blank');
    expect(compareObjective('2.71', '3.14').verdict).toBe('wrong');
  });

  it('空答案不会命中备选答案', () => {
    const r = compareObjective('', '3', { acceptable: ['三', ''] });
    expect(r.awarded).toBe(false);
  });

  it('近似但不同不得判对', () => {
    expect(compareObjective('3.1', '3.14').awarded).toBe(false);
    expect(compareObjective('碳酸钙啊', '碳酸钙').awarded).toBe(false);
  });
});

describe('比对：疑似情形', () => {
  it('学生写选项内容而非字母 → 判 suspect 且**不给分**', () => {
    const r = compareObjective('二氧化碳', 'B', {
      optionText: { A: '氧气', B: '二氧化碳', C: '氮气' },
    });
    expect(r.verdict).toBe('suspect');
    expect(r.awarded).toBe(false);
    expect(r.needsReview).toBe(true);
    // 必须告诉教师"学生写的是什么、对应哪个选项"，否则无从确认
    expect(r.reason).toContain('B');
    expect(r.reason).toContain('二氧化碳');
  });

  it('写选项内容但选项文字本身等于标准答案时，按精确一致判对', () => {
    // 标准答案就是「二氧化碳」，学生也写「二氧化碳」→ 无歧义，直接判对
    const r = compareObjective('二氧化碳', '二氧化碳', {
      optionText: { A: '氧气', B: '二氧化碳' },
    });
    expect(r.verdict).toBe('correct');
    expect(r.awarded).toBe(true);
  });
});

describe('选项字母反查', () => {
  const OPTIONS = { A: '氧气', B: '二氧化碳', C: '氮气', D: '氢气' };

  it('唯一命中时返回字母', () => {
    expect(matchOptionLetter('二氧化碳', OPTIONS)).toEqual({ letter: 'B', ambiguous: false });
  });

  it('未命中返回 null 且不标歧义', () => {
    expect(matchOptionLetter('氦气', OPTIONS)).toEqual({ letter: null, ambiguous: false });
  });

  it('空输入返回 null', () => {
    expect(matchOptionLetter('', OPTIONS)).toEqual({ letter: null, ambiguous: false });
    expect(matchOptionLetter('\u3000', OPTIONS)).toEqual({ letter: null, ambiguous: false });
  });

  it('**两个选项文字相同时标记歧义** —— 自动判定必然出错，必须交给人工', () => {
    const r = matchOptionLetter('未知', { A: '未知', B: '未知', C: '已知' });
    expect(r.letter).toBeNull();
    expect(r.ambiguous).toBe(true);
  });
});

describe('批量比对', () => {
  const items: BatchItem[] = [
    { id: 'q1', student: '3.14', expected: '3.14' },
    { id: 'q2', student: '', expected: 'B' },
    { id: 'q3', student: 'A', expected: 'B' },
    { id: 'q4', student: '三', expected: '3' },
    { id: 'q5', student: '二氧化碳', expected: 'B' },
  ];

  it('统计各判定计数，blank 与 wrong 分开', () => {
    const s = compareBatch(items, {
      acceptable: ['三'],
      optionText: { A: '氧气', B: '二氧化碳' },
    });
    expect(s.total).toBe(5);
    expect(s.counts.correct).toBe(1);
    expect(s.counts.blank).toBe(1);
    expect(s.counts.wrong).toBe(1);
    expect(s.counts.correct_alt).toBe(1);
    expect(s.counts.suspect).toBe(1);
    expect(s.awardedCount).toBe(2);
  });

  it('需要复核的 id 被标出', () => {
    const s = compareBatch([{ id: 'q5', student: '二氧化碳', expected: 'B' }], {
      optionText: { B: '二氧化碳' },
    });
    expect(s.reviewIds).toEqual(['q5']);
  });

  it('每一项都带上自己的 id，便于回填到答卷', () => {
    const s = compareBatch(items);
    expect(s.results.map((r) => r.id)).toEqual(['q1', 'q2', 'q3', 'q4', 'q5']);
  });

  it('空数组不炸', () => {
    const s = compareBatch([]);
    expect(s.total).toBe(0);
    expect(s.awardedCount).toBe(0);
    expect(s.reviewIds).toEqual([]);
  });
});

describe('零网络（PLAN v2.0 P5-2 验收）', () => {
  it('**比对过程不得发起任何网络请求**', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    // XMLHttpRequest 不存在时 spyOn 会抛错（node 环境无此全局），
    // 所以先 stub 一个空壳再断言它没被调用——这样断言在任何环境下都有效。
    const xhrStub = vi.fn();
    vi.stubGlobal('XMLHttpRequest', xhrStub);

    const s = compareBatch(
      Array.from({ length: 200 }, (_, i) => ({
        id: `q${i}`,
        student: i % 3 === 0 ? '' : `答案${i}`,
        expected: `答案${i}`,
      })),
    );

    expect(s.total).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrStub).not.toHaveBeenCalled();
  });

  it('比对是纯函数：同样输入两次调用结果一致（客观题必须可复现）', () => {
    const a = compareObjective('ＡＢＣ １２３', 'abc123');
    const b = compareObjective('ＡＢＣ １２３', 'abc123');
    expect(a).toEqual(b);
    expect(a.awarded).toBe(true);
  });
});