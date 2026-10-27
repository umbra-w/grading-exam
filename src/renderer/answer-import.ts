/**
 * 批量上传答卷图片识别（SPEC F3.4）—— 纯逻辑层。
 *
 * ── 这个模块在整条链路里的位置 ────────────────────────────────────
 *
 *   选图 → 质量闸门 → 逐张视觉识别 → **本模块** → StudentSubmission[]
 *   （薄绑定） （quality.ts） （visionAnswers）  解析/规范化/对齐/去重   （整卷聚合/导出）
 *
 * 本模块**是纯逻辑**：不读文件、不联网、不启动任务、不改入参。
 * 因此它能被 vitest 直接覆盖（§4.4）。真正的薄绑定只有两处，将分别放在
 * （待建的）`ImportImagesPanel` 面板与主进程 handler 里：
 *   · 读图片文件并编码成 base64（依赖 fs）
 *   · 调 `ai:visionAnswers`（依赖真实 API Key + 视觉模型）
 * 这两处标了 `⚠ 未验证`，因为**没有真实 API Key 时无法端到端跑通**。
 * 用户界面上必须把这一点说出来，不能让它看起来像"已经能识别了"。
 *
 * ── 草稿的用途（要说清楚，不能夸大）───────────────────────────────
 *
 * `buildDraftText` 与整卷录入（`paper-entry.ts`）共用「姓名,考号,列…」的
 * 表头口径，但**内容是答案文本，不是分数** —— 视觉识别的是学生写了什么，
 * 分数要等评完才有。所以草稿的用途是**人工核对识别结果**（对照原卷看
 * 认得对不对），不能直接粘进分数面板：那里只收数字，非数字会被正确地
 * 报错拒收（paper-entry 的纪律：非法输入绝不静默当 0）。
 * 老师誊录成分数后再粘，才是对的用法 —— 两个入口共用表头，
 * 为的是誊录时列对得齐，而不是声称"识别结果可直接入分"。
 *
 * ── 三条纪律（详见测试文件里的说明）───────────────────────────────
 *
 * 1. 认不出的题号进 `unmatched`，绝不静默丢弃（§6.1 静默失败的典型场景）
 * 2. 姓名/考号认不出时保留为空 + 标记待复核，**不编造占位名**
 *    （提示词里明确写了"不要猜测"，这一层必须对得上）
 * 3. 缺答案 = "不在 answers 里"，不是"空字符串" —— 两者在复核时要能区分
 */
import type { ImagePart, QuestionMeta, StudentAnswer, StudentSubmission } from '@shared/types';

/** 试卷题目定义的最小形状 —— 从 shared 原样转出，测试与调用方不必各引一处 */
export type { QuestionMeta };

/** 视觉模型返回的一条逐题转录（与 `prompts.ts` 的 VISION_JSON_SCHEMA 对应） */
export interface RawVisionAnswer {
  /** 题号原文。模型可能给数字、也可能给"第1题"之类，故保持字符串 */
  index: string | number;
  /** 保真转录文本；无法辨认处用 □，未作答为空 */
  text: string;
}

/** 视觉模型对一整张答卷的识别结果 */
export interface RawVisionSheet {
  name: string;
  examNo: string;
  answers: RawVisionAnswer[];
}

export interface ParseSheetOutcome {
  ok: boolean;
  sheet?: RawVisionSheet;
  /** 必须展示：单条 answer 坏掉时整张卷子照常可用，但问题要让人看到 */
  errors: string[];
}

/** 题号对不上时保留的原始记录 —— 供人工定位，绝不丢弃 */
export interface UnmatchedAnswer {
  rawIndex: string;
  text: string;
}

export interface SheetAlignment {
  submission: StudentSubmission;
  /** 试卷里有、但这张卷子没识别出答案的题 */
  missing: string[];
  /** 识别出了、但对不上试卷任何一题的答案（含题号认不出与超范围） */
  unmatched: UnmatchedAnswer[];
  /** 需要人工核对（姓名/考号缺失、题号认不出、空转录等） */
  needsReview: boolean;
  warnings: string[];
}

export interface AlignOptions {
  /** 这张图在本次导入里的序号（从 1 起），用于生成无标识时的 id */
  importIndex?: number;
  /** 已占用的 submission id 集合，用于重名去重 */
  usedIds?: Set<string>;
}

/* ------------------------------------------------------------------ 题号 */

/** 单个中文数字字符 → 数值 */
const CN_DIGIT: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/**
 * 中文数字串 → 数值（支持 1..99，覆盖一份卷子的题号绰绰有余）。
 *
 * 为什么不引第三方库：只需认"一二三…十九、二十、二十三"这几种写法，
 * 而题号绝不会超过 99。范围小反而好穷举、好测 —— 也不会因为引入依赖
 * 而给"不联网"这条约束添一个需要审计的点。
 *
 * 认不出返回 null（例如"两"单独出现、或"三三"这种非法组合）。
 */
function parseChineseNumber(input: string): number | null {
  const s = input.trim();
  if (!s) return null;

  // 十、十一…十九；二十、二十三…九十九
  if (s === '十') return 10;
  if (s.startsWith('十')) {
    const rest = s.slice(1);
    if (rest.length === 1 && CN_DIGIT[rest] !== undefined) return 10 + CN_DIGIT[rest]!;
    return null;
  }
  const shiAt = s.indexOf('十');
  if (shiAt > 0) {
    const head = s.slice(0, shiAt);
    const tail = s.slice(shiAt + 1);
    if (head.length !== 1 || CN_DIGIT[head] === undefined) return null;
    const tens = CN_DIGIT[head]!;
    if (tens === 0) return null;
    if (tail === '') return tens * 10;
    if (tail.length === 1 && CN_DIGIT[tail] !== undefined) return tens * 10 + CN_DIGIT[tail]!;
    return null;
  }

  // 纯个位
  if (s.length === 1) {
    const v = CN_DIGIT[s];
    return v === undefined ? null : v;
  }
  return null;
}

/**
 * 规范化题号 → 正整数，或 `null`（认不出）。
 *
 * **"认不出"必须是 null，不能猜。** 若这里返回一个兜底数字，学生的答案
 * 会落到错误的题目上，而汇总结果看起来完全正常 —— 这就是本项目反复
 * 强调的静默失败（§6.1）。
 *
 * 接受：`1` / ` 3 ` / `第1题` / `第 12 题` / `1.` / `1、` / `（1）` / `(1)` /
 *       `题1` / `1题` / `一` / `第一题` / `十一` / `二十三`
 * 拒绝：空串 / `附加题` / `作文` / `abc` / `0` / `-1` / `1 2`（多个数字无法确定）
 */
export function normalizeQuestionNo(input: string | number): number | null {
  if (typeof input === 'number') {
    return Number.isInteger(input) && input > 0 ? input : null;
  }
  if (typeof input !== 'string') return null;

  let s = input.trim();
  if (!s) return null;

  // ── 关键顺序：先把「第N题」这种带修饰的写法认掉，再退回纯数字。
  //    不能先把括号/空白全删掉再统一匹配 —— 那样 `第1题(2)` 会变成 `12`，
  //    `1 2` 也会变成 `12`，等于**凭空猜出一个题号**，
  //    答案会落到错误的题目上而汇总看起来完全正常（§6.1）。
  //    所以修饰识别必须走"整串匹配"，匹配不上就宁可判认不出。

  // ① 第 <数字> 题   （`第 12 题`、`第一题`）
  const di = /^第\s*([0-9]+|[一二三四五六七八九十两]+)\s*题?\s*$/.exec(s);
  if (di) return toPositiveInt(di[1]!);

  // ② <数字> 题      （`1题`、`一题`）；以及 题 <数字>（`题1` —— 题字写在前面的写法）
  const ti = /^([0-9]+|[一二三四五六七八九十两]+)\s*题$/.exec(s);
  if (ti) return toPositiveInt(ti[1]!);
  const qi = /^题\s*([0-9]+|[一二三四五六七八九十两]+)$/.exec(s);
  if (qi) return toPositiveInt(qi[1]!);

  // ③ 圆括号 / 方括号包裹      （`（1）`、`(1)`、`[1]`）
  const br = /^[（(\[【]\s*([0-9]+|[一二三四五六七八九十两]+)\s*[)）\]】]\s*$/.exec(s);
  if (br) return toPositiveInt(br[1]!);

  // ④ 数字 + 单个尾随分隔符      （`1.`、`1、`、`1,`、`1）`）
  const dot = /^([0-9]+)\s*[.、,，:：)）\]]\s*$/.exec(s);
  if (dot) return toPositiveInt(dot[1]!);

  // ⑤ 纯内容：去掉空白后必须是**单个**数字序列或单个中文数字。
  //    这一步同时挡住 `1 2`（去空白后是 12，但原文含空白 ⇒ 无法确定题号）
  //    与 `1 和 2` 这类写法。
  const compact = s.replace(/[\s\u3000]/g, '');
  if (/^\d+$/.test(compact)) {
    // 原文里含空白且去空白后成了多位数字 ⇒ 是"多个数字"而非一个题号
    if (/\s/.test(s.trim())) return null;
    return toPositiveInt(compact);
  }
  if (/^[一二三四五六七八九十两]+$/.test(compact)) {
    if (/\s/.test(s.trim())) return null;
    return toPositiveInt(compact);
  }

  return null;
}

/** 把"数字串或中文数字串"转成正整数；≤0 或认不出返回 null */
function toPositiveInt(token: string): number | null {
  let n: number | null = null;
  if (/^\d+$/.test(token)) {
    n = Number(token);
  } else {
    n = parseChineseNumber(token);
  }
  if (n === null || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

/* ------------------------------------------------------- 姓名 / 考号 */

/** 字段名前缀（中英文、全半角冒号、以及不带冒号的空格形式） */
const NAME_PREFIX = /^(姓名|学生姓名|名字|学生)\s*[:：]?\s*/;
const EXAM_NO_PREFIX = /^(考号|学号|准考证号|考生号|座号|编号)\s*[:：]?\s*/;

/** 表示"认不出"的记号：空、方框占位符、常见缺省词 */
const UNRECOGNIZED = new Set(['', '□', '?', '？', '-', '—', '无', '未', '未知', '不详', 'none', 'null', 'n/a']);

function stripPrefixAndUnrecognized(raw: unknown, prefix: RegExp): string {
  if (typeof raw !== 'string') return '';
  // 只去首尾空白与字段名前缀，**不动中间的空格** ——
  // 像"阿依古丽 买买提"这样的姓名，中间的空格是有意义的一部分。
  let s = raw.replace(/^\s+|\s+$/g, '');
  const stripped = s.replace(prefix, '').replace(/^\s+|\s+$/g, '');
  s = stripped;
  if (UNRECOGNIZED.has(s.toLowerCase()) || UNRECOGNIZED.has(s)) return '';
  return s;
}

/** 清洗姓名。认不出返回空串 —— 由调用方标记待复核，不在此处编造。 */
export function cleanName(raw: unknown): string {
  return stripPrefixAndUnrecognized(raw, NAME_PREFIX);
}

/** 清洗考号。规则同 `cleanName`。 */
export function cleanExamNo(raw: unknown): string {
  return stripPrefixAndUnrecognized(raw, EXAM_NO_PREFIX);
}

/* ------------------------------------------------------- 解析模型输出 */

/** 从可能裹着 markdown 代码块 / 前后杂字的文本里取出 JSON */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const body = fence?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(body);
  } catch {
    // 退一步：截取第一个 { 到最后一个 }，对付"识别结果如下：{...}，谢谢"
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(body.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

/**
 * 解析视觉模型对一张答卷的返回。
 *
 * 宽进严出：结构不合法的整体判失败并给出原因；**单条 answer 坏掉时只跳过它**
 * 并记进 `errors`，不牵连整张卷子 —— 一张图里坏一条就让学生整个重来的代价太大。
 * 但跳过的条数必须说出来，否则就是"静默少一道题"。
 */
export function parseVisionSheet(input: unknown): ParseSheetOutcome {
  const errors: string[] = [];

  let data: unknown = input;
  if (typeof input === 'string') {
    data = extractJson(input);
    if (data === undefined) {
      return { ok: false, errors: ['返回内容不是合法 JSON，无法解析'] };
    }
  }

  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, errors: ['返回内容不是对象结构'] };
  }

  const obj = data as Record<string, unknown>;
  const rawAnswers = obj['answers'];
  if (!Array.isArray(rawAnswers)) {
    return { ok: false, errors: ['缺少 answers 数组（提示词要求逐题列出，即使未作答）'] };
  }
  if (rawAnswers.length === 0) {
    return { ok: false, errors: ['answers 是空数组 —— 这张图里没识别出任何题目'] };
  }

  const answers: RawVisionAnswer[] = [];
  rawAnswers.forEach((item, i) => {
    const n = i + 1;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`第 ${n} 条 answer 不是对象，已跳过`);
      return;
    }
    const rec = item as Record<string, unknown>;
    const idx = rec['index'];
    const text = rec['text'];
    if (typeof idx !== 'string' && typeof idx !== 'number') {
      errors.push(`第 ${n} 条 answer 缺少可用的 index，已跳过`);
      return;
    }
    if (typeof text !== 'string') {
      errors.push(`第 ${n} 条 answer 的 text 不是字符串，已跳过`);
      return;
    }
    answers.push({ index: idx, text });
  });

  if (answers.length === 0) {
    errors.push('所有 answer 都不合法，没有可用的题目转录');
    return { ok: false, errors };
  }

  return {
    ok: true,
    sheet: {
      name: cleanName(obj['name']),
      examNo: cleanExamNo(obj['examNo']),
      answers,
    },
    errors,
  };
}

/* ------------------------------------------------- 图片枚举 / 学生 id */

export interface SheetFileSlot {
  fileName: string;
  importIndex: number;
}

/**
 * 把选中的图片文件排成待处理队列。
 *
 * 用**自然排序**（`photo2` 排在 `photo10` 前面）：老师从手机导出的图片
 * 常带数字后缀，按字典序会得到 photo1, photo10, photo2 这种顺序，
 * 而顺序决定 `importIndex`，进而影响无标识卷子的 id。排序错了，
 * 后续人工核对时"第几张"就对不上。
 */
export function enumerateSheets(fileNames: readonly string[]): SheetFileSlot[] {
  const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  return [...fileNames]
    .sort((a, b) => collator.compare(a, b))
    .map((fileName, i) => ({ fileName, importIndex: i + 1 }));
}

export interface IdentityInput {
  name: string;
  examNo: string;
  importIndex: number;
}

/**
 * 生成 submission id，并保证不与 `usedIds` 里已有的冲突。
 *
 * 优先级：考号 → 姓名（重名加 -2/-3）→ 导入序号。
 * **绝不覆盖已有的学生**：批量导入时若有重名，"第二个张三"被默默合并进
 * 第一个，直接导致一个学生的成绩消失。
 *
 * 注意本函数会**就地写入 `usedIds`**，这是刻意的 —— 调用方逐张处理时
 * 不必自己维护集合，少一处能忘。
 */
export function uniqueSubmissionId(identity: IdentityInput, usedIds: Set<string>): string {
  const base = identity.examNo || identity.name || `导入-${identity.importIndex}`;
  let id = base;
  let n = 1;
  while (usedIds.has(id)) {
    n += 1;
    id = `${base}-${n}`;
  }
  usedIds.add(id);
  return id;
}

/* --------------------------------------------------------------- 对齐 */

/** 仅判断"是否有可见内容"，不做任何修改（不改入参的纪律） */
function hasVisibleText(s: string): boolean {
  return s.replace(/[\s\u3000]/g, '').length > 0;
}

/**
 * 把一张答卷的识别结果对齐到试卷的题目定义上。
 *
 * 这是本模块的核心。三个输出必须分开：
 *   · `submission.answers` —— 对上的题（只有这些会被送去评分）
 *   · `missing`            —— 试卷里有、这张卷子没识别出（"缺答案"）
 *   · `unmatched`          —— 识别出了但对不上（"多出来/认不出"，含原文）
 * 把 `unmatched` 丢掉是最容易犯的错，也最难发现：总分照算，只是少了一道题。
 *
 * 不收 `paperId`：对齐只依赖题目定义；试卷标识是批量层（`buildBatchImport`）
 * 的职责 —— 收了不用的参数只会让签名撒谎。
 */
export function alignSheet(
  raw: RawVisionSheet,
  questions: readonly QuestionMeta[],
  opts: AlignOptions = {},
): SheetAlignment {
  const warnings: string[] = [];
  const missing: string[] = [];
  const unmatched: UnmatchedAnswer[] = [];
  const answers: StudentAnswer[] = [];
  const filled = new Set<string>();

  const byOrdinal = (n: number): QuestionMeta | undefined => questions[n - 1];

  for (const item of raw.answers) {
    const rawIndex = String(item.index);
    const n = normalizeQuestionNo(item.index);

    if (n === null) {
      unmatched.push({ rawIndex, text: item.text });
      warnings.push(`题号「${rawIndex}」认不出对应哪一题，已保留原文待人工核对`);
      continue;
    }

    // 先按 questionId 精确匹配，再退回按序号 —— 试卷 id 不是紧凑序号时的
    // 常见情形（如只考第 3、4 题，id 里仍带 0003 / 0004）
    let q = questions.find((x) => x.questionId === rawIndex);
    if (!q && n >= 1 && n <= questions.length) q = byOrdinal(n);

    if (!q) {
      unmatched.push({ rawIndex, text: item.text });
      warnings.push(`题号「${rawIndex}」超出试卷题目范围（试卷共 ${questions.length} 题）`);
      continue;
    }

    if (filled.has(q.questionId)) {
      warnings.push(`第 ${n} 题（${q.questionId}）出现重复转录，已保留第一次的结果`);
      continue;
    }

    if (!hasVisibleText(item.text)) {
      // 空白转录 = 没识别出来（或确实未作答），计为缺失而不是"答了空"
      missing.push(q.questionId);
      filled.add(q.questionId);
      continue;
    }

    filled.add(q.questionId);
    answers.push({ questionId: q.questionId, text: item.text });
  }

  for (const q of questions) {
    if (!filled.has(q.questionId) && !missing.includes(q.questionId)) missing.push(q.questionId);
  }

  // 缺少识别内容的题按试卷顺序排列，便于逐题核对
  missing.sort((a, b) => questions.findIndex((q) => q.questionId === a) - questions.findIndex((q) => q.questionId === b));

  const nameMissing = !raw.name;
  const examMissing = !raw.examNo;
  if (nameMissing) warnings.push('姓名未能识别，需人工补填后再汇总（不能拿图片序号当姓名）');
  if (examMissing) warnings.push('考号未能识别，建议人工补填以便与平台名单对应');

  const id = uniqueSubmissionId(
    { name: raw.name, examNo: raw.examNo, importIndex: opts.importIndex ?? 1 },
    opts.usedIds ?? new Set<string>(),
  );

  return {
    submission: {
      id,
      name: raw.name,
      examNo: raw.examNo,
      answers,
      extractedDraft: buildDraftText(raw, questions),
    },
    missing,
    unmatched,
    // 认不出题号 / 有缺题 / 缺标识 都要人看一眼 —— 但**不阻塞**导入，
    // 否则一张难认的卷子会让整个批次卡住。
    needsReview: nameMissing || examMissing || unmatched.length > 0 || missing.length > 0,
    warnings,
  };
}

/* ------------------------------------------------------------- 草稿 */

const HEADER = (questions: readonly QuestionMeta[]): string =>
  ['姓名', '考号', ...questions.map((q) => q.questionId)].join(',');

/**
 * CSV 单元格转义（RFC 4180 口径）。
 *
 * 必须转义的两个字符是 `,` 与 `"`，另外换行也要包起来 —— 数学答案里
 * 出现逗号很常见（如 `a,b`），一段作文转录里出现换行也常见。
 * 不转义的后果是把一行学生数据切成错位的单元格，而解析器会报
 * "分数列数对不上" —— 一个由转义缺失引起的、看起来像数据错误的报错。
 */
function csvCell(s: string): string {
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * 生成供人工核对识别结果的草稿文本（CSV 口径）。
 *
 * 表头与 `paper-entry.ts` 的分数表共用同一套「姓名,考号,列…」结构 ——
 * 为的是老师誊录时列对得齐。但**格子里是答案文本，不是分数**：
 * 视觉识别的是"学生写了什么"，分数要等评完才有。直接把它粘进分数面板
 * 会被 `parseScoresText` 正确拒收（非数字必须报错），这是刻意的防错。
 *
 * 未识别出的题留空单元格，让"哪里缺"在人工核对时一眼可见。
 */
export function buildDraftText(raw: RawVisionSheet, questions: readonly QuestionMeta[]): string {
  const map = new Map<string, string>();
  for (const item of raw.answers) {
    const n = normalizeQuestionNo(item.index);
    if (n === null) continue;
    let q = questions.find((x) => x.questionId === String(item.index));
    if (!q && n >= 1 && n <= questions.length) q = questions[n - 1];
    if (!q || map.has(q.questionId)) continue;
    if (!hasVisibleText(item.text)) continue;
    map.set(q.questionId, item.text);
  }

  const header = HEADER(questions);
  const row = [
    csvCell(raw.name),
    csvCell(raw.examNo),
    ...questions.map((q) => csvCell(map.get(q.questionId) ?? '')),
  ].join(',');

  return `${header}\n${row}`;
}

/* --------------------------------------------------- 批量处理（纯逻辑） */

export interface ImportPlanItem {
  slot: SheetFileSlot;
  /** 该图的质量判定结果（由外面的质量闸门传入，本模块不自己算） */
  verdict?: string;
}

export interface BatchImportResult {
  submissions: StudentSubmission[];
  /** 逐张的对齐细节，供界面逐条展示"缺了哪题、多了什么" */
  alignments: SheetAlignment[];
  errors: string[];
  warnings: string[];
}

/**
 * 把一串"已识别好的答卷"汇总成本次导入的结果。
 *
 * 之所以接受**已识别好的** `RawVisionSheet[]` 而不是自己去调 API：
 * 保持本函数是纯的，从而可测。调用方的循环结构是：
 *   逐张读文件 → 质量闸门 → visionAnswers → parseVisionSheet → 收集
 * 然后一次性交给这里做对齐与去重。
 *
 * 单张失败不中断整批：某张图认不出来只影响那一张，其余照常导入 ——
 * 否则老师要为了 1 张坏图重传 50 张。
 */
export function buildBatchImport(
  sheets: readonly RawVisionSheet[],
  questions: readonly QuestionMeta[],
  paperId: string,
): BatchImportResult {
  const usedIds = new Set<string>();
  const submissions: StudentSubmission[] = [];
  const alignments: SheetAlignment[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  sheets.forEach((raw, i) => {
    const a = alignSheet(raw, questions, { importIndex: i + 1, usedIds });
    alignments.push(a);
    submissions.push(a.submission);
    if (a.unmatched.length > 0) {
      warnings.push(`第 ${i + 1} 张：有 ${a.unmatched.length} 条答案对不上题目，已保留原文`);
    }
    if (a.missing.length > 0) {
      warnings.push(`第 ${i + 1} 张：有 ${a.missing.length} 道题没有识别出答案`);
    }
  });

  if (sheets.length === 0) {
    // 错误里带上试卷标识：老师可能同时导入多套卷子，光说"没有答卷"
    // 分不清是哪套出的问题
    errors.push(`试卷 ${paperId}：没有可导入的答卷（未选中图片，或全部识别失败）`);
  }

  return { submissions, alignments, errors, warnings };
}

/** 供界面展示的图片质量判定文案（与 quality.ts 的 verdict 对应） */
export function describeImportGate(verdict: string | undefined): string {
  switch (verdict) {
    case 'ok':
      return '图片质量可用';
    case 'marginal':
      return '图片偏小/偏糊，识别结果可能有误，建议核对';
    case 'poor':
      return '图片质量差，识别结果不可靠，建议重拍';
    case 'insufficient':
      return '图片信息不足，无法判断质量，识别结果需人工核对';
    default:
      return '未做质量检查（直接提交给模型）';
  }
}

/** 声明本模块依赖但**未验证**的边界，供界面与文档原样引用（§1.2 诚实纪律） */
export const IMPORT_UNVERIFIED_NOTE =
  '图片识别的视觉模型调用未在真机验证过：需要真实 API Key 与支持视觉的模型。' +
  '识别结果一律先进草稿供人工核对，不会直接进入评分。';

/** 便于调用方构造 ImagePart 时的类型提示（本模块不做编码） */
export type SheetImage = ImagePart;