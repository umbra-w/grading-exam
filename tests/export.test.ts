import { describe, expect, it } from 'vitest';
import {
  buildMarkdown,
  buildWorkbookRows,
  fmtNum,
  fmtPct,
  statsWarnings,
} from '../src/main/io/export';
import { aggregatePaper } from '../src/main/io/paper';
import type { GradingDetail, StudentResult } from '../src/shared/types';

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

/* ══════════════════════════════════════════════ 空值呈现 */

describe('fmtNum / fmtPct：null 必须显示为「—」而不是 0', () => {
  it('★ null → 「—」。绝不能输出 0 —— 那会被读成"真的是 0 分"（§6.1）', () => {
    expect(fmtNum(null, 2)).toBe('—');
    expect(fmtPct(null)).toBe('—');
  });

  it('NaN / Infinity 也走「—」这条路（不是有效数字）', () => {
    expect(fmtNum(Number.NaN, 2)).toBe('—');
    expect(fmtPct(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('★ 0 是真实的值，必须显示成 0，不能与 null 混为一谈', () => {
    expect(fmtNum(0, 2)).toBe('0.00');
    expect(fmtPct(0)).toBe('0.0%');
  });

  it('正常数字按指定小数位输出', () => {
    expect(fmtNum(83.456, 2)).toBe('83.46');
    expect(fmtNum(83.456, 0)).toBe('83');
    expect(fmtPct(0.625)).toBe('62.5%');
  });
});

/* ══════════════════════════════════════════════ 数据问题提示 */

describe('statsWarnings：把数据问题翻译成人能看懂的话', () => {
  const base = aggregatePaper({
    paperId: 'P1',
    paperTitle: 'T',
    results: [mkStudent()],
  }).stats;

  it('一切正常时不产生警告（不要制造无谓的恐慌）', () => {
    expect(statsWarnings(base)).toEqual([]);
  });

  it('★ 无答卷 → 明确说"还没有任何答卷"，而不是给一堆 0%', () => {
    const st = aggregatePaper({ paperId: 'P1', paperTitle: 'T', results: [] }).stats;
    const w = statsWarnings(st);
    expect(w.some((x) => x.includes('还没有任何答卷'))).toBe(true);
  });

  it('★ 总分超满分 → 明说平均值不可信', () => {
    const st = aggregatePaper({
      paperId: 'P1',
      paperTitle: 'T',
      results: [mkStudent({ total: 120, fullTotal: 100 })],
    }).stats;
    const w = statsWarnings(st);
    expect(w.some((x) => x.includes('平均值不可信'))).toBe(true);
  });

  it('★ 满分混合 → 说明以哪个为基准，并声明汇总仅供参考', () => {
    const st = aggregatePaper({
      paperId: 'P1',
      paperTitle: 'T',
      results: [
        mkStudent({ submissionId: 'A', total: 90, fullTotal: 100 }),
        mkStudent({ submissionId: 'B', total: 9, fullTotal: 10 }),
        mkStudent({ submissionId: 'C', total: 80, fullTotal: 100 }),
      ],
    }).stats;
    const w = statsWarnings(st);
    expect(w.some((x) => x.includes('满分不一致'))).toBe(true);
    expect(w.some((x) => x.includes('100'))).toBe(true);
  });
});

/* ══════════════════════════════════════════════ Markdown 报告 */

describe('buildMarkdown：报告本身必须携带数据问题', () => {
  const normal = aggregatePaper({
    paperId: 'P1',
    paperTitle: '第一次月考',
    results: [
      mkStudent({ name: '张三', examNo: '001' }, [mkDetail({ missedPoints: ['单位'] })]),
      mkStudent({ submissionId: 'S2', name: '李四', examNo: '002' }, [mkDetail()]),
    ],
  });

  it('包含标题、生成时间与总览', () => {
    const md = buildMarkdown(normal);
    expect(md).toContain('第一次月考 阅卷报告');
    expect(md).toContain('## 总览');
    expect(md).toContain('参考人数');
    expect(md).toContain('2');
  });

  it('包含分数分布与高频失分点', () => {
    const md = buildMarkdown(normal);
    expect(md).toContain('## 分数分布');
    expect(md).toContain('## 高频失分点');
    expect(md).toContain('单位');
  });

  it('★ 包含分层统计，并写明客观题与主观题不合并', () => {
    const md = buildMarkdown(normal);
    expect(md).toContain('## 分层统计');
    // 这句是 SPEC §1.1 的边界，必须印在报告上
    expect(md).toContain('不合并');
  });

  it('★ 无答卷时报告写明"还没有任何答卷"，而不是给一排 0', () => {
    /*
     * 这份 Markdown 会被转发、存档、当依据。
     * 读它的人看不到界面提示 —— 所以警告必须随数字一起走。
     */
    const empty = aggregatePaper({ paperId: 'P1', paperTitle: '没导过的卷', results: [] });
    const md = buildMarkdown(empty);
    expect(md).toContain('还没有任何答卷');
    expect(md).toContain('—');
    // 绝不能把无数据渲染成 0 分
    expect(md).not.toContain('| 平均分 | 0.00 |');
  });

  it('★ 数据有问题时加一条醒目警告块', () => {
    const bad = aggregatePaper({
      paperId: 'P1',
      paperTitle: 'T',
      results: [mkStudent({ total: 120, fullTotal: 100 })],
    });
    const md = buildMarkdown(bad);
    expect(md).toContain('⚠️');
    expect(md).toContain('仅供参考');
  });

  it('一切正常时**不**出现警告块（避免狼来了）', () => {
    const md = buildMarkdown(normal);
    expect(md).not.toContain('⚠️');
  });

  it('学生明细逐人列出', () => {
    const md = buildMarkdown(normal);
    expect(md).toContain('张三');
    expect(md).toContain('李四');
    expect(md).toContain('## 学生明细');
  });
});

/* ══════════════════════════════════════════════ 明细行 */

describe('buildWorkbookRows：明细摊平', () => {
  it('每个学生的每题一行', () => {
    const r = aggregatePaper({
      paperId: 'P1',
      paperTitle: 'T',
      results: [mkStudent({}, [mkDetail({ questionId: 'Q1' }), mkDetail({ questionId: 'Q2' })])],
    });
    const rows = buildWorkbookRows(r);
    expect(rows).toHaveLength(2);
    expect(rows.map((x) => x.题号)).toEqual(['Q1', 'Q2']);
  });

  it('★ 只有总分没有明细的学生也要占一行 —— 否则他在明细表里凭空消失', () => {
    const r = aggregatePaper({
      paperId: 'P1',
      paperTitle: 'T',
      results: [mkStudent({}, [])],
    });
    const rows = buildWorkbookRows(r);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.题号).toBe('—');
  });

  it('低置信度在「需复核」列标出来', () => {
    const r = aggregatePaper({
      paperId: 'P1',
      paperTitle: 'T',
      results: [mkStudent({}, [mkDetail({ confidence: 0.5 })])],
    });
    const rows = buildWorkbookRows(r);
    expect(rows[0]!.需复核).toBe('是');
    expect(rows[0]!.置信度).toBe('0.50');
  });

  it('题型译成中文', () => {
    const r = aggregatePaper({
      paperId: 'P1',
      paperTitle: 'T',
      results: [mkStudent({}, [mkDetail({ type: 'choice' })])],
    });
    expect(buildWorkbookRows(r)[0]!.题型).toBe('选择');
  });
});