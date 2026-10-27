import type { AutoGradeConfig, GradeResult, GradingMode, PickKind, PickResult } from '../../shared/types';
import {
  type AutoErrorKind,
  type ClassifiedError,
  type FillCheck,
  type PaperOutcome,
  type SubmitState,
  canSubmit,
  classifyError,
  nextSubmitState,
  throttledDelay,
} from './geometry';
import { type FillConfig, type FillState, cleanScoreText, initialFillState, runFillLoop } from './autoloop';

/*
 * ══════════════════════════════════════════════════════════════════════════
 *  连续阅卷的**执行层状态机**（纯逻辑）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 为什么再做一层状态机，而不是把 autoloop 直接接到 browser.ts：
 *
 *   `autoloop.ts` 只管"往一个输入框里填一个分数"这一件事，它不知道
 *   "一份卷子"是什么，也不知道"提交"存在。连续阅卷是把这些单步操作
 *   编排成一条有跨份状态（已提交集合、失败计数、断点续跑）的流水线。
 *   职责不同，混在一起会让"填分失败"与"这份卷子失败"在同一个 switch 里纠缠。
 *
 * ── 为什么是"一步一返回"而不是一个大循环 ──────────────────────────────────
 *
 * `nextAutoStep()` 每次只返回**一个**要执行的动作，本身无副作用。这样：
 *   · 全部路径可在 vitest 里走完（本机 Electron 起不来，§5）
 *   · 薄绑定只需写一个 `switch` 去执行动作，没有并行逻辑
 *   · 出问题时能一眼看出卡在哪一步，而不是回头翻一个大函数的日志
 *
 * ── 三条不可退让的安全不变量 ─────────────────────────────────────────────
 *
 * 1. **`standard` 模式永不填分、`steady` 模式永不提交**。`standard` 只评分，
 *    结果要老师自己录入；`steady` 的"确认"含义是"允许把分数填进平台"，
 *    **不是**"允许提交"。所有走向 submit 的路径都必须先过 `modeSubmits()`。
 * 2. **同一个 submissionId 永不提交两次**。重复提交会在同一份卷子上叠分，
 *    这是真实平台会发生的、且事后很难发现的事故。
 * 3. **一份失败不中断整轮**（单份隔离）。只有"拾取配置缺了"这类
 *    **开工前就注定失败**的问题才中止整轮——否则每份都会以同样的理由
 *    失败一次，把老师的时间全耗在重复报错上。
 *
 * ── 与 classifyError 的接口纪律 ──────────────────────────────────────────
 *
 * `classifyError(raw)` 按**大写 AutoErrorKind 或中文关键词**匹配（见
 * geometry.ts 的 ERROR_RULES）。传入 `'fill_failed'` 这类自造小写串不会
 * 编译报错，而是**静默落到 UNKNOWN**——每种完全不同的故障被压成同一个
 * "未知错误"，处置建议也就全错。所以下面每个入参要么是大写 kind，
 * 要么带上规则里真实存在的关键词。单测逐条断言 kind。
 */

/* ------------------------------------------------------------- 动作 */

/** 执行层要求薄绑定去做的动作。每个动作都必须有对应的回填方式 */
export type AutoStep =
  /** 等待若干毫秒（降低平台风控识别为机器人的概率） */
  | { kind: 'wait'; ms: number }
  /** 等到页面上出现下一份可批阅的卷子 */
  | { kind: 'awaitNextPaper'; timeoutMs: number }
  /**
   * 读当前这份卷子的唯一标识（考号 / 流水号）。
   *
   * 为什么把它做成一个**真实动作**而不是给 `runAutoLoop` 加个钩子：
   * 标识是幂等判据，而"读它"是薄绑定才能做的事。做成动作后，
   * 读取时机由状态机掌握（就在识别到新卷子之后、截图之前），
   * 不会出现"上层已回填而机器还没推进"的时序错位。
   */
  | { kind: 'collectPaper' }
  /** 截图题目区域，返回 base64（不含 data URI 前缀） */
  | { kind: 'captureQuestion' }
  /** 图文评分。这是唯一**花钱**的动作 */
  | { kind: 'grade'; paperBase64: string }
  /** 让老师确认后再继续（稳健模式）。`top` 模式不该出现这一步 */
  | { kind: 'awaitConfirm'; reason: string }
  /** 在分数框上填分（内部自行重试并回读校验） */
  | { kind: 'fillScore'; score: string; x: number; y: number }
  /** 点提交按钮 */
  | { kind: 'submit'; x: number; y: number };

/** 薄绑定执行动作后回填的结果。`kind` 必须与上一步动作对应 */
export type AutoStepResult =
  | { kind: 'wait' }
  | { kind: 'awaitNextPaper'; appeared: boolean }
  /** 读到的卷子标识。读不到就给空串——空串会被当作"无法幂等",不会误拦 */
  | { kind: 'collectPaper'; paperId: string }
  | { kind: 'captureQuestion'; base64?: string; error?: string }
  | { kind: 'grade'; ok: boolean; grade?: GradeResult; error?: string }
  | { kind: 'confirm'; ok: boolean }
  /** 填分结果。`state.phase === 'done'` 才算成功 */
  | { kind: 'fillScore'; state: FillState }
  | { kind: 'submit'; ok: boolean; error?: string };

/* ------------------------------------------------------------- 状态 */

export type AutoPhase =
  | 'idle' // 还没开工
  /*
   * 开工前的等待。**必须与 awaitingPaper 分开**：
   * 上一版让 idle 返回 wait 却把 phase 设成 awaitingPaper，
   * 于是下一轮把 wait 的结果喂给"等卷子"状态，被判定为
   * step_mismatch 而整轮报错。每个动作都有自己的结果类型，
   * 所以每个动作也必须有自己的阶段。
   */
  | 'settling'
  /*
   * 一份处理完（或跳过）后的节流等待，然后去找下一份。
   * 与 settling 是同一件事的两个入口，但分开的理由同样是
   * "每个动作有自己的结果类型"——wait 的结果只能喂给接 wait 的阶段。
   */
  | 'resetting'
  | 'awaitingPaper' // 等下一份卷子出现
  | 'identifying' // 读这一份的标识（幂等依据）
  | 'capturing' // 截图题目区域
  | 'grading' // 图文评分
  | 'awaitingConfirm' // 等老师确认
  | 'filling' // 填分
  | 'submitting' // 提交
  | 'done'; // 本轮结束

/** 一份卷子被跳过的原因。跳过与失败**分开记**：处置完全不同 */
export type SkipReason =
  /** 已提交过（幂等拦截） */
  | 'already_submitted'
  /** 本轮已达到 maxPapers 上限 */
  | 'limit_reached';

export interface AutoSkip {
  submissionId: string;
  reason: SkipReason;
}

export interface AutoState {
  mode: GradingMode;
  cfg: AutoGradeConfig;
  phase: AutoPhase;
  /** 当前正在处理的卷子标识。由薄绑定在每份开始时更新 */
  submissionId: string;
  /** 本轮已处理（成功 + 失败）的份数，用于 maxPapers 判定 */
  handled: number;
  /** 已提交的 submissionId（幂等依据） */
  submittedIds: string[];
  /**
   * 最近一次**成功提交**的卷子标识。
   *
   * 为什么不能只看 `submittedIds`：实际提交时 `state.submissionId` 已经被
   * 清空（编辑区在提交成功时就被重置了），而 `currentPaperId` 也被 reset
   * 清掉了。留下一份"上一份是谁"，才能在"页面没跳转、同一份又出现一次"
   * 时认出它——那正是重复提交最容易发生的场景。
   *
   * **刻意不被 `resetPaperFields()` 清除**。
   */
  lastSubmittedId: string;
  outcomes: PaperOutcome[];
  skips: AutoSkip[];
  /** 当前这份卷子的模型分数（已清洗），null = 还没拿到 */
  lastScore: string | null;
  lastComment: string;
  submitState: SubmitState;
  /** 当前这份卷子的提交尝试次数 */
  submitAttempts: number;
  /** 已截到、待评分的题目图 */
  paperBase64: string | null;
  /** 最近一次动作的可读说明（日志与界面共用） */
  lastMessage: string;
}

export interface AutoOutcome {
  kind: 'done' | 'stopped' | 'error';
  handled: number;
  outcomes: PaperOutcome[];
  skips: AutoSkip[];
  /** 已提交份数 */
  submitted: number;
  /** 中止整轮的原因（仅 kind==='error' 时有值） */
  error?: string;
}

export interface AutoStepReturn {
  /** 下一步动作。null 表示本轮结束（或这一份处理完毕且无后续动作） */
  step: AutoStep | null;
  state: AutoState;
  outcome?: AutoOutcome;
}

/* --------------------------------------------------------- 配置派生 */

/** 提交后等待下一份卷子的默认超时。60s 是"网络慢"与"真的没有下一份"的折中 */
export const DEFAULT_NEXT_PAPER_TIMEOUT_MS = 60_000;

/** 同一份卷子允许的提交尝试上限。超过就判这一份失败，避免反复点提交按钮 */
export const MAX_SUBMIT_ATTEMPTS = 2;

/** 该模式是否允许写分数框。`standard` 只评分不填分 */
export function modeFills(mode: GradingMode): boolean {
  return mode !== 'standard';
}

/**
 * 该模式是否允许点提交按钮。
 *
 * **只有 `top`**。`steady` 在旁边等老师确认，`standard` 压根不填分。
 * 这是安全不变量的**单一守卫点**：任何产生 `submit` 步骤的分支都必须
 * 先过它，所以"模式判断写漏一处"这种事故只可能发生在这里。
 */
export function modeSubmits(mode: GradingMode): boolean {
  return mode === 'top';
}

/** 收集拾取配置里缺失的必填项。开工前查一次，缺了就整轮中止 */
export function missingPicks(
  picks: Partial<Record<PickKind, PickResult>>,
  mode: GradingMode,
): PickKind[] {
  const missing: PickKind[] = [];
  const valid = (p: PickResult | undefined): boolean =>
    !!p && Number.isFinite(p.topX) && Number.isFinite(p.topY);
  // 坐标非法（NaN/Infinity）也算缺失：否则后面每个动作都会失败，
  // 而失败原因看起来像"平台改版了"，排查方向被带偏
  if (modeFills(mode) && !valid(picks.scoreInput)) missing.push('scoreInput');
  if (modeSubmits(mode) && !valid(picks.submitButton)) missing.push('submitButton');
  return missing;
}

const PICK_LABEL: Record<PickKind, string> = {
  scoreInput: '分数输入框',
  submitButton: '提交按钮',
  questionRegion: '题目区域',
};

export function initialAutoState(cfg: AutoGradeConfig): AutoState {
  return {
    mode: cfg.mode,
    cfg,
    phase: 'idle',
    submissionId: '',
    handled: 0,
    submittedIds: [],
    lastSubmittedId: '',
    outcomes: [],
    skips: [],
    lastScore: null,
    lastComment: '',
    submitState: 'idle',
    submitAttempts: 0,
    paperBase64: null,
    lastMessage: '',
  };
}

/* ---------------------------------------------------- 内部小工具 */

/** 从拾取结果取顶层坐标；坐标非法返回 null，而不是当成 (0,0) 点下去 */
function topPoint(p: PickResult | undefined): { x: number; y: number } | null {
  if (!p) return null;
  if (!Number.isFinite(p.topX) || !Number.isFinite(p.topY)) return null;
  return { x: p.topX, y: p.topY };
}

/**
 * 节流抖动系数。±20% —— 固定间隔的操作节律很容易被平台风控识别为机器人，
 * 抖动是**降低被风控**的最廉价手段，比换 IP 温和得多。
 * 集中在这里一处定义，改它不会漏掉某个分支。
 */
const THROTTLE_JITTER = 0.2;

/**
 * 一份卷子失败后：等一个带抖动的间隔，再回到等下一份。
 *
 * 抽出来的理由不只是省行数——这条路径出现在 4 个分支里（截图失败、
 * 评分失败、填分失败、提交重试耗尽），**任何一处漏了节流都会让它在
 * 失败后立刻打下一份**，而那正是最容易触发风控的行为。
 * 集中成一个函数后，"失败后一定先等"这件事不可能被某条分支漏掉。
 */
function retryAfterFailed(state: AutoState): AutoStepReturn {
  return {
    step: { kind: 'wait', ms: throttledDelay(state.cfg.throttleMs, THROTTLE_JITTER) },
    state,
  };
}

/** 结束本轮 */
function endRun(
  state: AutoState,
  kind: AutoOutcome['kind'],
  message: string,
  error?: string,
): AutoStepReturn {
  const next: AutoState = { ...state, phase: 'done', lastMessage: message };
  return {
    step: null,
    state: next,
    outcome: {
      kind,
      handled: next.handled,
      outcomes: next.outcomes,
      skips: next.skips,
      submitted: next.submittedIds.length,
      ...(error === undefined ? {} : { error }),
    },
  };
}

/**
 * 清掉"当前这份卷子"的临时状态。
 *
 * ⚠ 刻意**不清** `lastSubmittedId` 与 `submittedIds`：它们是跨份的幂等判据，
 * 清掉就等于允许同一份被提交第二次。
 */
function resetPaperFields(state: AutoState): AutoState {
  return {
    ...state,
    submissionId: '',
    lastScore: null,
    lastComment: '',
    paperBase64: null,
    submitState: 'idle',
    submitAttempts: 0,
  };
}

/** 记一份失败并回到等下一份（单份隔离） */
function failPaper(state: AutoState, err: ClassifiedError, detail: string): AutoState {
  const outcome: PaperOutcome = {
    submissionId: state.submissionId || '(未识别)',
    ok: false,
    errorKind: err.kind,
    submitted: false,
  };
  return {
    ...resetPaperFields(state),
    // 回 resetting 而不是 awaitingPaper：读一次 README 就会知道，
    // awaitingPaper 只接受 awaitNextPaper 的结果，而这里下一步要先 wait
    phase: 'resetting',
    outcomes: [...state.outcomes, outcome],
    handled: state.handled + 1,
    lastMessage: `${err.message}（${detail}）—— ${err.action}`,
  };
}

function succeedPaper(state: AutoState, message: string): AutoState {
  const outcome: PaperOutcome = {
    submissionId: state.submissionId || '(未识别)',
    ok: true,
    submitted: state.submittedIds.includes(state.submissionId),
  };
  return {
    ...resetPaperFields(state),
    phase: 'resetting',
    outcomes: [...state.outcomes, outcome],
    handled: state.handled + 1,
    lastMessage: `${message}（第 ${state.handled + 1} 份）`,
  };
}

/* --------------------------------------------------------- 主状态机 */

/**
 * 推进一步。
 *
 * @param state 当前状态
 * @param prev  上一步动作的执行结果。**首次推进入参为 undefined**，
 *              此时只做开工前检查并给出第一个动作。
 */
export function nextAutoStep(state: AutoState, prev?: AutoStepResult): AutoStepReturn {
  const cfg = state.cfg;

  /* ── 开工前检查：缺拾取配置是"注定失败"，必须整轮中止，
        而不是让每一份都拿同样的理由失败一次 */
  if (state.phase === 'idle') {
    const missing = missingPicks(cfg.picks, cfg.mode);
    if (missing.length > 0) {
      return endRun(
        state,
        'error',
        `缺少必要配置：${missing.map((m) => PICK_LABEL[m]).join('、')}。请先完成拾取再启动连续阅卷。`,
        `missing_picks:${missing.join(',')}`,
      );
    }
    if (cfg.maxPapers > 0 && state.handled >= cfg.maxPapers) {
      return endRun(state, 'done', `已达到设定的 ${cfg.maxPapers} 份上限。`);
    }
    // 第一份也先等一等：页面没加载好就截图会拿到空白图，
    // 而空白图会被模型当成"学生没作答"——静默错分
    return {
      step: { kind: 'wait', ms: throttledDelay(cfg.throttleMs, THROTTLE_JITTER) },
      state: { ...state, phase: 'settling', lastMessage: `启动连续阅卷（${cfg.mode} 模式）。` },
    };
  }

  /* ------------------------------------------------ 开工前的等待 */
  if (state.phase === 'settling' || state.phase === 'resetting') {
    if (prev !== undefined && prev.kind !== 'wait') {
      return endRun(state, 'error', `状态与动作不匹配：等待时收到 ${prev.kind}。`, 'step_mismatch');
    }
    return {
      step: { kind: 'awaitNextPaper', timeoutMs: cfg.nextPaperTimeoutMs },
      state: { ...state, phase: 'awaitingPaper', lastMessage: '等待可批阅的卷子…' },
    };
  }

  switch (state.phase) {
    /* ------------------------------------------------ 等下一份卷子 */
    case 'awaitingPaper': {
      if (prev === undefined) {
        return {
          step: { kind: 'awaitNextPaper', timeoutMs: cfg.nextPaperTimeoutMs },
          state: { ...state, lastMessage: '等待下一份可批阅的卷子…' },
        };
      }
      if (prev.kind !== 'awaitNextPaper') {
        return endRun(state, 'error', `状态与动作不匹配：等待卷子时收到 ${prev.kind}。`, 'step_mismatch');
      }
      if (!prev.appeared) {
        // 超时不是错误：老师可能就是把待批的都批完了。但必须如实说
        // "是等超时结束的"，不能让界面看起来像"处理完了所有卷子"
        return endRun(
          state,
          'done',
          `等待 ${Math.round(cfg.nextPaperTimeoutMs / 1000)} 秒仍未见新卷子，本轮结束。`,
        );
      }
      if (cfg.maxPapers > 0 && state.handled >= cfg.maxPapers) {
        return endRun(state, 'done', `已达到设定的 ${cfg.maxPapers} 份上限。`);
      }
      // 先读这一份的标识，再截图。幂等判定需要它，而"读"必须发生在
      // 识别到新卷子之后、任何写操作之前
      return {
        step: { kind: 'collectPaper' },
        state: { ...state, phase: 'identifying', lastMessage: '识别当前卷子…' },
      };
    }

    /* ------------------------------------------------ 读卷子标识 */
    case 'identifying': {
      if (prev === undefined) return { step: { kind: 'collectPaper' }, state };
      if (prev.kind !== 'collectPaper') {
        return endRun(state, 'error', `状态与动作不匹配：识别卷子时收到 ${prev.kind}。`, 'step_mismatch');
      }
      const paperId = (prev.paperId ?? '').trim();
      const identified: AutoState = { ...state, submissionId: paperId };

      /*
       * 幂等：这份和刚提交过的那份是同一个 → 跳过，不重复提交。
       *
       * 判据是 `lastSubmittedId` 而不是 `submittedIds.includes(paperId)`：
       * 后者要求"读得到的 id 曾被记录过"，而提交成功那一刻
       * `state.submissionId` 已被清空，两者的可比性更脆弱。
       * 只比"上一份是谁"覆盖的是真实的危险场景：页面没跳转，
       * 还是同一份卷子又出现了一次。
       */
      if (paperId !== '' && paperId === state.lastSubmittedId) {
        return {
          step: { kind: 'wait', ms: throttledDelay(cfg.throttleMs, THROTTLE_JITTER) },
          state: {
            ...resetPaperFields(identified),
            phase: 'resetting',
            skips: [...state.skips, { submissionId: paperId, reason: 'already_submitted' }],
            lastMessage: `跳过刚提交过的「${paperId}」，避免重复提交。`,
          },
        };
      }
      return {
        step: { kind: 'captureQuestion' },
        state: { ...identified, phase: 'capturing', lastMessage: '截取题目区域…' },
      };
    }

    /* ---------------------------------------------------- 截图 */
    case 'capturing': {
      if (prev === undefined) return { step: { kind: 'captureQuestion' }, state };
      if (prev.kind !== 'captureQuestion') {
        return endRun(state, 'error', `状态与动作不匹配：截图时收到 ${prev.kind}。`, 'step_mismatch');
      }
      if (!prev.base64 || prev.base64.length === 0) {
        /*
         * 截图失败 = 题目区域元素不可用。**不要**凭 `AutoErrorKind` 里有
         * 一个 kind 名就以为能匹配到它——实测证明 `ERROR_RULES` 曾经没有
         * ELEMENT_NOT_FOUND 规则，传进去会静默落到 UNKNOWN，四种不同的
         * 故障被压成同一个"未知错误"。规则已按测试先行的方式补上了
         * （见 geometry.ts 里那条注释），这里才敢用它。
         */
        const failed = failPaper(state, classifyError('ELEMENT_NOT_FOUND: 题目区域截图失败（元素不可用/不可见）'), prev.error ?? '截图返回空');
        return retryAfterFailed(failed);
      }
      return {
        step: { kind: 'grade', paperBase64: prev.base64 },
        state: {
          ...state,
          phase: 'grading',
          paperBase64: prev.base64,
          lastMessage: modeFills(cfg.mode) ? '调用 AI 评分…' : '调用 AI 评分（仅评分模式）…',
        },
      };
    }

    /* ---------------------------------------------------- 评分 */
    case 'grading': {
      if (prev === undefined) {
        return { step: { kind: 'grade', paperBase64: state.paperBase64 ?? '' }, state };
      }
      if (prev.kind !== 'grade') {
        return endRun(state, 'error', `状态与动作不匹配：评分时收到 ${prev.kind}。`, 'step_mismatch');
      }
      if (!prev.ok || !prev.grade) {
        const failed = failPaper(state, classifyError('AI_FAILED'), prev.error ?? 'AI 评分失败');
        return retryAfterFailed(failed);
      }

      const score = cleanScoreText(String(prev.grade.score));
      const afterGrade: AutoState = {
        ...state,
        lastScore: score,
        lastComment: prev.grade.comment ?? '',
        lastMessage: `模型给分 ${score}。`,
      };

      // standard 模式：到此为止，只评分不填分
      if (!modeFills(cfg.mode)) {
        return { step: null, state: succeedPaper(afterGrade, '评分完成，未填分。') };
      }

      // 稳健模式：填分前先让老师过一眼
      if (cfg.mode === 'steady') {
        return {
          step: { kind: 'awaitConfirm', reason: `模型给分 ${score}，确认后填入平台（不会自动提交）。` },
          state: { ...afterGrade, phase: 'awaitingConfirm' },
        };
      }

      const pt = topPoint(cfg.picks.scoreInput);
      if (!pt) {
        const failed = failPaper(afterGrade, classifyError('PICK_MISSING'), '分数框坐标无效');
        return retryAfterFailed(failed);
      }
      return {
        step: { kind: 'fillScore', score, x: pt.x, y: pt.y },
        state: { ...afterGrade, phase: 'filling' },
      };
    }

    /* ------------------------------------------------ 等待确认 */
    case 'awaitingConfirm': {
      if (prev === undefined) {
        return {
          step: { kind: 'awaitConfirm', reason: `模型给分 ${state.lastScore ?? '?'}，确认后继续。` },
          state,
        };
      }
      if (prev.kind !== 'confirm') {
        return endRun(state, 'error', `状态与动作不匹配：等待确认时收到 ${prev.kind}。`, 'step_mismatch');
      }
      if (!prev.ok) {
        // 老师未确认 → CANCELLED（"用户主动取消"正是这条规则的语义）
        const failed = failPaper(state, classifyError('CANCELLED: 老师未确认'), '跳过这份');
        return retryAfterFailed(failed);
      }
      /*
       * ★ 这里**不能**用 `modeSubmits` 去挡。曾犯过这个错：
       * `steady` 的"确认"含义是"允许把分数填进平台"，它本来就该填分，
       * 只是不该提交。用 modeSubmits 挡会把 steady 变成"确认后什么都不做"，
       * 而测试里的表现是"连 fillScore 都没出现"——正是这一条抓出来的。
       * 提交的那道门在**填分之后**的分支里（见 case 'filling'）。
       */
      if (!modeFills(cfg.mode)) {
        return { step: null, state: succeedPaper(state, '老师已确认（仅评分模式，不填分）。') };
      }
      const pt = topPoint(cfg.picks.scoreInput);
      if (!pt) {
        const failed = failPaper(state, classifyError('PICK_MISSING'), '分数框坐标无效');
        return retryAfterFailed(failed);
      }
      return {
        step: { kind: 'fillScore', score: state.lastScore ?? '', x: pt.x, y: pt.y },
        state: { ...state, phase: 'filling' },
      };
    }

    /* ---------------------------------------------------- 填分 */
    case 'filling': {
      if (prev === undefined) {
        const pt = topPoint(cfg.picks.scoreInput);
        if (!pt) {
          const failed = failPaper(state, classifyError('PICK_MISSING'), '分数框坐标无效');
          return retryAfterFailed(failed);
        }
        return { step: { kind: 'fillScore', score: state.lastScore ?? '', x: pt.x, y: pt.y }, state };
      }
      if (prev.kind !== 'fillScore') {
        return endRun(state, 'error', `状态与动作不匹配：填分时收到 ${prev.kind}。`, 'step_mismatch');
      }
      if (prev.state.phase !== 'done') {
        // 填分内部已重试到上限。原因取自它自己的回读结果，不在这里重新猜一个：
        // "回读不到值"（元素消失）与"值填错了"是两种故障，处置不同
        const verdict = prev.state.lastCheck?.verdict;
        const err =
          verdict === 'unreadable' || verdict === 'empty'
            ? classifyError('VALUE_UNREADABLE: 回读不到值或写入未生效')
            : classifyError('VALUE_MISMATCH: 填分后回读未能确认');
        const failed = failPaper(state, err, prev.state.lastCheck?.message ?? '回读未能确认写入');
        return retryAfterFailed(failed);
      }

      // ★ 安全不变量：只有 top 模式提交
      if (!modeSubmits(cfg.mode)) {
        return { step: null, state: succeedPaper(state, '分数已填入，未提交（需人工提交）。') };
      }
      const btnPt = topPoint(cfg.picks.submitButton);
      if (!btnPt) {
        const failed = failPaper(state, classifyError('PICK_MISSING'), '提交按钮坐标无效');
        return retryAfterFailed(failed);
      }
      // ★ 安全不变量：同一份永不提交两次
      if (!canSubmit('idle', state.submissionId, new Set(state.submittedIds))) {
        const failed = failPaper(
          state,
          classifyError('SUBMIT_FAILED: 该份已在本次运行中提交过，拒绝重复提交'),
          `submissionId=${state.submissionId || '(未识别)'}`,
        );
        return retryAfterFailed(failed);
      }
      return {
        step: { kind: 'submit', x: btnPt.x, y: btnPt.y },
        state: {
          ...state,
          phase: 'submitting',
          submitState: nextSubmitState('idle', 'start'),
          submitAttempts: state.submitAttempts + 1,
          lastMessage: '点击提交…',
        },
      };
    }

    /* ---------------------------------------------------- 提交 */
    case 'submitting': {
      if (prev === undefined) {
        const btnPt = topPoint(cfg.picks.submitButton);
        if (!btnPt) {
          const failed = failPaper(state, classifyError('PICK_MISSING'), '提交按钮坐标无效');
          return retryAfterFailed(failed);
        }
        return { step: { kind: 'submit', x: btnPt.x, y: btnPt.y }, state };
      }
      if (prev.kind !== 'submit') {
        return endRun(state, 'error', `状态与动作不匹配：提交时收到 ${prev.kind}。`, 'step_mismatch');
      }

      if (prev.ok) {
        const okState: AutoState = {
          ...state,
          submittedIds: state.submissionId
            ? [...state.submittedIds, state.submissionId]
            : state.submittedIds,
          // 记下"刚提交的是谁"：它不被 resetPaperFields 清掉，
          // 用于拦住"同一份又出现一次"的重复提交
          lastSubmittedId: state.submissionId || state.lastSubmittedId,
          submitState: nextSubmitState(state.submitState, 'ok'),
        };
        return {
          step: { kind: 'wait', ms: throttledDelay(cfg.throttleMs, THROTTLE_JITTER) },
          state: succeedPaper(okState, `已提交「${state.submissionId || '(未识别)'}」。`),
        };
      }

      // 提交失败：区分"可重试"与"重试也没用"
      const err = classifyError(prev.error ?? 'SUBMIT_FAILED');
      const afterFail: AutoState = { ...state, submitState: nextSubmitState(state.submitState, 'fail') };
      if (err.fatal || state.submitAttempts >= MAX_SUBMIT_ATTEMPTS) {
        const failed = failPaper(
          afterFail,
          err,
          prev.error ?? `提交失败（已尝试 ${state.submitAttempts} 次，不再重试）`,
        );
        return retryAfterFailed(failed);
      }
      const btnPt = topPoint(cfg.picks.submitButton);
      if (!btnPt) {
        const failed = failPaper(afterFail, classifyError('PICK_MISSING'), '提交按钮坐标无效');
        return retryAfterFailed(failed);
      }
      return {
        step: { kind: 'submit', x: btnPt.x, y: btnPt.y },
        state: {
          ...afterFail,
          submitAttempts: state.submitAttempts + 1,
          lastMessage: `${err.message}，第 ${state.submitAttempts + 1} 次重试。`,
        },
      };
    }

    case 'done':
      return endRun(state, 'done', '本轮已结束。');

    default: {
      // 穷尽性检查：新增 phase 而漏写分支时这里会**编译报错**
      const never: never = state.phase;
      return endRun(state, 'error', `未知状态 ${String(never)}。`, 'unknown_phase');
    }
  }
}

/* ------------------------------------------------- 便捷：跑到结束 */

/** 请求停止：由薄绑定在收到 auto:stop 时置位，状态机据此转向 idle */
export function stopAutoState(state: AutoState): AutoState {
  return { ...state, phase: 'idle', lastMessage: '已被用户停止。' };
}

/**
 * 把整轮跑完（在测试里用假的执行器）。
 *
 * @param execute 执行一个动作并回填结果。测试里用它制造各种故障
 * @param opts.maxSteps 防御性上限：状态机出错（死循环）必须有明确终点
 */
export async function runAutoLoop(
  state: AutoState,
  execute: (step: AutoStep, state: AutoState) => Promise<AutoStepResult>,
  opts: {
    maxSteps?: number;
    onStep?: (step: AutoStep, state: AutoState) => void;
  } = {},
): Promise<{ final: AutoState; outcome: AutoOutcome; steps: AutoStep[] }> {
  const maxSteps = opts.maxSteps ?? 512;
  const steps: AutoStep[] = [];
  let cur = state;
  let prev: AutoStepResult | undefined;
  /** 连续"既无动作也无结果"的次数。用于拦住状态机卡死 */
  let idleRounds = 0;

  for (let guard = 0; guard < maxSteps; guard++) {
    const r = nextAutoStep(cur, prev);
    cur = r.state;

    // 结束：**先判 outcome**。上一版把它放在 step 判断之后，
    // 结果 maxPapers 触发的 endRun 被写成 `continue`，运行永远不会停。
    if (r.outcome) return { final: cur, outcome: r.outcome, steps };

    if (!r.step) {
      // 这一份处理完毕且无需后续动作（standard 评分完 / steady 填完不提交）。
      // 状态机已把 phase 设为 awaitingPaper，下一轮自然发出 awaitNextPaper。
      // 必须清空 prev，否则会把上一个动作的结果误喂给新动作
      prev = undefined;
      if (++idleRounds > 4) {
        return {
          final: cur,
          outcome: {
            kind: 'error',
            handled: cur.handled,
            outcomes: cur.outcomes,
            skips: cur.skips,
            submitted: cur.submittedIds.length,
            error: `连续 ${idleRounds} 轮既无动作也无结果，状态机卡住了（这本身是个 bug）`,
          },
          steps,
        };
      }
      continue;
    }

    idleRounds = 0;
    steps.push(r.step);
    opts.onStep?.(r.step, cur);
    prev = await execute(r.step, cur);
  }

  return {
    final: cur,
    outcome: {
      kind: 'error',
      handled: cur.handled,
      outcomes: cur.outcomes,
      skips: cur.skips,
      submitted: cur.submittedIds.length,
      error: `状态机在 ${maxSteps} 步内未结束，已强制停止（这本身是个 bug）`,
    },
    steps,
  };
}

/** 填分动作的便捷构造器，给薄绑定用 */
export function fillConfigOf(score: string, x: number, y: number): { state: FillState; cfg: FillConfig } {
  const cfg: FillConfig = { x, y };
  return { state: initialFillState(score, cfg), cfg };
}

export { classifyError, runFillLoop };
export type { AutoErrorKind, FillCheck };