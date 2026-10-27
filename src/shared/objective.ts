/**
 * 客观题本地比对 —— **纯函数，零网络、零 token**。
 *
 * 为什么必须有这一层：
 *   客观题（选择/判断/填空）的答案在批改前就是确定的，判对错是**字符串比对**
 *   问题，不是理解问题。把它交给大模型有三个坏处：
 *     1. 花 token 做确定性工作，成本与延迟都白付
 *     2. 引入非确定性——同一份答卷两次跑可能不一样，而客观题本该是 100% 可复现
 *     3. 协变量污染：模型一旦答错，你分不清是"题目难"还是"比对错"
 *   所以客观题走本地路径，主观题才走 AI。**两条路径在代码层面隔离**
 *   （PLAN v2.0 P5-3 要求断言覆盖这一点）。
 *
 * 判错代价（决定这里的保守程度）：
 *   - 误判为「对」：学生没做却给分 → 成绩虚高，且**不会有任何人发现**
 *   - 误判为「错」：学生做对却扣分 → 学生申诉，能被发现
 *   两类错误不对称。因此凡是不确定的情况一律判错并**附带原因**，
 *   让上层能提示教师复核，而不是悄悄猜一个。
 */

/** 全角空格 U+3000：它与 ASCII 空格语义一致，单独处理 */
const FULLWIDTH_SPACE = 0x3000;

/**
 * 需要全角→半角的字符**白名单**。
 *
 * 为什么不用「U+FF01~U+FF5E 整段减掉几个例外」：
 * 那个区间里混着实用的中文标点——`，`(U+FF0C) `。`(U+FF0E) `；`(U+FF1B)
 * `：`(U+FF1A) `？`(U+FF1F) `！`(U+FF01) `、`(U+FF0C) 等。
 * 整段处理会把「他说，好」改成「他说,好」，破坏语文答案的原文。
 * 第一版就是这么写的（注释写着"不动中文标点"但代码动了），被单测抓出来。
 *
 * 白名单只保留**输入法手滑会产生、且语义与 ASCII 完全等价**的字符：
 * 数字、字母、括号与几个纯 ASCII 意义上的符号。
 */
const FULLWIDTH_MAP: ReadonlySet<number> = new Set([
  // ０-９
  ...Array.from({ length: 10 }, (_, i) => 0xff10 + i),
  // Ａ-Ｚ
  ...Array.from({ length: 26 }, (_, i) => 0xff21 + i),
  // ａ-ｚ
  ...Array.from({ length: 26 }, (_, i) => 0xff41 + i),
  // （）〔〕 —— 与 ASCII 括号语义一致
  0xff08, 0xff09, 0xff3b, 0xff3d,
  // ． ＿ ～ ＠ ＋ － ＊ ／ ＝
  0xff0e, 0xff3f, 0xff5e, 0xff20, 0xff0b, 0xff0d, 0xff0a, 0xff0f, 0xff1d,
  // ／ 之外的 \ ｜ ＜ ＞
  0xff3c, 0xff5c, 0xff1c, 0xff1e,
  // ＇ ＂
  0xff07, 0xff02,
]);

/**
 * 全角转半角。
 *
 * 只处理 `FULLWIDTH_MAP` 白名单内的字符，加上全角空格 U+3000。
 * **刻意不动中文文字与中文标点**（`，` `。` `；` `：` `？` `！` `、` 全部保留）——
 * 语文/英语答案里中文标点可能就是答案的一部分。
 *
 * 第一版误用了 U+FF01~U+FF5E 整段区间，把「，」转成了「,」，
 * 被 `objective.test.ts` 的「不动中文标点」用例抓出。
 */
export function toHalfWidth(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code === FULLWIDTH_SPACE) {
      out += ' ';
    } else if (FULLWIDTH_MAP.has(code)) {
      out += String.fromCodePoint(code - 0xfee0);
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * 去掉不可见字符。
 *
 * 来源很杂：Word 复制粘贴带零宽空格、PDF 提取带软连字符、
 * 手输时误触组合键带 BOM。它们**肉眼完全看不见**，
 * 却会让比对失败——这是最典型的"看起来一模一样但判错"。
 * 教师遇到这种只能靠猜，所以必须在比对前统一清除。
 */
export function stripInvisible(s: string): string {
  return s
    // 零宽与方向控制符：U+200B~U+200F（含零宽空格/连接符/ZWNJ/双向标记）
    .replace(/[\u200b-\u200f]/g, '')
    // BOM / 零宽不换行空格
    .replace(/[\ufeff\u2060]/g, '')
    // 软连字符（PDF 断行处常见）
    .replace(/\u00ad/g, '')
    // 其余 C0/C1 控制字符，但保留 \t \n
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

export interface NormalizeOptions {
  /**
   * 忽略大小写。默认 true。
   * 英语答案 "Apple" / "apple" 视为相同；若某题确实区分大小写
   * （如化学符号 "Co" 钴 vs "CO" 一氧化碳），调用方传 false。
   */
  ignoreCase?: boolean;
  /**
   * 忽略所有空白。默认 true。
   * 手写转文字、跨行粘贴会带多余空格制表符，而学生不会在意这些。
   */
  ignoreSpace?: boolean;
  /**
   * 常见标点等价表。默认 true。
   * 把手输时的中文标点与英文标点视为相同：，。？！；：、（）【】
   * 注意：**只在比对时等价，不改变原答案**（原答案要保留给学生看）。
   */
  unifyPunct?: boolean;
}

const PUNCT_EQUIV: Record<string, string> = {
  '，': ',', '。': '.', '？': '?', '！': '!', '；': ';',
  '：': ':', '、': ',', '（': '(', '）': ')', '【': '[',
  '】': ']', '「': '"', '」': '"', '《': '<', '》': '>',
};

/**
 * 答案归一化。**只用于比对，不用于展示**。
 *
 * 归一化的每一步都对应一类真实的等价写法，不是凭感觉加的：
 * 全角（中文输入法手滑）、不可见字符（复制粘贴）、
 * 大小写与空白（学生不在意）、标点变体（手输）。
 *
 * 关键设计：**空答案归一化后仍是空**，且不接受任何"模糊匹配"。
 * 绝不能让"没作答"匹配上"正确答案"。
 */
export function normalizeAnswer(raw: string, opts: NormalizeOptions = {}): string {
  const { ignoreCase = true, ignoreSpace = true, unifyPunct = true } = opts;

  let s = stripInvisible(String(raw ?? ''));
  s = toHalfWidth(s);
  if (unifyPunct) {
    s = [...s].map((c) => PUNCT_EQUIV[c] ?? c).join('');
  }
  if (ignoreCase) {
    s = s.toLowerCase();
  }
  if (ignoreSpace) {
    s = s.replace(/\s+/g, '');
  } else {
    // 不忽略空白也要收敛连续空白与首尾，否则 "a  b" 与 "a b" 不等
    s = s.trim().replace(/[ \t]+/g, ' ');
  }
  return s;
}

/** 归一化后是否为空（含全角空格、零宽字符等"看起来有内容"的情况） */
export function isBlank(raw: string, opts: NormalizeOptions = {}): boolean {
  return normalizeAnswer(raw, opts).length === 0;
}

export type ObjectiveVerdict =
  /** 归一化后完全一致 */
  | 'correct'
  /** 与备选答案之一一致 */
  | 'correct_alt'
  /** 学生未作答（归一化后为空）——**不是错，是缺考**，上层应分别统计 */
  | 'blank'
  /** 明确不一致 */
  | 'wrong'
  /** 疑似写法差异，需要人工确认（不自动给分） */
  | 'suspect';

export interface ObjectiveResult {
  verdict: ObjectiveVerdict;
  /** 是否应当计分。只有 correct / correct_alt 为 true */
  awarded: boolean;
  /** 归一化后的学生答案（诊断用，便于教师看出是什么差异） */
  normalized: string;
  /** 归一化后的标准答案 */
  expected: string;
  /** 人类可读的判定原因。**判错时必须给出**，否则教师无从复核 */
  reason: string;
  /** 是否需要人工复核。suspect / 疑似都是 true */
  needsReview: boolean;
}

export interface CompareOptions extends NormalizeOptions {
  /**
   * 等价答案列表（同一题的不同正确写法）。
   * 填空题常见：正确答案「3」与「三」都算对，但不应把这种宽松
   * 训练到归一化层——它是**题目级**的，由教师逐题给。
   */
  acceptable?: string[];
  /**
   * 选项内容映射：把「选项内容」反查成「选项字母」。
   *
   * 为什么需要：选择题里学生可能不写字母而写选项原文
   * （尤其手写答题卡被识别成文字时）。这**不能直接判对**——
   * 因为无法确认学生指的是同一选项，但如果直接判错又会冤枉学生。
   * 所以判为 suspect 并请教师确认。这是本模块唯一一处"模糊判定"，
   * 且**绝不自动给分**。
   */
  optionText?: Record<string, string>;
}

/**
 * 比对单个客观题答案。
 *
 * 顺序刻意如此：先判空，再判精确，最后才考虑疑似。
 * 把「空」放在最前面是因为**空答案匹配空标准答案是致命错误**——
 * 一道题如果标准答案字段没填，所有没作答的学生都会被判对。
 *
 * @param student 学生答案（原始文本）
 * @param expected 标准答案（原始文本）
 */
export function compareObjective(
  student: string,
  expected: string,
  opts: CompareOptions = {},
): ObjectiveResult {
  const normOpts: NormalizeOptions = {
    ignoreCase: opts.ignoreCase,
    ignoreSpace: opts.ignoreSpace,
    unifyPunct: opts.unifyPunct,
  };
  const s = normalizeAnswer(student, normOpts);
  const e = normalizeAnswer(expected, normOpts);

  // ① 标准答案为空 → 题目本身有问题，绝不能因此给分
  if (e.length === 0) {
    return {
      verdict: 'wrong',
      awarded: false,
      normalized: s,
      expected: e,
      reason: '标准答案为空，无法比对。请检查该题的答案是否已录入。',
      needsReview: true,
    };
  }

  // ② 学生未作答 → 与「做错」区分开，上层要分别统计
  if (s.length === 0) {
    return {
      verdict: 'blank',
      awarded: false,
      normalized: s,
      expected: e,
      reason: '学生未作答',
      needsReview: false,
    };
  }

  // ③ 精确一致（归一化后）
  if (s === e) {
    return {
      verdict: 'correct',
      awarded: true,
      normalized: s,
      expected: e,
      reason: '与标准答案一致',
      needsReview: false,
    };
  }

  // ④ 备选答案
  for (const alt of opts.acceptable ?? []) {
    if (normalizeAnswer(alt, normOpts) === s) {
      return {
        verdict: 'correct_alt',
        awarded: true,
        normalized: s,
        expected: e,
        reason: `与备选答案「${alt}」一致`,
        needsReview: false,
      };
    }
  }

  // ⑤ 疑似：学生写的是选项内容而非字母
  if (opts.optionText) {
    for (const [letter, text] of Object.entries(opts.optionText)) {
      const t = normalizeAnswer(text, normOpts);
      if (t.length > 0 && t === s) {
        return {
          verdict: 'suspect',
          awarded: false,
          normalized: s,
          expected: e,
          reason:
            `学生写的是选项 ${letter} 的内容「${text}」而非选项字母。` +
            `本模块不自动给分——请人工确认。`,
          needsReview: true,
        };
      }
    }
  }

  return {
    verdict: 'wrong',
    awarded: false,
    normalized: s,
    expected: e,
    reason: `与标准答案不一致（学生「${s}」≠ 标准「${e}」）`,
    needsReview: false,
  };
}

/**
 * 从选择题的选项文本反查选项字母。
 *
 * 只在文本**唯一命中**时返回字母。命中多个（两个选项文字相同）时返回 null
 * 并置 ambiguous——这种情况下自动判定必然出错，必须由人决定。
 */
export function matchOptionLetter(
  student: string,
  options: Record<string, string>,
  opts: NormalizeOptions = {},
): { letter: string | null; ambiguous: boolean } {
  const s = normalizeAnswer(student, opts);
  if (s.length === 0) return { letter: null, ambiguous: false };

  const hits = Object.entries(options)
    .filter(([, text]) => normalizeAnswer(text, opts).length > 0)
    .filter(([, text]) => normalizeAnswer(text, opts) === s)
    .map(([letter]) => letter);

  if (hits.length === 1) return { letter: hits[0], ambiguous: false };
  if (hits.length === 0) return { letter: null, ambiguous: false };
  return { letter: null, ambiguous: true };
}

/**
 * 各判定对应的置信度。
 *
 * 为什么"判错"给 1.0 而不是低分：本地比对对"不一致"这个结论本身是**确定的**
 * （归一化后字符串确实不同），不确定的是"这个差异是否有意义"。
 * 如果给判错一个低置信度，复核队列会被大量正常错题淹没，
 * 真正的可疑项（suspect）反而被埋掉。
 *
 * suspect 给 0.5：低于 0.75 阈值，必然进复核队列——这正是我们要的。
 * 它不给分，但也不会被当成"确定的错"计入错误率。
 */
export const VERDICT_CONFIDENCE: Record<ObjectiveVerdict, number> = {
  correct: 1,
  correct_alt: 1,
  blank: 1,
  wrong: 1,
  suspect: 0.5,
};

/**
 * 把一个比对结果转成可落库的评分明细字段。
 *
 * 抽成函数而不是让各处自己拼：置信度与复核标记的取值规则只应存在一处，
 * 否则"客观题该不该进复核队列"会在多个调用点各写一遍、各写错一遍。
 */
export function toDetailFields(r: ObjectiveResult): {
  score: number;
  confidence: number;
  reviewRequested: boolean;
  comment: string;
  hitPoints: string[];
  missedPoints: string[];
  local: true;
} {
  return {
    score: r.awarded ? 1 : 0,
    confidence: VERDICT_CONFIDENCE[r.verdict],
    reviewRequested: r.needsReview,
    comment: r.reason,
    hitPoints: r.awarded ? [r.reason] : [],
    missedPoints: r.awarded ? [] : [r.reason],
    local: true,
  };
}

export interface BatchItem {
  id: string;
  student: string;
  expected: string;
}

export interface BatchSummary {
  results: Array<ObjectiveResult & { id: string }>;
  /** 各判定的计数。**blank 与 wrong 分开**——缺考率与错误率是两回事 */
  counts: Record<ObjectiveVerdict, number>;
  /** 需要教师复核的题目 id */
  reviewIds: string[];
  /** 总题数 */
  total: number;
  /** 得分题数（awarded === true） */
  awardedCount: number;
}

/**
 * 批量比对。纯计算，不涉及 IO 与网络——
 * P5-2 的「零网络」验收就是断言这个函数运行期 fetch 从未被调用。
 */
export function compareBatch(items: BatchItem[], opts: CompareOptions = {}): BatchSummary {
  const results = items.map((it) => ({
    id: it.id,
    ...compareObjective(it.student, it.expected, opts),
  }));

  const counts: Record<ObjectiveVerdict, number> = {
    correct: 0, correct_alt: 0, blank: 0, wrong: 0, suspect: 0,
  };
  for (const r of results) counts[r.verdict] += 1;

  return {
    results,
    counts,
    reviewIds: results.filter((r) => r.needsReview).map((r) => r.id),
    total: results.length,
    awardedCount: results.filter((r) => r.awarded).length,
  };
}