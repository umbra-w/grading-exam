import { describe, expect, it } from 'vitest';
import {
  type PaperEntry,
  type ScoreSheet,
  buildResults,
  formatSheetExample,
  parseScoresText,
} from '../src/renderer/paper-entry';

/*
 * 成绩录入的纯逻辑。
 *
 * 为什么需要它：整卷聚合（io/paper.ts）已经就绪，但**批量上传答卷图片
 * 由视觉识别**这条链路还没做。在那之前，教师需要一条能立刻用起来的
 * 录入途径 —— 否则聚合功能等于锁在柜子里。
 *
 * 粘贴文本是最小可行且可校验的形式：能手打、能从 Excel 复制、
 * 也能由将来的视觉识别直接产出同样格式。
 *
 * ── 贯穿本模块的一条纪律 ─────────────────────────────────────
 *
 * **缺分 ≠ 0 分**。某个学生某题没填，解析结果是 `null`（缺失），
 * 不是 0。把它当 0 会让"老师还没录完"变成"这个学生该题全错"，
 * 而且两者在报表里长得一模一样（§6.1）。
 */

const SHEET: ScoreSheet = {
  questions: [
    { questionId: 'Q1', type: 'choice', fullScore: 5 },
    { questionId: 'Q2', type: 'short', fullScore: 10 },
    { questionId: 'Q3', type: 'calc', fullScore: 10 },
  ],
};

function sheet(questions: ScoreSheet['questions']): ScoreSheet {
  return { questions };
}

/* ══════════════════════════════════════════════ 表头/示例 */

describe('formatSheetExample：给出可照抄的格式示例', () => {
  it('★ 示例与解析器口径一致（示例能被自己解析）', () => {
    /*
     * 这条是防"示例在骗人"：示例文本若解析不出来，
     * 老师会照着它敲一堆报错，然后认为软件坏了。
     */
    const ex = formatSheetExample(SHEET);
    const r = parseScoresText(ex, SHEET);
    expect(r.errors).toEqual([]);
    expect(r.students.length).toBeGreaterThan(0);
  });

  it('列头包含姓名与考号，以及各题号', () => {
    const ex = formatSheetExample(SHEET);
    expect(ex).toContain('姓名');
    expect(ex).toContain('考号');
    expect(ex).toContain('Q1');
    expect(ex).toContain('Q2');
  });

  it('空题目表也能给出不含题号的表头（不崩）', () => {
    const ex = formatSheetExample(sheet([]));
    expect(ex).toContain('姓名');
  });
});

/* ══════════════════════════════════════════════ 解析 */

describe('parseScoresText：粘贴文本解析', () => {
  it('★ 缺分解析为 null（缺失），不是 0 —— 两者在报表里长得一样', () => {
    const r = parseScoresText('张三,001,5,,-', SHEET);
    expect(r.students).toHaveLength(1);
    expect(r.students[0]!.scores[1]).toBeNull();
    expect(r.students[0]!.scores[2]).toBeNull();
    // 明确给 0 才是 0
    const r2 = parseScoresText('李四,002,5,0,0', SHEET);
    expect(r2.students[0]!.scores[1]).toBe(0);
  });

  it('★ 缺分逐条提示，不静默放过', () => {
    const r = parseScoresText('张三,001,5,,-', SHEET);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings.some((w) => w.includes('Q2'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('Q3'))).toBe(true);
  });

  it('正常一行解析出姓名/考号/各题分', () => {
    const r = parseScoresText('张三,001,5,8,9', SHEET);
    expect(r.errors).toEqual([]);
    expect(r.students[0]).toMatchObject({ name: '张三', examNo: '001' });
    expect(r.students[0]!.scores).toEqual([5, 8, 9]);
  });

  it('表头行被自动识别并跳过', () => {
    const r = parseScoresText('姓名,考号,Q1,Q2,Q3\n张三,001,5,8,9', SHEET);
    expect(r.students).toHaveLength(1);
    expect(r.errors).toEqual([]);
  });

  it('空行与纯空白行被忽略', () => {
    const r = parseScoresText('张三,001,5,8,9\n\n   \n李四,002,4,7,8', SHEET);
    expect(r.students).toHaveLength(2);
  });

  it('★ 行号出现在错误信息里 —— 否则老师不知道改哪一行', () => {
    const r = parseScoresText('张三,001,5,8,9\n坏行只有一列', SHEET);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]).toMatch(/第\s*2\s*行/);
  });

  it('★ 分数超过满分 → 报错并指出题号与实际值', () => {
    const r = parseScoresText('张三,001,99,8,9', SHEET);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]).toContain('Q1');
  });

  it('负分 → 报错', () => {
    const r = parseScoresText('张三,001,-1,8,9', SHEET);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('★ 非法数字（如"abc"）→ 报错，**绝不静默当 0**（§6.1 那类缺陷的原型）', () => {
    const r = parseScoresText('张三,001,abc,8,9', SHEET);
    expect(r.errors.length).toBeGreaterThan(0);
    // 关键：不能把 abc 变成 0 分放过去
    expect(r.students).toHaveLength(0);
  });

  it('缺姓名 → 报错（没有名字的成绩单没法发下去）', () => {
    const r = parseScoresText(',001,5,8,9', SHEET);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('缺考号 → 报错（考号是学生身份的唯一可靠标识）', () => {
    const r = parseScoresText('张三,,5,8,9', SHEET);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('★ 同一考号重复出现 → 报错并指出是哪一行（重复会污染汇总）', () => {
    const r = parseScoresText('张三,001,5,8,9\n李四,001,4,7,8', SHEET);
    expect(r.errors.some((e) => e.includes('001'))).toBe(true);
  });

  it('支持全角逗号与顿号（中文输入法常见）', () => {
    const r = parseScoresText('张三，001，5，8，9', SHEET);
    expect(r.errors).toEqual([]);
    expect(r.students[0]!.scores).toEqual([5, 8, 9]);
  });

  it('支持制表符分隔（从 Excel 直接复制）', () => {
    const r = parseScoresText('张三\t001\t5\t8\t9', SHEET);
    expect(r.errors).toEqual([]);
    expect(r.students[0]!.scores).toEqual([5, 8, 9]);
  });

  it('小数分保留（0.5 分是常见口径）', () => {
    const r = parseScoresText('张三,001,4.5,7.5,9.5', SHEET);
    expect(r.students[0]!.scores).toEqual([4.5, 7.5, 9.5]);
  });

  it('全部为空文本 → 没有学生也没有错误（不是错误，是还没填）', () => {
    const r = parseScoresText('', SHEET);
    expect(r.students).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it('★ 只有错误没有学生时，调用方可以据此拒绝汇总', () => {
    const r = parseScoresText('乱写的行', SHEET);
    expect(r.students).toHaveLength(0);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('题数与分数列数不匹配 → 报错指出该行缺几列', () => {
    const r = parseScoresText('张三,001,5,8', SHEET);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});

/* ══════════════════════════════════════════════ 组装 StudentResult */

describe('buildResults：把成绩单组装成 StudentResult[]', () => {
  function sheetWith(p: Partial<PaperEntry>[]): PaperEntry[] {
    return p.map((x, i) => ({
      name: x.name ?? `学生${i + 1}`,
      examNo: x.examNo ?? `00${i + 1}`,
      scores: x.scores ?? [5, 8, 9],
    }));
  }

  it('每题生成一条 detail，题号/题型/满分来自试卷定义', () => {
    const rs = buildResults(sheetWith([{}]), SHEET);
    expect(rs).toHaveLength(1);
    expect(rs[0]!.details.map((d) => d.questionId)).toEqual(['Q1', 'Q2', 'Q3']);
    expect(rs[0]!.details.map((d) => d.type)).toEqual(['choice', 'short', 'calc']);
  });

  it('总分等于各题得分之和，满分等于各题满分之和', () => {
    const rs = buildResults(sheetWith([{ scores: [5, 8, 9] }]), SHEET);
    expect(rs[0]!.total).toBe(22);
    expect(rs[0]!.fullTotal).toBe(25);
  });

  it('★ 缺分的题按**未作答**处理：记 0 分但**标记需复核**，并写入评语', () => {
    /*
     * 这是本模块最需要说清楚的取舍。
     *
     * io/paper.ts 的口径是"总分必须能算"，所以缺分必须有个数值，
     * 否则整份卷子算不出总分。取 0 分是唯一自洽的算法。
     *
     * 但**必须同时置 reviewRequested 并在评语里写明"未录入"**：
     * 否则"老师忘了录"和"学生真的答错"在报表里完全一样，
     * 而这个差别会直接影响讲评和成绩。宁可留一条待复核，
     * 也不能让一个数据缺口伪装成一个 0 分（§6.1）。
     */
    const rs = buildResults(sheetWith([{ scores: [5, null, null] }]), SHEET);
    const d1 = rs[0]!.details[1]!;
    expect(d1.score).toBe(0);
    expect(d1.reviewRequested).toBe(true);
    expect(d1.comment).toContain('未录入');
    // 满分与题号仍要正确，否则教师对不上原始成绩单
    expect(d1.fullScore).toBe(10);
  });

  it('★ 正常录入的题不带"未录入"评语，也不被标记复核', () => {
    const rs = buildResults(sheetWith([{ scores: [5, 8, 9] }]), SHEET);
    for (const d of rs[0]!.details) {
      expect(d.reviewRequested).toBe(false);
      expect(d.comment).not.toContain('未录入');
    }
  });

  it('★ 手工录入的置信度是 1（已知值），不是模型给的 0.9', () => {
    /*
     * 置信度的含义是"这个分数有多可信"。手打进去的分数是确定的输入，
     * 不存在模型不确定性 —— 给它 0.9 会让它莫名其妙地接近复核阈值，
     * 甚至把整份卷子拖进"低置信度"统计里。
     */
    const rs = buildResults(sheetWith([{ scores: [5, 8, 9] }]), SHEET);
    expect(rs[0]!.details[0]!.confidence).toBe(1);
  });

  it('★ 不编造得分点：手工录入没有 hitPoints/missedPoints', () => {
    // 编造"命中了某点"等于捏造评分过程
    const rs = buildResults(sheetWith([{ scores: [5, 8, 9] }]), SHEET);
    expect(rs[0]!.details[0]!.hitPoints).toEqual([]);
    expect(rs[0]!.details[0]!.missedPoints).toEqual([]);
  });

  it('submissionId 用考号构造，保证同一学生可识别', () => {
    const rs = buildResults(sheetWith([{ examNo: '2024001' }]), SHEET);
    expect(rs[0]!.submissionId).toContain('2024001');
  });

  it('★ 考号重复时 submissionId 不重复（否则汇总会混淆两个学生）', () => {
    const rs = buildResults(
      sheetWith([{ examNo: 'A' }, { examNo: 'A' }]),
      SHEET,
    );
    expect(rs[0]!.submissionId).not.toBe(rs[1]!.submissionId);
  });

  it('gradedAt 用注入的时间源（便于测试）', () => {
    const rs = buildResults(sheetWith([{}]), SHEET, () => 12345);
    expect(rs[0]!.gradedAt).toBe(12345);
  });

  it('空输入返回空数组', () => {
    expect(buildResults([], SHEET)).toEqual([]);
  });

  it('★ 空试卷定义（没有题）不会崩，也不会造出假 detail', () => {
    const rs = buildResults(sheetWith([{ scores: [] }]), sheet([]));
    expect(rs[0]!.details).toEqual([]);
    expect(rs[0]!.fullTotal).toBe(0);
  });
});

/* ══════════════════════════════════════════════ 端到端衔接 */

describe('★ 与整卷聚合衔接：粘贴 → 解析 → 组装 → 汇总', () => {
  it('★ 缺分的那份卷子会被汇总标出来，而不是悄悄算成低分', async () => {
    const { aggregatePaper } = await import('../src/main/io/paper');
    const r = parseScoresText('张三,001,5,8,9\n李四,002,5,,', SHEET);
    const results = buildResults(r.students, SHEET);
    const report = aggregatePaper({ paperId: 'P1', paperTitle: 'T', results });

    expect(report.stats.count).toBe(2);
    // 李四的两道未录入题应进分层统计的复核率
    const byType = report.stats.byType;
    const short = byType.find((x) => x.type === 'short')!;
    // 两人里有一人需复核 → 0.5
    expect(short.reviewRate).toBe(0.5);
  });
});