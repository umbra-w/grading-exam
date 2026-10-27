/**
 * 整卷成绩录入 —— 粘贴文本 → 解析 → 组装成 `StudentResult[]`。
 *
 * 为什么需要这一层：整卷聚合（`main/io/paper.ts`）已经就绪，
 * `io:exportExcel` / `io:exportMarkdown` 也早就通了，但**批量上传答卷图片
 * 由视觉识别**这条链路还没做（SPEC F3.4）。在那之前，教师需要一条
 * 立刻能用、且能被校验的录入途径 —— 否则整卷聚合等于锁在柜子里。
 *
 * 粘贴文本是最小可行形式：能手打、能从 Excel 直接复制、也能由将来的
 * 视觉识别直接产出同样格式。所以它不是临时方案，而是这条链路的**入口契约**。
 *
 * 本模块是纯逻辑（不碰文件、不联网、不启动任务），因此能被 vitest 覆盖。
 *
 * ── 两条贯穿本模块的纪律 ────────────────────────────────────────
 *
 * 1. **缺分 ≠ 0 分**。解析时缺分是 `null`，并逐条给出提示；
 *    只有到 `buildResults` 需要算总分时才取 0 分，且**必须同时标记
 *    需复核并在评语里写明"未录入"**。否则"老师忘了录"和
 *    "学生真的答错"在报表里完全一样，而这个差别直接影响讲评与成绩（§6.1）。
 *
 * 2. **非法输入一律报错，绝不静默当 0**。`asNumber('abc') → 0` 正是
 *    本项目已经栽过的那个坑，这里从入口就堵住。
 */

import type { GradingDetail, QuestionType, StudentResult } from '@shared/types';

/** 试卷的题目定义 —— 整卷录入与聚合共用的最小形状 */
export interface PaperQuestion {
  questionId: string;
  type: QuestionType;
  fullScore: number;
  /**
   * 客观题参考答案（F3.4 判分接线）。
   * 只对 choice/judge/fill 有意义；缺省时该题**无法本地比对**，
   * grade-pipeline 会把它标为"无法判分"而不是交给模型猜 ——
   * 选择题让学生答案和"模型觉得像"去比，是最典型的假分来源。
   */
  referenceAnswer?: string;
  /** 主观题评分要点（AI 评分输入）。分号分隔由 UI 拆成数组 */
  scoringPoints?: string[];
  /** 学科（可选，进 AI 提示词帮助措辞） */
  subject?: string;
}

export interface ScoreSheet {
  questions: PaperQuestion[];
}

/** 一行学生成绩。`scores[i]` 对应 `questions[i]`，`null` 表示未填 */
export interface PaperEntry {
  name: string;
  examNo: string;
  scores: Array<number | null>;
}

export interface ParseOutcome {
  students: PaperEntry[];
  /** 必须由调用方展示：合法的行照常进 students，但错误必须让人看到 */
  errors: string[];
  /** 不阻塞解析的提醒（如"某题未填"） */
  warnings: string[];
}

/** 可接受的列分隔符：半角/全角逗号、顿号、制表符 */
const SEPARATORS = /[,，、\t]/;

/** 表头识别关键字：出现"姓名"或"考号"就认为这一行是表头 */
const HEADER_HINT = /姓名|考号/;

/** 表示"没填"的记号。空串本身也算 */
const BLANK_TOKENS = new Set(['', '-', '—', '未', '缺', '无', '／', '/']);

/**
 * 生成可照抄的示例文本。
 *
 * 示例与解析器共用同一套分隔符口径 —— 示例必须是**能被自己解析成功**的，
 * 否则老师照着它敲一堆报错，然后会认为软件坏了。
 */
export function formatSheetExample(sheet: ScoreSheet): string {
  const ids = sheet.questions.map((q) => q.questionId);
  const header = ['姓名', '考号', ...ids].join(',');
  const row1 = ['张三', '001', ...sheet.questions.map((q) => String(q.fullScore))].join(',');
  const row2 = ['李四', '002', ...sheet.questions.map(() => '0')].join(',');
  return [header, row1, row2].join('\n');
}

/** 判断一个记号是否表示"未填" */
function isBlank(token: string): boolean {
  return BLANK_TOKENS.has(token.trim());
}

/**
 * 解析粘贴的成績文本。
 *
 * 逐行处理并**带上行号**报错：只说"分数格式错误"而不说第几行，
 * 老师面对一百行数据无从下手。
 */
export function parseScoresText(text: string, sheet: ScoreSheet): ParseOutcome {
  const errors: string[] = [];
  const warnings: string[] = [];
  const students: PaperEntry[] = [];
  const seenExamNo = new Map<string, number>();
  const qCount = sheet.questions.length;

  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    if (raw.trim() === '') continue;

    const lineNo = i + 1;

    // 表头行：含"姓名"或"考号"就跳过。不强求列头与题目数量一致 ——
    // 老师常从 Excel 复制，列头可能是合并单元格留下的"题号"之类
    if (HEADER_HINT.test(raw) && students.length === 0) continue;

    const cells = raw.split(SEPARATORS).map((c) => c.trim());
    const [name = '', examNo = '', ...scoreCells] = cells;

    if (name === '') {
      errors.push(`第 ${lineNo} 行：没有姓名。没有名字的成绩单没法发下去。`);
      continue;
    }
    if (examNo === '') {
      errors.push(`第 ${lineNo} 行（${name}）：没有考号。考号是学生身份的唯一可靠标识。`);
      continue;
    }
    if (scoreCells.length !== qCount) {
      errors.push(
        `第 ${lineNo} 行（${name}）：分数列有 ${scoreCells.length} 个，试卷定义了 ${qCount} 道题，对不上。`,
      );
      continue;
    }

    // 同考号重复：会让汇总把两个学生混成一个
    const dup = seenExamNo.get(examNo);
    if (dup !== undefined) {
      errors.push(`第 ${lineNo} 行：考号 ${examNo} 在第 ${dup} 行已经出现过，重复考号会让汇总混淆。`);
      continue;
    }

    const scores: Array<number | null> = [];
    let rowBad = false;
    for (let k = 0; k < scoreCells.length; k++) {
      const token = scoreCells[k] ?? '';
      const q = sheet.questions[k]!;
      const qid = q.questionId;

      if (isBlank(token)) {
        scores.push(null);
        warnings.push(`第 ${lineNo} 行（${name}）：${qid} 未填，将按"未录入"记录并标记需复核。`);
        continue;
      }

      const v = Number(token);
      /*
       * ★ 这里**不能**写 `Number(token) || 0`。
       * `Number('abc')` 是 NaN，`NaN || 0` 是 0 —— 非法输入会被静默
       * 变成 0 分，而 0 分看起来完全正常。这正是 §6.1 记载的那个坑。
       */
      if (!Number.isFinite(v)) {
        errors.push(`第 ${lineNo} 行（${name}）：${qid} 的分数"${token}"不是数字。`);
        rowBad = true;
        break;
      }
      if (v < 0) {
        errors.push(`第 ${lineNo} 行（${name}）：${qid} 的分数是负数（${v}）。`);
        rowBad = true;
        break;
      }
      if (q.fullScore > 0 && v > q.fullScore) {
        errors.push(
          `第 ${lineNo} 行（${name}）：${qid} 的分数 ${v} 超过了该题满分 ${q.fullScore}。`,
        );
        rowBad = true;
        break;
      }
      scores.push(v);
    }

    if (rowBad) continue;

    seenExamNo.set(examNo, lineNo);
    students.push({ name, examNo, scores });
  }

  return { students, errors, warnings };
}

/**
 * 把成绩单组装成 `StudentResult[]`。
 *
 * 总分必须能算出来，所以缺分在**这里**取 0 分 —— 这是唯一自洽的算法。
 * 但必须同时置 `reviewRequested` 并把"未录入"写进评语：
 * 让数据缺口在报表里**看得出来**，而不是伪装成一个 0 分（§6.1）。
 *
 * 手输分数的 `confidence` 取 1：它是确定的输入，不存在模型不确定性。
 * 给它 0.9 会让它莫名其妙地贴近复核阈值，甚至把整卷拖进低置信度统计。
 */
export function buildResults(
  entries: PaperEntry[],
  sheet: ScoreSheet,
  now: () => number = Date.now,
): StudentResult[] {
  const at = now();
  return entries.map((e) => {
    const details: GradingDetail[] = sheet.questions.map((q, idx) => {
      const raw = e.scores[idx] ?? null;
      const missing = raw === null;
      return {
        questionId: q.questionId,
        index: idx,
        type: q.type,
        score: missing ? 0 : raw,
        fullScore: q.fullScore,
        comment: missing ? '本题分数未录入，按 0 分参与汇总，请补录或确认。' : '',
        // 不编造得分点：手工录入没有逐点判定，
        // 编造"命中了某点"等于捏造评分过程
        hitPoints: [],
        missedPoints: [],
        confidence: missing ? 0 : 1,
        reviewRequested: missing,
      };
    });

    return {
      // 用考号构造；dupIndex 保证极端情况下（考号被绕过校验后重复）
      // 两个学生的 id 仍不相同，否则汇总会把两人混成一个
      submissionId: `${e.examNo}@${now()}#${entries.indexOf(e)}`,
      name: e.name,
      examNo: e.examNo,
      details,
      total: details.reduce((a, d) => a + d.score, 0),
      fullTotal: details.reduce((a, d) => a + d.fullScore, 0),
      comment: '',
      gradedAt: at,
    };
  });
}