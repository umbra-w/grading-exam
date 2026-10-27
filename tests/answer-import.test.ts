/**
 * 批量图片导入答卷识别（SPEC F3.4）—— 纯逻辑部分的测试。
 *
 * 先写测试再写实现，理由同 §4.4：本机 Electron 起不来，视觉模型调用
 * （`visionAnswers`）无法端到端验证，所以**必须**把其中所有能判断对错的部分
 * 抽成纯函数钉死。这个模块里真正纯的部分是：
 *
 *   规范化题号 → 清洗姓名/考号 → 逐题对齐 → 同名去重 → 可读草稿
 *
 * 而"读文件 / 调 API / 图片编码"是薄绑定，本文件不覆盖（诚实标注见模块头）。
 *
 * ── 三条纪律，每条都对应一类真实事故 ──────────────────────────────
 *
 * 1. **认不出的东西绝不静默变成"没有"**。模型给了一个我映射不上的题号，
 *    如果直接丢掉，学生那道题的答案就凭空消失了 —— 而汇总看起来完全正常。
 *    这正是本项目栽过的"静默失败"（§6.1）。所以一律进 `unmatched` / `missing`。
 *
 * 2. **姓名/考号认不出 ≠ 可以猜**。提示词里明确写了"不要猜测"，识别为空时
 *    必须原样保留为空并标记待人工核对，不能拿"第 N 张"当学生名。
 *
 * 3. **缺答案 ≠ 空答案**。某题没有转录结果时，是"没有"（不在 answers 里），
 *    不是"答了但答成空字符串"。两者在复核界面上必须能区分。
 */
import { describe, expect, it } from 'vitest';
import {
  alignSheet,
  buildBatchImport,
  buildDraftText,
  cleanExamNo,
  cleanName,
  describeImportGate,
  enumerateSheets,
  normalizeQuestionNo,
  parseVisionSheet,
  uniqueSubmissionId,
} from '../src/renderer/answer-import';
import type { QuestionMeta, RawVisionSheet } from '../src/renderer/answer-import';

/** 一份常见的试卷定义：主观题在前、客观题在后，用来验证按 questionId 对齐而非按序号 */
const QUESTIONS: QuestionMeta[] = [
  { questionId: 'MATH-CALC-0001', type: 'calc', fullScore: 10 },
  { questionId: 'MATH-CALC-0002', type: 'calc', fullScore: 12 },
  { questionId: 'CHIN-SHORT-0001', type: 'short', fullScore: 8 },
  { questionId: 'CHIN-SHORT-0002', type: 'short', fullScore: 8 },
];

describe('normalizeQuestionNo —— 题号规范化', () => {
  it('纯阿拉伯数字原样归一', () => {
    expect(normalizeQuestionNo('1')).toBe(1);
    expect(normalizeQuestionNo('12')).toBe(12);
    expect(normalizeQuestionNo(' 3 ')).toBe(3);
  });

  it('带前后缀的常见写法都能认', () => {
    expect(normalizeQuestionNo('第1题')).toBe(1);
    expect(normalizeQuestionNo('第 12 题')).toBe(12);
    expect(normalizeQuestionNo('1.')).toBe(1);
    expect(normalizeQuestionNo('1、')).toBe(1);
    expect(normalizeQuestionNo('（1）')).toBe(1);
    expect(normalizeQuestionNo('(1)')).toBe(1);
    // 「第1题(2)」同时含两个数字（第1题 + 子问 (2)），无法确定指哪一题 ——
    // 宁可判认不出（进 unmatched 保留原文待人工核对），也绝不猜一个：
    // 猜错会把答案落到错的题上，而汇总看起来完全正常（§6.1 静默失败）。
    expect(normalizeQuestionNo('第1题(2)')).toBeNull();
    expect(normalizeQuestionNo('题1')).toBe(1);
    expect(normalizeQuestionNo('1题')).toBe(1);
  });

  it('中文数字也认（老师手写常见）', () => {
    expect(normalizeQuestionNo('一')).toBe(1);
    expect(normalizeQuestionNo('第一题')).toBe(1);
    expect(normalizeQuestionNo('十')).toBe(10);
    expect(normalizeQuestionNo('十一')).toBe(11);
    expect(normalizeQuestionNo('二十')).toBe(20);
    expect(normalizeQuestionNo('二十三')).toBe(23);
  });

  it('认不出的一律返回 null，绝不猜一个数字出来', () => {
    expect(normalizeQuestionNo('')).toBeNull();
    expect(normalizeQuestionNo('   ')).toBeNull();
    expect(normalizeQuestionNo('附加题')).toBeNull();
    expect(normalizeQuestionNo('作文')).toBeNull();
    expect(normalizeQuestionNo('abc')).toBeNull();
    expect(normalizeQuestionNo('0')).toBeNull();
    expect(normalizeQuestionNo('-1')).toBeNull();
    // 多个数字并列时无法确定是第几题 —— 宁可判认不出
    expect(normalizeQuestionNo('1 2')).toBeNull();
  });
});

describe('cleanName / cleanExamNo —— 标识字段清洗', () => {
  it('去掉字段名前缀与首尾空白', () => {
    expect(cleanName('姓名：张三')).toBe('张三');
    expect(cleanName('姓名: 张三')).toBe('张三');
    expect(cleanName('  张三  ')).toBe('张三');
    expect(cleanName('姓名 张三')).toBe('张三');
    expect(cleanExamNo('考号：2024001')).toBe('2024001');
    expect(cleanExamNo('学号:2024001')).toBe('2024001');
    expect(cleanExamNo('准考证号：2024001')).toBe('2024001');
  });

  it('认不出时返回空串 —— 不编造占位名', () => {
    expect(cleanName('')).toBe('');
    expect(cleanName('   ')).toBe('');
    expect(cleanName('姓名：')).toBe('');
    expect(cleanExamNo('考号：')).toBe('');
    expect(cleanName('□')).toBe('');
    expect(cleanExamNo('□')).toBe('');
  });

  it('保留原始有效内容，不做过度清洗', () => {
    // 含空格的真实名字（少数民族姓名）不该被压掉中间空格
    expect(cleanName('阿依古丽 买买提')).toBe('阿依古丽 买买提');
    expect(cleanExamNo('A-2024-001')).toBe('A-2024-001');
  });
});

describe('parseVisionSheet —— 解析模型返回的结构', () => {
  it('标准结构顺利解析', () => {
    const r = parseVisionSheet({
      name: '张三',
      examNo: '2024001',
      answers: [
        { index: 1, text: 'x^2' },
        { index: 2, text: '1/2' },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.sheet?.name).toBe('张三');
    expect(r.sheet?.examNo).toBe('2024001');
    expect(r.sheet?.answers).toHaveLength(2);
    expect(r.errors).toHaveLength(0);
  });

  it('index 是字符串数字也能解析', () => {
    const r = parseVisionSheet({
      name: '李四',
      examNo: '',
      answers: [{ index: '3', text: 'ok' }],
    });
    expect(r.ok).toBe(true);
    expect(r.sheet?.answers[0]?.index).toBe('3');
  });

  it('非对象 / 缺 answers / 空 answers 都判失败并给原因', () => {
    for (const bad of [null, undefined, 'x', 42, {}, { answers: 'x' }, { answers: [] }]) {
      const r = parseVisionSheet(bad);
      expect(r.ok, `应拒绝：${JSON.stringify(bad)}`).toBe(false);
      expect(r.errors.length).toBeGreaterThan(0);
    }
  });

  it('模型返回的 JSON 字符串也接受（有些供应商不按 json 模式回）', () => {
    const r = parseVisionSheet('{"name":"王五","examNo":"9","answers":[{"index":1,"text":"a"}]}');
    expect(r.ok).toBe(true);
    expect(r.sheet?.name).toBe('王五');
  });

  it('字符串里裹着 markdown 代码块也能取出来', () => {
    const r = parseVisionSheet('```json\n{"name":"王五","examNo":"9","answers":[{"index":1,"text":"a"}]}\n```');
    expect(r.ok).toBe(true);
    expect(r.sheet?.name).toBe('王五');
  });

  it('单条 answer 结构不对时跳过它并记错误，不牵连整张卷子', () => {
    const r = parseVisionSheet({
      name: '张三',
      examNo: '',
      answers: [{ index: 1, text: 'ok' }, { index: null }, 'garbage'],
    });
    expect(r.ok).toBe(true);
    expect(r.sheet?.answers).toHaveLength(1);
    expect(r.errors.length).toBeGreaterThan(0);
    // 跳过的必须说出来，不能静默少一道题
    expect(r.errors.join('')).toMatch(/第 2 条|跳过/);
  });
});

describe('enumerateSheets —— 图片分组与排序', () => {
  it('按文件名自然排序（photo2 要排在 photo10 前面）', () => {
    const out = enumerateSheets(['photo10.jpg', 'photo2.jpg', 'photo1.jpg']);
    expect(out.map((s) => s.fileName)).toEqual(['photo1.jpg', 'photo2.jpg', 'photo10.jpg']);
  });

  it('编号从 1 开始，用于生成学生 id', () => {
    const out = enumerateSheets(['a.jpg', 'b.jpg', 'c.jpg']);
    expect(out.map((s) => s.importIndex)).toEqual([1, 2, 3]);
  });

  it('空列表返回空数组', () => {
    expect(enumerateSheets([])).toEqual([]);
  });

  it('不改动入参', () => {
    const input = ['b.jpg', 'a.jpg'];
    const snapshot = [...input];
    enumerateSheets(input);
    expect(input).toEqual(snapshot);
  });
});

describe('uniqueSubmissionId —— 学生 id 去重', () => {
  it('考号优先：有考号用考号', () => {
    const id = uniqueSubmissionId({ name: '张三', examNo: '2024001', importIndex: 1 }, new Set());
    expect(id).toBe('2024001');
  });

  it('无考号用姓名；重名时加序号，绝不覆盖已有学生', () => {
    const used = new Set<string>();
    expect(uniqueSubmissionId({ name: '张三', examNo: '', importIndex: 1 }, used)).toBe('张三');
    expect(uniqueSubmissionId({ name: '张三', examNo: '', importIndex: 2 }, used)).toBe('张三-2');
    expect(uniqueSubmissionId({ name: '张三', examNo: '', importIndex: 3 }, used)).toBe('张三-3');
  });

  it('姓名也没有时用导入序号，并保持可追溯', () => {
    expect(uniqueSubmissionId({ name: '', examNo: '', importIndex: 7 }, new Set())).toBe('导入-7');
  });
});

describe('alignSheet —— 逐题对齐（核心）', () => {
  it('正常对齐：answers 按题号落到正确的 questionId', () => {
    const raw: RawVisionSheet = {
      name: '张三',
      examNo: '2024001',
      answers: [
        { index: '1', text: 'x^2' },
        { index: '2', text: '1/2' },
        { index: '3', text: '短文一篇' },
        { index: '4', text: '另一篇' },
      ],
    };
    const r = alignSheet(raw, QUESTIONS);
    expect(r.submission.name).toBe('张三');
    expect(r.submission.examNo).toBe('2024001');
    expect(r.submission.answers).toHaveLength(4);
    expect(r.submission.answers[0]?.questionId).toBe('MATH-CALC-0001');
    expect(r.submission.answers[2]?.questionId).toBe('CHIN-SHORT-0001');
    expect(r.submission.answers[2]?.text).toBe('短文一篇');
    expect(r.unmatched).toHaveLength(0);
    expect(r.missing).toHaveLength(0);
  });

  it('题号跳号（只认出 1 和 3）时：2 进 missing，不是填个空字符串糊过去', () => {
    const raw: RawVisionSheet = {
      name: '张三',
      examNo: '',
      answers: [
        { index: '1', text: 'a' },
        { index: '3', text: 'c' },
      ],
    };
    const r = alignSheet(raw, QUESTIONS);
    expect(r.submission.answers).toHaveLength(2);
    expect(r.missing).toEqual(['MATH-CALC-0002', 'CHIN-SHORT-0002']);
    // 缺答案必须是"不在数组里"，而不是空文本 —— 两者在复核界面上要能区分
    expect(r.submission.answers.some((a) => a.text === '')).toBe(false);
  });

  it('题号超出试卷范围时进 unmatched，并保留原文以便人工定位', () => {
    const raw: RawVisionSheet = {
      name: '张三',
      examNo: '',
      answers: [
        { index: '1', text: 'a' },
        { index: '9', text: '多出来的' },
      ],
    };
    const r = alignSheet(raw, QUESTIONS);
    expect(r.unmatched).toHaveLength(1);
    expect(r.unmatched[0]?.rawIndex).toBe('9');
    expect(r.unmatched[0]?.text).toBe('多出来的');
  });

  it('认不出的题号进 unmatched，绝不丢弃（§6.1）', () => {
    const raw: RawVisionSheet = {
      name: '张三',
      examNo: '',
      answers: [
        { index: '1', text: 'a' },
        { index: '附加题', text: '我不会丢' },
      ],
    };
    const r = alignSheet(raw, QUESTIONS);
    expect(r.unmatched).toHaveLength(1);
    expect(r.unmatched[0]?.rawIndex).toBe('附加题');
    expect(r.unmatched[0]?.text).toBe('我不会丢');
  });

  it('空白转录结果计为缺失，不计为"答了空"', () => {
    const raw: RawVisionSheet = {
      name: '张三',
      examNo: '',
      answers: [
        { index: '1', text: '   ' },
        { index: '2', text: 'b' },
      ],
    };
    const r = alignSheet(raw, QUESTIONS);
    expect(r.submission.answers).toHaveLength(1);
    expect(r.missing).toContain('MATH-CALC-0001');
  });

  it('姓名/考号认不出时标记待复核，不编造', () => {
    const raw: RawVisionSheet = { name: '', examNo: '', answers: [{ index: '1', text: 'a' }] };
    const r = alignSheet(raw, QUESTIONS, { importIndex: 3 });
    expect(r.submission.name).toBe('');
    expect(r.needsReview).toBe(true);
    expect(r.warnings.join('')).toMatch(/姓名/);
    // 不能拿"第 3 张"当学生名
    expect(r.submission.name).not.toMatch(/导入|第.*张/);
    expect(r.submission.id).toBe('导入-3');
  });

  it('同一题号出现两次时保留第一条并警告（模型偶尔重复输出）', () => {
    const raw: RawVisionSheet = {
      name: '张三',
      examNo: '',
      answers: [
        { index: '1', text: '第一次' },
        { index: '1', text: '第二次' },
      ],
    };
    const r = alignSheet(raw, QUESTIONS);
    expect(r.submission.answers).toHaveLength(1);
    expect(r.submission.answers[0]?.text).toBe('第一次');
    expect(r.warnings.join('')).toMatch(/重复/);
  });

  it('extractedDraft 保留原始识别文本，便于人工核对', () => {
    const raw: RawVisionSheet = {
      name: '张三',
      examNo: '2024001',
      answers: [{ index: '1', text: 'x^2' }],
    };
    const r = alignSheet(raw, QUESTIONS);
    expect(r.submission.extractedDraft).toBeTruthy();
    expect(r.submission.extractedDraft).toContain('张三');
    expect(r.submission.extractedDraft).toContain('x^2');
  });

  it('不改动入参', () => {
    const raw: RawVisionSheet = {
      name: '张三',
      examNo: '',
      answers: [{ index: '1', text: 'a' }],
    };
    const snapshot = JSON.parse(JSON.stringify(raw));
    alignSheet(raw, QUESTIONS);
    expect(raw).toEqual(snapshot);
  });
});

describe('buildDraftText —— 草稿供人工核对识别结果', () => {
  it('产出「姓名,考号,题号…」表头 + 值行，与整卷录入共用同一套表头口径', () => {
    const txt = buildDraftText(
      { name: '张三', examNo: '2024001', answers: [{ index: 1, text: 'x^2' }] },
      QUESTIONS,
    );
    const lines = txt.split('\n');
    expect(lines[0]).toBe('姓名,考号,MATH-CALC-0001,MATH-CALC-0002,CHIN-SHORT-0001,CHIN-SHORT-0002');
    expect(lines[1]?.startsWith('张三,2024001,x^2,')).toBe(true);
    // 没识别出的题目留空单元格（有可见空位，人工一眼看出哪里缺）
    expect(lines[1]?.split(',')[2]).toBe('x^2');
    expect(lines[1]?.split(',')[3]).toBe('');
  });

  it('草稿里是答案文本而不是分数 —— 直接粘进分数面板必须被拒收，不得静默当 0', () => {
    // 这是诚实边界：视觉识别的是"学生写了什么"，分数要等评完才有。
    // 草稿的用途是人工核对，不是直接入分。若有人误把草稿粘进 paper-entry，
    // parseScoresText 对非数字列报错才是正确行为 —— 这里把这个边界钉住。
    const txt = buildDraftText(
      { name: '张三', examNo: '', answers: [{ index: 1, text: 'x^2' }] },
      QUESTIONS,
    );
    const cells = (txt.split('\n')[1] ?? '').split(',');
    // 第 3 列（第一题）是答案文本，不是数字
    expect(cells[2]).toBe('x^2');
    expect(Number.isFinite(Number(cells[2]))).toBe(false);
  });

  it('答案里含逗号时用引号包裹，避免把单元格切错', () => {
    const txt = buildDraftText(
      { name: '张三', examNo: '', answers: [{ index: 1, text: 'a,b' }] },
      QUESTIONS,
    );
    const first = txt.split('\n')[1] ?? '';
    expect(first).toContain('"a,b"');
  });

  it('答案里含引号时转义成两个引号（CSV 口径）', () => {
    const txt = buildDraftText(
      { name: '张三', examNo: '', answers: [{ index: 1, text: 'say "hi"' }] },
      QUESTIONS,
    );
    expect(txt.split('\n')[1]).toContain('"say ""hi"""');
  });

  it('答案里含换行时按 CSV 规则包进引号（表格软件按一个字段还原）', () => {
    const txt = buildDraftText(
      { name: '张三', examNo: '', answers: [{ index: 1, text: '第一行\n第二行' }] },
      QUESTIONS,
    );
    // RFC 4180：引号字段内允许物理换行。原始字符串按 \n 切会出现 3 段，
    // 但第二段属于被引号包住的同一字段 —— 关键断言是"换行被引号包住"。
    expect(txt).toContain('"第一行\n第二行"');
    // 数据行仍以姓名开头，表头结构未被换行破坏
    expect(txt.split('\n')[0]).toBe('姓名,考号,MATH-CALC-0001,MATH-CALC-0002,CHIN-SHORT-0001,CHIN-SHORT-0002');
    expect(txt.split('\n')[1]?.startsWith('张三,,')).toBe(true);
  });
});

describe('buildBatchImport —— 批量汇总', () => {
  const sheet = (name: string, idx: string, text: string): RawVisionSheet => ({
    name,
    examNo: '',
    answers: [{ index: idx, text }],
  });

  it('逐张对齐并汇总；单张内容差不中断整批', () => {
    const r = buildBatchImport(
      [sheet('张三', '1', 'a'), sheet('', '', 'b'), sheet('李四', '1', 'c')],
      QUESTIONS,
      'PAPER-1',
    );
    expect(r.submissions).toHaveLength(3);
    expect(r.errors).toHaveLength(0);
    // 第二张姓名缺失 → id 用导入序号，绝不与别人冲突，也绝不编造姓名
    expect(r.alignments[1]?.submission.id).toBe('导入-2');
    expect(r.alignments[1]?.needsReview).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('重名学生不会被合并：第二个同名学生拿 -2 后缀，两人都保留', () => {
    const r = buildBatchImport([sheet('张三', '1', 'a'), sheet('张三', '1', 'b')], QUESTIONS, 'PAPER-1');
    const ids = r.submissions.map((s) => s.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).toBe('张三');
    expect(ids[1]).toBe('张三-2');
  });

  it('空输入必须报错误，不静默返回"成功但为空"', () => {
    const r = buildBatchImport([], QUESTIONS, 'PAPER-1');
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.submissions).toHaveLength(0);
  });

  it('有考号的学生以考号为 id，跨批次可追溯', () => {
    const r = buildBatchImport(
      [{ name: '张三', examNo: '2024001', answers: [{ index: '1', text: 'a' }] }],
      QUESTIONS,
      'PAPER-1',
    );
    expect(r.submissions[0]?.id).toBe('2024001');
  });
});

describe('describeImportGate —— 质量判定文案', () => {
  it('每种判定都有对应文案，未知判定不冒充"可用"', () => {
    expect(describeImportGate('ok')).toMatch(/可用/);
    expect(describeImportGate('marginal')).toMatch(/核对/);
    expect(describeImportGate('poor')).toMatch(/不可靠|重拍/);
    expect(describeImportGate('insufficient')).toMatch(/核对/);
    // 未做质量检查必须直说，不能假装检查过
    expect(describeImportGate(undefined)).toMatch(/未做质量检查/);
    expect(describeImportGate('weird-value')).toMatch(/未做质量检查/);
  });
});