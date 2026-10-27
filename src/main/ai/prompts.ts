/**
 * 提示词模板 —— 冻结对象之一（对应 PLAN v2.0 §3 E1-2）。
 *
 * 两条硬约束：
 *  1. **提示词必须版本化**。改一个字就会改变所有评分结果，
 *     所以每次 AI 调用都把 `PROMPT_VERSION` 与 `PROMPT_SET_HASH` 记进评测记录，
 *     否则事后无法回答"这批结果用的是哪版提示词"。
 *  2. **模型必须输出结构化 JSON**，且包含 `confidence` 与 `reviewRequested`。
 *     没有置信度，就无法实现"低置信度入复核队列"（SPEC F4.3 / P3 复核队列面板），
 *     门槛裁定（E4）里"仅高置信度可自动提交"也就无从落地。
 *
 * 为什么把"评分要点"写死在系统提示里而不是各任务里：
 * 评分纪律（不臆造、逐点判定、边界从严）适用于所有学科，
 * 放在系统提示里能稳定复用，也让 JSON schema 只有一份。
 */

/** 修改任何提示词文本时**必须**同步提升此版本号 */
export const PROMPT_VERSION = '1.0.0';

/** 低置信度阈值：低于此值入复核队列。与 PLAN v2.0 的复核策略一致 */
export const LOW_CONFIDENCE_THRESHOLD = 0.75;

/* ------------------------------------------------------------ 系统提示 */

export const GRADING_SYSTEM = `你是一位严谨的中小学教师，正在批改学生答卷。你必须遵守以下纪律：

1. 【只依据给定标准】只能根据"参考答案"和"评分要点"给分，不得引入你自己的解题偏好或额外要求。
2. 【逐点判定】对每个评分要点分别判定是否达成，这决定了 hitPoints / missedPoints。
3. 【分值守恒】各部分得分之和必须等于 score；score 必须落在 [0, fullScore] 内。
4. 【边界从严】当学生答案处于给分与不给分的边界时，取不给分，并降低 confidence。
5. 【单位与步骤】数学、物理类题目，评分要点明确要求单位的，缺单位必须按要点扣分。
6. 【不臆造】看不清或无法判断的内容按"未达成"处理，降低 confidence 并在 comment 中说明。
7. 【置信度诚实】confidence 是你对自己给分的把握程度（0~1）：
   - 0.9 以上：答案清晰、要点全部明确可判
   - 0.75~0.9：存在小歧义但仍可判定
   - 0.75 以下：答案模糊、潦草、有歧义或评分要点不足以覆盖
   凡 confidence < ${LOW_CONFIDENCE_THRESHOLD}，必须把 reviewRequested 设为 true。
8. 【言语克制】comment 用中文，直接说明得失分理由，2~3 句，不评价学生本人。

只输出 JSON，不要输出任何解释性文字或 Markdown 代码块。`;

/* -------------------------------------------------------------- 评分 */

export interface GradePromptInput {
  questionText: string;
  fullScore: number;
  referenceAnswer: string;
  scoringPoints: string[];
  answerText: string;
  /** 学科，可空；仅作语气参考，不影响给分标准 */
  subject?: string;
}

export const GRADE_JSON_SCHEMA = `{
  "score": 数字，学生得分，必须落在 [0, fullScore] 内，
  "comment": 字符串，中文评语，2~3 句，
  "hitPoints": 字符串数组，已达成的评分要点（原文照抄要点文字），
  "missedPoints": 字符串数组，未达成的评分要点（原文照抄要点文字），
  "confidence": 数字，0~1，你对自己给分的把握程度，
  "reviewRequested": 布尔值，是否建议人工复核
}`;

export function buildGradePrompt(input: GradePromptInput): string {
  const points =
    input.scoringPoints.length > 0
      ? input.scoringPoints.map((p, i) => `  ${i + 1}. ${p}`).join('\n')
      : '  （未提供评分要点，请依据参考答案自行拆分要点，并在 comment 中说明你拆出了哪几点）';

  const subjectLine = input.subject ? `学科：${input.subject}\n` : '';

  return `请批改下面这道题。

${subjectLine}满分：${input.fullScore} 分

【题目】
${input.questionText}

【参考答案】
${input.referenceAnswer || '（未提供，请依据评分要点判定）'}

【评分要点】
${points}

【学生答案】
${input.answerText || '（学生未作答）'}

请严格按评分要点逐点判定，然后输出 JSON：

${GRADE_JSON_SCHEMA}`;
}

/* ------------------------------------------------------ 试卷解析（F2.2） */

export const PAPER_JSON_SCHEMA = `{
  "title": 字符串，试卷标题，无法判断则为空串,
  "subject": 字符串，学科，无法判断则为空串,
  "questions": [
    {
      "index": 数字，题号（从 1 开始）,
      "type": 字符串，取值之一："choice" | "fill" | "judge" | "short" | "calc" | "essay",
      "stem": 字符串，题干原文，保真录入，不做改写,
      "fullScore": 数字，该题满分；原文未标注则为 0,
      "referenceAnswer": 字符串，参考答案，无则为空串,
      "scoringPoints": 字符串数组，得分点；无则为空数组,
      "objectiveAnswer": 字符串，客观题标准答案（choice/fill/judge 时给出），主观题省略
    }
  ]
}`;

export function buildParsePaperPrompt(rawText: string, subject?: string): string {
  return `下面是一份试卷的文本内容（可能来自 docx/pdf/txt，格式不规整）。
请把它解析成结构化数据。

要求：
1. 题干**保真录入**，不要改写、不要纠错、不要补全。
2. 题号以原文为准；原文若无明确题号，按出现顺序从 1 编号。
3. 题型按题意判断：
   - "choice"：选择题　"fill"：填空题　"judge"：判断题
   - "short"：简答题　"calc"：计算题　"essay"：论述题
4. 满分若原文标注了（如"（6 分）"）就填；没标注填 0，不要猜测。
5. 评分要点若原文给出就逐条拆分；没给出就留空数组，不要自己编造。

${subject ? `已知学科：${subject}\n` : ''}【试卷文本】
${rawText}

请输出 JSON：

${PAPER_JSON_SCHEMA}`;
}

/* --------------------------------------------- 答卷识别（F2.3 视觉） */

export const VISION_JSON_SCHEMA = `{
  "name": 字符串，学生姓名，识别不到则为空串,
  "examNo": 字符串，考号/学号，识别不到则为空串,
  "answers": [
    { "index": 数字，题号, "text": 字符串，该题学生作答内容，保真转录 }
  ]
}`;

export function buildVisionAnswersPrompt(questionCount: number): string {
  return `这是一份学生答卷的照片。请完成两件事：

1. 从页首区域识别学生**姓名**与**考号**。识别不到就留空串，**不要猜测**。
2. 逐题转录学生作答内容。

转录要求（很重要）：
- **保真转录**：包括错别字、涂抹、未完成的句子，都按原样转出来。
- 公式用简单线性文本表示（如 x^2、sqrt(3)、1/2），不要用 LaTeX。
- 潦草到无法辨认的字用「□」占位，**不要凭上下文编造**。
- 学生未作答的题目，仍然列出该题号，text 留空串。
- 试卷共 ${questionCount} 题，answers 应覆盖 1 到 ${questionCount} 题。

请输出 JSON：

${VISION_JSON_SCHEMA}`;
}

/* ------------------------------------------------------- 连通性测试 */

export function buildPingPrompt(): string {
  return '这是一次连通性测试。请只回复两个字：可用。不要添加任何其他内容。';
}

/* ------------------------------------------------------------ 哈希登记 */

export interface PromptEntry {
  id: string;
  description: string;
  /** 'system' 为系统提示（单独 message），其余为单条 user 消息模板 */
  kind: 'system' | 'user';
  /** 模板正文；用户模板里的占位符仅用于说明，哈希按模板原文计算 */
  template: string;
}

/**
 * 参与冻结的提示词集合。
 * 注意：这里收录的是**模板原文**，不是渲染后的结果——
 * 冻结的是"我们写了什么提示词"，渲染变量随样本变化，不应计入。
 */
export const PROMPT_ENTRIES: PromptEntry[] = [
  { id: 'grading.system', description: '评分系统提示：评分纪律与置信度契约', kind: 'system', template: GRADING_SYSTEM },
  {
    id: 'grading.user',
    description: '评分用户提示：题目/满分/参考答案/评分要点/学生答案 → JSON',
    kind: 'user',
    template: [
      '请批改下面这道题。',
      '满分：{fullScore}',
      '【题目】{questionText}',
      '【参考答案】{referenceAnswer}',
      '【评分要点】{scoringPoints}',
      '【学生答案】{answerText}',
    ].join('\n'),
  },
  { id: 'paper.user', description: '试卷解析：原始文本 → 结构化题目数组', kind: 'user', template: buildParsePaperPrompt('{rawText}', '{subject}') },
  { id: 'vision.user', description: '答卷识别：照片 → 姓名/考号 + 逐题作答', kind: 'user', template: buildVisionAnswersPrompt(0) },
  { id: 'ping.user', description: '连通性测试', kind: 'user', template: buildPingPrompt() },
];

/**
 * 提示词集合的内容哈希。
 *
 * 实现说明：浏览器/Node 的同步环境里没有 crypto.subtle（它是异步的），
 * 而这里需要在**模块加载时**同步得出常量，故使用 FNV-1a 64 位。
 * 用途是"检测提示词是否被改过"，不是密码学用途，FNV 足够且零依赖。
 * 若需要密码学强度的登记值，用 `scripts/freeze.py --prompt` 对源文件算 SHA256。
 */
function fnv1a64(s: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, '0');
}

function computeSetHash(): string {
  const payload = PROMPT_ENTRIES.map((e) => `${e.id}\u0000${e.template}`).join('\u0001');
  return fnv1a64(payload);
}

export const PROMPT_SET_HASH = computeSetHash();

/** 每次调用都要带上的版本标识，写入评测记录 */
export function promptStamp(): { version: string; hash: string; lowConfidenceThreshold: number } {
  return {
    version: PROMPT_VERSION,
    hash: PROMPT_SET_HASH,
    lowConfidenceThreshold: LOW_CONFIDENCE_THRESHOLD,
  };
}

/* --------------------------------------------- 细则提取（Phase B3） */

export const EXTRACT_RUBRIC_SCHEMA = `{
  "stem": "题目题干文本或设问",
  "questionType": "choice" | "judge" | "fill" | "short" | "calc" | "essay",
  "fullScore": 10,
  "referenceAnswer": "标准参考答案",
  "scoringPoints": ["得分点1（X分）", "得分点2（X分）"]
}`;

export function buildExtractRubricPrompt(subject?: string): string {
  return `这是一张教师阅卷的题目评分标准/参考答案截图。
请识别其中的题目内容、题型、分值、标准答案以及评分得分点细则，并整理成规范的 JSON。

要求：
1. "stem": 识别出的题干内容或设问。
2. "questionType": 题型推断（choice/judge/fill/short/calc/essay）。
3. "fullScore": 题目满分数值（如 10）。若图中未标明，默认填 10。
4. "referenceAnswer": 参考答案或标准解法。
5. "scoringPoints": 字符串数组，列出具体的步骤得分点与给分细则。

${subject ? `已知学科：${subject}\n` : ''}只输出合法的 JSON，不要输出任何多余解释：
${EXTRACT_RUBRIC_SCHEMA}`;
}
