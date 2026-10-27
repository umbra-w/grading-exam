/**
 * 全局类型契约：main / preload / renderer 三方共用。
 * 任何跨进程数据都必须在这里定义，禁止 any 穿越边界。
 */

/* ------------------------------------------------------- 文件解析与导出 */

/**
 * 文件解析结果 —— 跨 IPC 传输的形状。
 *
 * 与 `src/main/io/parse.ts` 的定义是同一套事实，但**刻意分开**：
 * 主进程那份包含 filePath 等本机信息，渲染层不需要也不该拿到。
 * 这里只保留展示与决策所需的最小集合。
 */
export type ParseErrorCode =
  | 'UNSUPPORTED_TYPE'
  | 'READ_FAILED'
  | 'TOO_LARGE'
  | 'EMPTY_FILE'
  | 'SCANNED_PDF'
  | 'ENCRYPTED_PDF'
  | 'PARSE_FAILED';

export interface ParseWarning {
  code: 'PARTIAL_TEXT' | 'LOW_TEXT_DENSITY' | 'ENCODING_FALLBACK' | 'NO_EXTENSION';
  message: string;
}

export type ParseResult =
  | {
      ok: true;
      name: string;
      ext: string;
      text: string;
      charCount: number;
      pageCount?: number;
      warnings: ParseWarning[];
    }
  | {
      ok: false;
      name: string;
      ext: string;
      code: ParseErrorCode;
      message: string;
    };

/** 客观题比对的跨进程结果（形状与 shared/objective.ts 的 ObjectiveResult 一致） */
export type ObjectiveVerdict = 'correct' | 'correct_alt' | 'blank' | 'wrong' | 'suspect';

export interface ObjectiveVerdictResult {
  verdict: ObjectiveVerdict;
  awarded: boolean;
  normalized: string;
  expected: string;
  reason: string;
  needsReview: boolean;
}

/* ------------------------------------------------------------------ AI */

export type ProviderId =
  | 'openai'
  | 'deepseek'
  | 'qwen'
  | 'zhipu'
  | 'kimi'
  | 'custom';

export interface ProviderPreset {
  id: ProviderId;
  label: string;
  baseUrl: string;
  defaultModel: string;
  /** 默认是否关闭思考模式（国产推理模型必须关，否则正文为空） */
  disableThinking: boolean;
  /** 是否支持图片输入 */
  vision: boolean;
  sampleModels: string[];
}

/** 已知支持视觉的模型前缀白名单（用于提前拦截无效请求） */
export const VISION_MODEL_PREFIXES = [
  'gpt-4o',
  'gpt-4.1',
  'gpt-5',
  'o4',
  'claude-3',
  'claude-4',
  'gemini-1.5',
  'gemini-2',
  'qwen-vl',
  'qwen2.5-vl',
  'qwen3-vl',
  'glm-4v',
  'glm-4.1v',
  'internvl',
  'llava',
  'deepseek-vl',
  'yi-vision',
  'moonshot-v1-8k-vision',
  'kimi-latest',
];

export interface AIConfig {
  provider: ProviderId;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 商家侧忽略时无副作用，默认 true */
  disableThinking: boolean;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
}

export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
  /** 估算成本（人民币），按可选价目表计算，无价目表则为 0 */
  costCNY: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  /** 纯文本内容；有图时由 client 组装为多模态数组 */
  content: string;
  images?: ImagePart[];
}

export interface ImagePart {
  /** data URL 或 base64（不含前缀） */
  data: string;
  mime: string;
}

/* ------------------------------------------------------- 复核队列（P1-8） */

/*
 * 这几个形状放在 `shared` 而不是 `main/ai/review.ts` 里的原因：
 * 它们要经 IPC 传到渲染层，属于**跨进程契约**，而契约只有一处真源（§4.1）。
 * 判定与修正的**行为**仍在 `main/ai/review.ts`（纯逻辑，有单测）；
 * 这里只放数据形状。逻辑模块会 re-export 这些类型，
 * 调用方不必知道定义在哪。
 */

/**
 * 一条待人工复核的评分。
 *
 * `original` 与 `effective` **必须分开**：
 *   · `original` 是模型原话，用于对照"模型当初说了什么"，永不修改
 *   · `effective` 是当前生效的分数，人工修正后改变
 * 合成一个字段就无法回答"老师改之前模型给的是几分"，
 * 而那正是评估模型质量与复现争议的唯一依据。
 */
export interface ReviewItem {
  /** 稳定 id（同一份答卷的同一题只应有一条） */
  id: string;
  /** 归属：试卷 / 题号 */
  paperId: string;
  questionNo: string;
  subject: string;
  createdAt: number;
  updatedAt: number;
  /** 模型原始输出，**不可变** */
  original: GradeResult;
  /** 当前生效的结果 */
  effective: GradeResult;
  reasons: ReviewReason[];
  status: ReviewStatus;
  /** 修正历史，append-only */
  history: CorrectionRecord[];
  /** 人工填写的最新理由 */
  note?: string;
  /** 该题满分（入队时快照，避免之后取不到） */
  fullScore: number;
}

export type ReviewStatus = 'pending' | 'corrected' | 'confirmed' | 'excluded';

export type ReviewReason =
  | 'low_confidence'
  | 'output_warnings'
  | 'ensemble_disagreement'
  | 'poor_image'
  | 'objective_suspect'
  | 'extreme_score'
  | 'model_requested';

export interface CorrectionRecord {
  at: number;
  /** 谁改的（空表示未填写） */
  by: string;
  fromScore: number;
  toScore: number;
  /** 被翻转为"命中"的评分点 */
  markedHit: string[];
  /** 被翻转为"未命中"的评分点 */
  markedMissed: string[];
  note: string;
}

export interface ReviewStats {
  total: number;
  pending: number;
  corrected: number;
  confirmed: number;
  excluded: number;
  /**
   * 人工复核后**真的改分**的比例。null 表示还没有任何人工结论
   * —— 不是 0：「没测过」≠「测过且通过」（§6.3）。
   */
  correctionRate: number | null;
  /** 人工修正带来的净分数变化 */
  netScoreDelta: number;
}

/**
 * AI 评分结果（结构化）。
 *
 * 放在 shared 而不是 main/ai 里的原因：渲染层要直接渲染它
 *（得分点、失分点、置信度、是否需复核），属于跨进程契约。
 *
 * confidence 与 reviewRequested 是**强制字段**：没有置信度就无法实现
 * 「低置信度入复核队列」，门槛裁定（E4）里「仅高置信度可自动提交」也落不了地。
 */
/**
 * 运行时版本信息（设置页「关于」与状态栏展示）。
 *
 * 定义在 shared 作为**唯一真源**：preload 与 IPC 契约都引用它。
 * 此前形状在两处各声明一遍（preload/index.ts 与 types.ts 的 app:info），
 * 结果字段名一个写 `version` 一个写 `app`，类型检查才发现——
 * 这类"两处真源"是静默 bug 的温床。
 */
export interface AppInfo {
  version: string;
  electron: string;
  node: string;
  chrome: string;
  storePath: string;
}

export interface GradeResult {
  score: number;
  comment: string;
  /** 已达成的评分要点（原文照抄要点文字） */
  hitPoints: string[];
  /** 未达成的评分要点 */
  missedPoints: string[];
  /** 0~1，模型对自身给分的把握程度 */
  confidence: number;
  /** 是否建议人工复核；低于阈值时由客户端强制置 true */
  reviewRequested: boolean;
  /** 清洗过程中发现并修正的问题，进日志 */
  warnings: string[];
  /** 提示词版本指纹，写入评测记录 */
  promptVersion: string;
  promptHash: string;
  /**
   * 多次运行的汇总信息（仅 gradeQuestionMulti 产生）。
   *
   * 为什么要放进结果里而不是只写日志：复核界面需要展示"模型自己都不一致"
   * 的证据，光给一个分数，人无法判断该不该改。
   */
  ensemble?: EnsembleSummary;
}

export interface EnsembleSummary {
  /** 有效运行次数 */
  runs: number;
  /** 各次原始分数，按运行顺序 */
  scores: number[];
  /** 归一化分歧度 0~1 */
  disagreement: number;
  agreement: 'consistent' | 'minor' | 'major' | 'contradictory' | 'insufficient';
  /**
   * 各次运行**共同未命中**的得分点 —— 系统性盲区线索。
   * 单跑一次永远发现不了，是改提示词/rubric 的主要依据。
   */
  commonMisses: string[];
  /** 各次运行判断互相矛盾的得分点 */
  contradictoryPoints: string[];
}

export interface AICallResult {
  ok: boolean;
  text: string;
  usage: TokenUsage;
  /** 诊断信息，直接展示在日志面板 */
  diag: {
    model: string;
    finishReason?: string;
    httpStatus?: number;
    errorCode?: string;
    rawSnippet?: string;
    /** 是否走了 reasoning_content 回退 */
    usedReasoningFallback?: boolean;
    /** 是否自动关闭了思考模式 */
    thinkingDisabled?: boolean;
  };
  /** 评分类调用的结构化结果（ai:grade） */
  grade?: GradeResult;
  /** 解析类调用的结构化结果（ai:parsePaper / ai:visionAnswers） */
  data?: unknown;
}

/* ------------------------------------------------------------------ 拾取 */

export type PickKind = 'questionRegion' | 'scoreInput' | 'submitButton';

export type PickMode = 'element' | 'coordinate';

export interface PickResult {
  kind: PickKind;
  mode: PickMode;
  /** 顶层视口坐标（CDP 派发用） */
  topX: number;
  topY: number;
  /** frame 内局部坐标 */
  localX: number;
  localY: number;
  /** 从顶层到该 frame 的路径，顶层为 [] */
  framePath: number[];
  /** 元素模式下生成的稳定选择器；坐标模式为 null */
  selector: string | null;
  /**
   * 按韧性排序的选择器候选（高→低）。
   *
   * 为什么存"列表"而不是单个选择器：平台改版时，最优候选可能失效，
   * 但下一档仍然命中。运行时从上往下试第一个能唯一命中的，
   * 等于自动获得多次降级机会——单个选择器没有这个能力。
   * 依据 Playwright 官方 locator 优先级（role > label > testid > CSS）。
   */
  candidates?: SelectorCandidateLite[];
  /** 目标尺寸，用于框选题目区域 */
  width: number;
  height: number;
  tag: string;
  /** 是否位于跨域 iframe 内 */
  inIframe: boolean;
  pickedAt: number;
}

/**
 * 选择器候选的精简形态（跨进程传输用）。
 * 完整定义在 shared/locator.ts，此处避免类型循环依赖。
 */
export interface SelectorCandidateLite {
  kind: 'role' | 'label' | 'placeholder' | 'text' | 'testid' | 'id' | 'attr' | 'css';
  selector: string;
  /** 韧性评分，越高越抗改版 */
  score: number;
}

/** 阅卷窗口与拾取会话的快照（渲染层用于回显状态） */
export interface BrowserStateSnapshot {
  open: boolean;
  url: string;
  kernel: BrowserKernel;
  pendingPick: PickKind | null;
  picks: Partial<Record<PickKind, PickResult>>;
  /** 拾取时的页面结构指纹，用于改版检测 */
  fingerprint: string;
}

/* ------------------------------------------------------------------ 试卷 */

export type QuestionType = 'choice' | 'fill' | 'judge' | 'short' | 'calc' | 'essay';

export interface Question {
  id: string;
  index: number;
  type: QuestionType;
  stem: string;
  fullScore: number;
  referenceAnswer: string;
  /** 得分点，主观题 AI 评分依据 */
  scoringPoints: string[];
  /** 客观题标准答案 */
  objectiveAnswer?: string;
}

export interface Paper {
  id: string;
  title: string;
  subject: string;
  questions: Question[];
  createdAt: number;
  sourceFile?: string;
}

export interface GradingDetail {
  questionId: string;
  index: number;
  type: QuestionType;
  score: number;
  fullScore: number;
  comment: string;
  hitPoints: string[];
  missedPoints: string[];
  /** 客观题本地比对，true 表示未消耗 token */
  local?: boolean;
  /**
   * 0~1 置信度。
   *
   * 为什么必须持久化：整套分层阈值（辅助阅卷 / 自动填分 / 自动提交）
   * 与"低置信度进复核队列"都以它为依据。此前只有 `GradeResult` 带这个字段，
   * 而落库/导出用的 `GradingDetail` 没有——结果一存盘置信度就丢了，
   * 复核队列与分层判定全部失去依据，且**不会有任何报错**。
   *
   * 客观题由本地比对产生：确定性判定给 1，疑似写法差异（suspect）给 0.5
   * 并置 `reviewRequested`，见 `shared/objective.ts`。
   */
  confidence: number;
  /** 是否建议人工复核。低置信度、疑似写法、多轮分歧都由上层置 true */
  reviewRequested: boolean;
}

export interface StudentAnswer {
  questionId: string;
  text: string;
  images?: ImagePart[];
}

export interface StudentSubmission {
  id: string;
  name: string;
  examNo: string;
  answers: StudentAnswer[];
  /** 图片导入时由视觉模型识别的原始文本，便于人工核对 */
  extractedDraft?: string;
}

export interface StudentResult {
  submissionId: string;
  name: string;
  examNo: string;
  details: GradingDetail[];
  total: number;
  fullTotal: number;
  comment: string;
  gradedAt: number;
}

export interface PaperReport {
  paperId: string;
  paperTitle: string;
  results: StudentResult[];
  stats: {
    count: number;
    average: number;
    max: number;
    min: number;
    passRate: number;
    /** 分箱直方图：区间下界 → 人数 */
    distribution: Array<{ bucket: string; count: number }>;
    /** 失分点聚合 */
    lossRanking: Array<{ point: string; count: number }>;
  };
  generatedAt: number;
}

/* ------------------------------------------------------- 浏览器自动化 */

export type BrowserKernel = 'chrome' | 'edge';
export type GradingMode = 'top' | 'steady' | 'standard';

export interface AutoGradeConfig {
  pageUrl: string;
  kernel: BrowserKernel;
  mode: GradingMode;
  questionId: string;
  question: {
    stem: string;
    fullScore: number;
    referenceAnswer: string;
    scoringPoints: string[];
    /** 学科，可空；仅用于评语语气，不影响给分标准 */
    subject?: string;
  };
  /** 已拾取的元素/坐标配置 */
  picks: Partial<Record<PickKind, PickResult>>;
  /** 每次操作的间隔（毫秒），用于降低平台风控 */
  throttleMs: number;
  /** 连续处理的最大份数，0 = 不限 */
  maxPapers: number;
  /** 提交后等待下一份试卷出现的超时 */
  nextPaperTimeoutMs: number;
}

export type LogLevel = 'info' | 'ok' | 'warn' | 'error';

export interface LogEntry {
  ts: number;
  level: LogLevel;
  message: string;
  /** 缩进层级，用于展示 iframe 命中链等 */
  depth?: number;
}

export interface LoopProgress {
  running: boolean;
  handled: number;
  current: number;
  lastScore: number | null;
  /** 最近一次填分校验结果 */
  lastVerify: 'ok' | 'mismatch' | 'skipped' | 'none';
}

/* ------------------------------------------------------------------ IPC */

export interface AppSettings {
  ai: AIConfig;
  general: {
    theme: 'light' | 'dark';
    exportDir: string;
    pollIntervalMs: number;
  };
  /**
   * 自动化默认值。按 PLAN v2.0 §3 E4 的门槛裁定，
   * 默认必须是 steady（稳健模式）；top（无人值守）须用户显式开启。
   */
  autoDefaults: {
    mode: GradingMode;
    throttleMs: number;
    maxPapers: number;
    nextPaperTimeoutMs: number;
  };
}

export interface IPC {
  'settings:get': () => AppSettings;
  /**
   * 局部更新设置。实现接收的是 `Partial`（只覆盖传入的字段），
   * 契约此前误写成完整 `AppSettings`——类型对不上，等于契约在撒谎。
   */
  'settings:save': (s: Partial<AppSettings>) => AppSettings;
  /** 累计 token 用量（右下角计费显示） */
  'usage:get': () => TokenUsage;
  'usage:reset': () => TokenUsage;
  /** 运行时版本信息，设置页「关于」区展示 */
  'app:info': () => AppInfo;
  /** 日志回放：渲染层挂载后拉取启动前的历史日志 */
  'log:history': () => LogEntry[];
  /** 渲染层主动写一条日志（走同一条格式与缓冲） */
  'log:write': (level: LogLevel, message: string) => void;
  'ai:test': (cfg: AIConfig) => AICallResult;
  'ai:grade': (payload: {
    question: AutoGradeConfig['question'];
    answerText: string;
    images?: ImagePart[];
  }) => AICallResult;
  /**
   * 多次运行评分（自一致性）——用真实分歧度替代模型自评的弱置信度。
   *
   * 与 `ai:grade` 的关系：单次便宜，多次昂贵但可靠。
   * 正确用法是「先单次、可疑才多次」（边界分 / 低质量图 / 得分点不自洽），
   * 不要全量走这里，否则 API 成本变 3 倍而收益有限。
   */
  'ai:gradeMulti': (payload: {
    config: AutoGradeConfig;
    answerText?: string;
    images?: ImagePart[];
    /** 运行次数，2~5，默认 3（奇数便于取中位数） */
    runs?: number;
  }) => AICallResult;
  'ai:parsePaper': (payload: {
    rawText: string;
    subject?: string;
  }) => AICallResult;
  'ai:visionAnswers': (payload: {
    images: ImagePart[];
    questionCount: number;
  }) => AICallResult;
  'browser:open': (cfg: { url: string; kernel?: BrowserKernel }) => { ok: boolean; error?: string };
  'browser:close': () => { ok: boolean };
  'browser:navigate': (url: string) => { ok: boolean; error?: string };
  'picker:start': (kind: PickKind) => { ok: boolean; error?: string };
  'picker:cancel': () => { ok: boolean };
  /** 读取当前拾取状态（面板回显已拾取项与坐标） */
  'picker:state': () => BrowserStateSnapshot;
  /** 坐标模式：Canvas 平台由渲染层传入点击位置 */
  'picker:coordinate': (payload: {
    kind: PickKind;
    localX: number;
    localY: number;
    framePath?: number[];
  }) => { ok: boolean; pick?: PickResult; error?: string };
  /** 截取题目区域，供视觉模型评分 */
  'page:captureQuestion': () => { ok: boolean; base64?: string; error?: string };
  /** 检查页面结构是否改版（自动运行前调用） */
  'page:checkDrift': () => { changed: boolean; details?: string[]; action?: string };
  'auto:start': (cfg: AutoGradeConfig) => { ok: boolean; error?: string };
  'auto:stop': () => { ok: boolean };
  'auto:confirm': () => { ok: boolean };
  'io:pickFile': (opts: {
    filters: Array<{ name: string; extensions: string[] }>;
    multi?: boolean;
  }) => { canceled: boolean; paths: string[] };
  'io:pickDir': () => { canceled: boolean; path: string };
  /**
   * 解析一个文件为纯文本（docx / pdf / txt / md）。
   *
   * **不抛异常**：所有失败以 `ok:false` + 原因码 + 中文说明返回。
   * 扫描件 PDF 会明确报 `SCANNED_PDF` 而不是返回空文本——
   * 后者会让用户以为"试卷是空的"，是最典型的静默失败。
   */
  'io:parseFile': (filePath: string) => ParseResult;
  /** 导出 Excel（仅 .xlsx，不出 CSV：UTF-8 CSV 在中文 Excel 里会乱码） */
  'io:exportExcel': (payload: {
    report: PaperReport;
    outPath: string;
  }) => { ok: boolean; path?: string; error?: string };
  /** 导出 Markdown 报告 */
  'io:exportMarkdown': (payload: {
    report: PaperReport;
    outPath: string;
  }) => { ok: boolean; path?: string; error?: string };
  /**
   * 客观题本地比对 —— **零网络、零 token**。
   *
   * 为什么做成通道而不是让渲染层自己 import `shared/objective.ts`：
   * 判定逻辑必须只有一处实现。渲染层再写一遍，两边就会在某个边界
   * （全角、不可见字符、空标准答案）上分叉，而且是**静默分叉**——
   * 界面显示"对"、落库记"错"这种事最难查。
   * 通道化还顺带让"客观题不走 AI"这条纪律在架构上无法被绕过。
   */
  'objective:compare': (payload: {
    student: string;
    expected: string;
    acceptable?: string[];
    optionText?: Record<string, string>;
  }) => ObjectiveVerdictResult;

  /* --------------------------------------------------- 复核队列（P1-8） */

  /**
   * 读取复核队列。
   *
   * 为什么让主进程返回 `stats` 而不是让渲染层自己算：修正率的口径
   * （哪些状态算"人工下了结论"、`excluded` 算不算分母）必须只有一处定义。
   * 渲染层再算一遍就会在边界上分叉，而"修正率"正是判断模型能不能用的依据。
   */
  'review:queue': () => {
    items: ReviewItem[];
    stats: ReviewStats;
    /** 结构损坏被跳过的条数。>0 必须显示出来，否则用户以为队列是空的 */
    invalidDropped: number;
  };

  /** 人工修正：手填分数 / 翻转评分点 */
  'review:correct': (payload: {
    id: string;
    score?: number;
    /** 改为命中的评分点（文字须在 missedPoints 里） */
    markHit?: string[];
    /** 改为未命中的评分点（文字须在 hitPoints 里） */
    markMissed?: string[];
    /** 各评分点分值。**只有提供了它**，翻转评分点时才会重算总分 */
    pointScores?: Array<{ point: string; score: number }>;
    note?: string;
    by?: string;
  }) => { ok: boolean; item?: ReviewItem; warnings: string[]; error?: string };

  /** 人工确认模型没错 / 判定该题不参与评分（不改分数） */
  'review:verdict': (payload: {
    id: string;
    status: 'confirmed' | 'excluded';
    note?: string;
    by?: string;
  }) => { ok: boolean; item?: ReviewItem; error?: string };

  /** 从队列里移除一条（已处理的，或误入队的） */
  'review:remove': (payload: { id: string }) => { ok: boolean; removed: number };
}

/**
 * main → renderer 的推送事件（`evt:*`）。
 *
 * 单独一个接口而不是并进 `IPC`：这两类的方向相反、失败语义也完全不同
 * （invoke 有 Promise 与错误码，事件只推送、失败无处可返）。
 * 分开命名能避免"给事件加返回值"这种根本不可能生效的改动。
 */
export interface IPCEvents {
  'evt:pick': (r: PickResult) => void;
  'evt:log': (e: LogEntry) => void;
  'evt:progress': (p: LoopProgress) => void;
  'evt:awaitConfirm': (payload: { score: number; comment: string }) => void;
  'evt:usage': (u: TokenUsage) => void;
  'evt:browserClosed': () => void;
}