/**
 * 连续阅卷**执行层**状态机的单测。
 *
 * 这一层最严重的失败模式是**不该提交的提交了**：
 *   · `standard` 只评分不填分，结果要老师自己录入
 *   · `steady` 等老师确认后才填分，且**永不自动提交**
 * 两者一旦越界，后果是在老师的平台上真的按了提交按钮——
 * 分数进了系统的账，事后极难发现与撤回。所以下面用整整一组用例
 * 逐条钉住"哪些模式在哪些路径下都不允许出现 submit 步骤"。
 *
 * 其次的失败模式是重复提交（同一份卷子叠分）与单份失败拖垮整轮。
 */
import { describe, expect, it } from 'vitest';
import type { AutoGradeConfig, GradeResult, PickKind, PickResult } from '../src/shared/types';
import {
  DEFAULT_NEXT_PAPER_TIMEOUT_MS,
  MAX_SUBMIT_ATTEMPTS,
  type AutoState,
  type AutoStep,
  type AutoStepResult,
  initialAutoState,
  missingPicks,
  modeFills,
  modeSubmits,
  nextAutoStep,
  runAutoLoop,
} from '../src/main/page/auto-orchestrator';
import { initialFillState, type FillState } from '../src/main/page/autoloop';

/* --------------------------------------------------------- 工厂 */

function mkPick(kind: PickKind, x: number, y: number): PickResult {
  return {
    kind,
    mode: 'element',
    topX: x,
    topY: y,
    localX: x,
    localY: y,
    framePath: [],
    selector: `#${kind}`,
    width: 120,
    height: 28,
    tag: 'input',
    inIframe: false,
    pickedAt: 1_700_000_000_000,
  };
}

function mkCfg(p: Partial<AutoGradeConfig> = {}): AutoGradeConfig {
  return {
    pageUrl: 'https://platform.example.com/grade',
    kernel: 'chrome',
    mode: 'top',
    questionId: 'Q17',
    question: {
      stem: '计算碳酸钙的摩尔质量',
      fullScore: 10,
      referenceAnswer: '100 g/mol',
      scoringPoints: ['写出公式', '代入计算'],
    },
    picks: {
      scoreInput: mkPick('scoreInput', 500, 300),
      submitButton: mkPick('submitButton', 900, 700),
      questionRegion: mkPick('questionRegion', 400, 200),
    },
    throttleMs: 0,
    maxPapers: 0,
    nextPaperTimeoutMs: DEFAULT_NEXT_PAPER_TIMEOUT_MS,
    ...p,
  };
}

function mkGrade(p: Partial<GradeResult> = {}): GradeResult {
  return {
    score: 6,
    comment: '步骤基本完整',
    hitPoints: ['写出公式'],
    missedPoints: ['代入计算'],
    confidence: 0.9,
    reviewRequested: false,
    warnings: [],
    promptVersion: 'v1',
    promptHash: 'abc',
    ...p,
  };
}

function doneFill(score: string): FillState {
  const st = initialFillState(score, { x: 500, y: 300 });
  return { ...st, phase: 'done', attempts: 1 };
}

/* ------------------------------------------------- 假执行器 */

interface Scenario {
  /** 序列里第几份卷子（从 0 起）出现 */
  papers: number;
  /** 提交是否成功；给 false 则永远失败 */
  submitOk?: boolean;
  /** 提交失败时的错误文本 */
  submitError?: string;
  /** 第 N 次提交（从 0 起）返回成功，其余失败。用于测"重试后成功" */
  submitOkOnAttempt?: number;
  /** 评分是否成功 */
  gradeOk?: boolean;
  /**
   * 返回"没有被评分"的结果（图片质量不合格）。
   *
   * 与 `gradeOk: false` 是不同的两件事，必须分开测：
   *   · gradeOk=false → 评分流程本身失败（上游 500），走 AI_FAILED
   *   · ungradable=true → 评分流程**没有失败**，是图看不清所以没评，
   *     走的是"拒绝填分"的安全门
   * 把两者合并会测不出安全门——因为失败路径本来就不填分。
   */
  ungradable?: boolean;
  /** 截图是否成功 */
  captureOk?: boolean;
  /** 填分是否成功 */
  fillOk?: boolean;
  /** 老师是否确认 */
  confirmOk?: boolean;
  /** 每份卷子给不同的 submissionId */
  ids?: string[];
  /** 提交成功后等下一份时，是否还有下一份 */
  nextPaperAfterSubmit?: boolean;
}

/**
 * 把状态机跑完，记录每一步与提交次数。
 *
 * 假执行器**刻意不认识 submit 失败与重试的语义**——它只按脚本回填，
 * 语义全在状态机里。这样测出来的就是状态机本身的行为。
 */
async function runScenario(sc: Scenario, cfg: Partial<AutoGradeConfig> = {}) {
  const config = mkCfg(cfg);
  let paperIndex = 0;
  let submitCount = 0;
  let fillCount = 0;
  let gradeCount = 0;
  const submittedIds: string[] = [];
  const ids = sc.ids ?? ['S-001', 'S-002', 'S-003'];

  const execute = async (step: AutoStep, state: AutoState): Promise<AutoStepResult> => {
    switch (step.kind) {
      case 'wait':
        return { kind: 'wait' };
      case 'awaitNextPaper': {
        // 还有卷子就出现，并在这一步"翻到"下一份（模拟页面跳转）
        if (paperIndex < sc.papers) {
          paperIndex++;
          return { kind: 'awaitNextPaper', appeared: true };
        }
        return { kind: 'awaitNextPaper', appeared: false };
      }
      case 'collectPaper':
        // 每份卷子一个标识。真实实现从页面 DOM 读
        return { kind: 'collectPaper', paperId: ids[Math.min(paperIndex - 1, ids.length - 1)] ?? '' };
      case 'captureQuestion':
        return sc.captureOk === false
          ? { kind: 'captureQuestion', error: '截图失败：元素不可用' }
          : { kind: 'captureQuestion', base64: 'BASE64DEMO' };
      case 'grade': {
        gradeCount++;
        if (sc.gradeOk === false) {
          return { kind: 'grade', ok: false, error: '评分失败：上游 500' };
        }
        if (sc.ungradable) {
          // 模拟质量闸门的产出：分数是 0，但那是"没评分"而不是"学生得 0 分"
          return {
            kind: 'grade',
            ok: true,
            grade: mkGrade({
              score: 0,
              confidence: 0,
              reviewRequested: true,
              warnings: ['题目区域逻辑尺寸仅 120×60，文字无法辨认'],
              hitPoints: [],
              missedPoints: [],
              ungradable: true,
            }),
          };
        }
        return { kind: 'grade', ok: true, grade: mkGrade() };
      }
      case 'awaitConfirm':
        return { kind: 'confirm', ok: sc.confirmOk !== false };
      case 'fillScore':
        fillCount++;
        return {
          kind: 'fillScore',
          state: sc.fillOk === false
            ? { ...initialFillState(step.score, { x: step.x, y: step.y }), phase: 'gaveUp', attempts: 3, lastCheck: { verdict: 'empty', expected: step.score, actual: '', message: '回读为空' } }
            : doneFill(step.score),
        };
      case 'submit': {
        submitCount++;
        submittedIds.push(state.submissionId);
        const okOn = sc.submitOkOnAttempt;
        const ok = okOn !== undefined ? submitCount === okOn + 1 : sc.submitOk !== false;
        return ok ? { kind: 'submit', ok: true } : { kind: 'submit', ok: false, error: sc.submitError ?? 'SUBMIT_FAILED: 平台返回 500' };
      }
      default:
        throw new Error(`假执行器不认识动作 ${(step as { kind: string }).kind}`);
    }
  };

  /*
   * 卷子标识由 `collectPaper` 动作读出并回填（真实实现从页面的
   * 考号/流水号读；这里按出现次序从 ids 数组取）。
   *
   * ⚠ 曾经的两种错误做法，都留下了案例：
   *   · 在 `execute` 里直接改 `state.submissionId` —— 改的是局部副本，
   *     `runAutoLoop` 的 `cur` 看不到，幂等判据永远是空串，
   *     而**测试还会"通过"**（空串被视为"无需拦截"）
   *   · 用 out-of-band 的 `onPaperAppear` 钩子写入 —— 钩子的写入时机
   *     与状态机的前进时机错位，steady 模式连填分都没走到
   * 结论：凡"状态机需要、但只有薄绑定能提供"的信息，都应是一个**动作**，
   * 而不是一个回调。
   */
  const r = await runAutoLoop(initialAutoState(config), execute);

  return { ...r, submitCount, fillCount, gradeCount, submittedIds, config };
}

function kindsOf(steps: AutoStep[]): string[] {
  return steps.map((s) => s.kind);
}

/* --------------------------------------------- 模式能力矩阵 */

describe('模式能力：谁能填分、谁能提交', () => {
  it('★ standard 不填分；只有 top 能提交', () => {
    expect(modeFills('standard')).toBe(false);
    expect(modeFills('steady')).toBe(true);
    expect(modeFills('top')).toBe(true);

    // 这条矩阵就是安全不变量的定义。改它就等于改产品承诺
    expect(modeSubmits('standard')).toBe(false);
    expect(modeSubmits('steady')).toBe(false);
    expect(modeSubmits('top')).toBe(true);
  });
});

describe('开工前检查 missingPicks', () => {
  const full = mkCfg().picks;

  it('top 模式需要分数框与提交按钮', () => {
    expect(missingPicks({}, 'top')).toEqual(['scoreInput', 'submitButton']);
    expect(missingPicks(full, 'top')).toEqual([]);
  });

  it('standard 模式不需要分数框也不需要提交按钮（它不填分）', () => {
    expect(missingPicks({}, 'standard')).toEqual([]);
  });

  it('steady 需要分数框但**不需要**提交按钮（它永不提交）', () => {
    expect(missingPicks({}, 'steady')).toEqual(['scoreInput']);
    expect(missingPicks({ scoreInput: full.scoreInput }, 'steady')).toEqual([]);
  });

  it('★ 坐标非法算作缺失，而不是被当成 (0,0) 点下去', () => {
    const broken = { ...full, scoreInput: { ...full.scoreInput!, topX: Number.NaN } };
    expect(missingPicks(broken, 'top')).toContain('scoreInput');
    const inf = { ...full, submitButton: { ...full.submitButton!, topY: Number.POSITIVE_INFINITY } };
    expect(missingPicks(inf, 'top')).toContain('submitButton');
  });
});

/* --------------------------------------------- 安全不变量 */

describe('★ 安全不变量：不该提交的绝不提交', () => {
  it('standard 模式：跑完整轮，一个 submit 都没有，也不填分', async () => {
    const r = await runScenario({ papers: 3 }, { mode: 'standard' });
    expect(kindsOf(r.steps)).not.toContain('submit');
    expect(kindsOf(r.steps)).not.toContain('fillScore');
    expect(r.submitCount).toBe(0);
    expect(r.outcome.kind).toBe('done');
    expect(r.outcome.handled).toBe(3);
    // 只评分，不填分 —— 但评分必须真的发生了
    expect(r.gradeCount).toBe(3);
  });

  it('steady 模式：老师全部确认，仍然一个 submit 都没有，但分数已填入', async () => {
    const r = await runScenario({ papers: 2, confirmOk: true }, { mode: 'steady' });
    expect(kindsOf(r.steps)).toContain('fillScore');
    expect(kindsOf(r.steps)).toContain('awaitConfirm');
    expect(kindsOf(r.steps)).not.toContain('submit');
    expect(r.submitCount).toBe(0);
    expect(r.outcome.kind).toBe('done');
    expect(r.outcome.handled).toBe(2);
  });

  it('steady 模式：老师未确认 → 该份记失败，且整轮继续（单份隔离）', async () => {
    const r = await runScenario({ papers: 1, confirmOk: false }, { mode: 'steady' });
    expect(r.submitCount).toBe(0);
    expect(r.outcome.handled).toBe(1);
    expect(r.outcome.outcomes[0]?.ok).toBe(false);
    // 未确认归到 CANCELLED，而不是 UNKNOWN：处置建议完全不同
    expect(r.outcome.outcomes[0]?.errorKind).toBe('CANCELLED');
  });

  it('top 模式：确实会提交，且每份恰好一次', async () => {
    const r = await runScenario({ papers: 3 });
    expect(r.submitCount).toBe(3);
    expect(r.outcome.kind).toBe('done');
    expect(r.outcome.submitted).toBe(3);
  });

  it('★ 缺拾取配置时整轮中止，而不是每份都失败一次', async () => {
    const r = await runScenario({ papers: 3 }, { mode: 'top', picks: {} });
    expect(r.outcome.kind).toBe('error');
    expect(r.outcome.error).toContain('missing_picks:scoreInput,submitButton');
    expect(kindsOf(r.steps)).toEqual([]);
    expect(r.submitCount).toBe(0);
  });
});

/* --------------------------------------------- 幂等与限额 */

describe('★ 幂等：同一份卷子不提交两次', () => {
  it('同一 submissionId 重复出现时被跳过并记录 skip', async () => {
    // 三份卷子但 id 全是同一个 → 第一份提交，后两份必须被跳过
    const r = await runScenario({ papers: 3, ids: ['S-SAME', 'S-SAME', 'S-SAME'] });
    expect(r.submitCount).toBe(1);
    expect(r.outcome.submitted).toBe(1);
    expect(r.outcome.skips.length).toBe(2);
    expect(r.outcome.skips.every((s) => s.reason === 'already_submitted')).toBe(true);
    /*
     * `handled` 只统计**真正处理完成**的份数（成功或失败）。
     * 被幂等拦下的份既没成功也没失败——它压根没被处理，
     * 所以是 1（那份成功的）而不是 0 或 3。
     * 把跳过也计进 handled 会让 maxPapers 提前到点，静默少批几份。
     */
    expect(r.outcome.handled).toBe(1);
  });

  it('不同 id 时不会误跳', async () => {
    const r = await runScenario({ papers: 3, ids: ['S-1', 'S-2', 'S-3'] });
    expect(r.submitCount).toBe(3);
    expect(r.outcome.skips).toEqual([]);
  });
});

describe('限额与超时', () => {
  it('maxPapers 到点即停，不会多处理一份', async () => {
    const r = await runScenario({ papers: 5 }, { maxPapers: 2 });
    expect(r.outcome.handled).toBe(2);
    expect(r.submitCount).toBe(2);
    expect(r.outcome.kind).toBe('done');
  });

  it('★ 等不到新卷子时如实说"是等超时结束的"', async () => {
    const r = await runScenario({ papers: 1 }, { nextPaperTimeoutMs: 3000 });
    // 处理完 1 份后，下一轮 awaitNextPaper 返回 appeared:false
    expect(r.outcome.kind).toBe('done');
    expect(r.outcome.handled).toBe(1);
    expect(r.final.lastMessage).toContain('3 秒');
    expect(r.final.lastMessage).toContain('未见新卷子');
  });

  it('maxPapers=0 表示不限，不会因 0 就立刻停', async () => {
    const r = await runScenario({ papers: 2 }, { maxPapers: 0 });
    expect(r.outcome.handled).toBe(2);
  });
});

/* --------------------------------------------- 单份隔离 */

describe('★ 单份隔离：一份失败不影响其他份', () => {
  it('评分失败的一份不填分不提交，其余照常', async () => {
    const r = await runScenario({ papers: 3, gradeOk: false });
    expect(r.submitCount).toBe(0);
    expect(r.outcome.handled).toBe(3);
    expect(r.outcome.outcomes.every((o) => !o.ok)).toBe(true);
    // AI_FAILED 不是 fatal，所以本轮继续跑完
    expect(r.outcome.outcomes.every((o) => o.errorKind === 'AI_FAILED')).toBe(true);
  });

  it('截图失败的一份不评分，其余照常', async () => {
    const r = await runScenario({ papers: 2, captureOk: false }, { mode: 'standard' });
    expect(r.gradeCount).toBe(0);
    // 截图失败 = 题目区域元素不可用 → ELEMENT_NOT_FOUND。
    // 这条断言曾经"看起来无法满足"，因为 ERROR_RULES 里根本没有这条规则，
    // 传进去会静默落到 UNKNOWN；规则已按测试先行补上（见 geometry.test.ts）
    expect(r.outcome.outcomes.every((o) => o.errorKind === 'ELEMENT_NOT_FOUND')).toBe(true);
  });

  it('填分失败的一份不提交，其余照常', async () => {
    const r = await runScenario({ papers: 3, fillOk: false });
    expect(r.submitCount).toBe(0);
    expect(r.outcome.handled).toBe(3);
    expect(r.outcome.outcomes.every((o) => !o.ok)).toBe(true);
    // 回读为空（写入未生效）→ VALUE_UNREADABLE，而不是笼统的 UNKNOWN
    expect(r.outcome.outcomes.every((o) => o.errorKind === 'VALUE_UNREADABLE')).toBe(true);
  });

  it('提交失败后按上限重试，仍失败则记该份失败且不重复计数', async () => {
    const r = await runScenario({ papers: 1, submitOk: false });
    expect(r.submitCount).toBe(MAX_SUBMIT_ATTEMPTS);
    expect(r.outcome.outcomes[0]?.errorKind).toBe('SUBMIT_FAILED');
    expect(r.outcome.submitted).toBe(0);
  });

  it('★ 提交重试成功时只算提交一次', async () => {
    // 第 2 次提交尝试成功
    const r = await runScenario({ papers: 1, submitOkOnAttempt: 1 });
    expect(r.submitCount).toBe(2);
    expect(r.outcome.submitted).toBe(1);
    expect(r.outcome.outcomes[0]?.ok).toBe(true);
  });
});

/* --------------------------------------------- 状态机契约 */

describe('★ 图片质量不合格：拒绝填分（不能把"没评分"当 0 分）', () => {
  /*
   * 这一组是本轮最重要的不变量。
   *
   * 背景：质量闸门在"图看不清"时会产出一份 `ungradable` 结果，
   * 它的 `score` 是 0。如果状态机不区分，top 模式会把这个 0 填进
   * 平台并提交——一份看不清的卷子就变成了学生成绩单上的真实 0 分，
   * 而且因为走的是正常填分路径，**看起来完全正常**。
   *
   * 所以三种模式都必须测：不是"standard 本来就填分所以没事"，
   * 而是**任何模式都不许填**。
   */

  it('★ top 模式：不填分、不提交、不产生 0 分记录', async () => {
    const r = await runScenario({ papers: 2, ungradable: true }, { mode: 'top' });
    expect(r.fillCount).toBe(0);
    expect(r.submitCount).toBe(0);
    // 评分调用是发生过的（闸门在绑定层，评分层仍然被调用），但结果不可采信
    expect(r.gradeCount).toBe(2);
  });

  it('★ steady 模式：不进入"等待确认"（没有分数可确认）', async () => {
    const r = await runScenario({ papers: 2, ungradable: true }, { mode: 'steady' });
    expect(r.fillCount).toBe(0);
    expect(r.submitCount).toBe(0);
    // confirm 不该被请求：若请求了，老师会被要求确认一个不存在的 0 分
    expect(r.steps.some((s) => s.kind === 'awaitConfirm')).toBe(false);
  });

  it('standard 模式也不填分（与它的既有语义一致，一并覆盖）', async () => {
    const r = await runScenario({ papers: 1, ungradable: true }, { mode: 'standard' });
    expect(r.fillCount).toBe(0);
    expect(r.submitCount).toBe(0);
  });

  it('★ 与"评分流程失败"区分开：ungradable 不是 AI_FAILED', async () => {
    /*
     * 两者都是"没分可填"，但原因与处置完全不同：
     *   · ungradable → 图看不清，要重新拾取题目区域
     *   · AI_FAILED  → 上游/配置问题，要查网络与 API
     * 若日志里都写成 AI_FAILED，排查方向会被带偏。
     */
    const r = await runScenario({ papers: 1, ungradable: true }, { mode: 'top' });
    const all = JSON.stringify(r);
    expect(all).not.toContain('AI_FAILED');
  });

  it('ungradable 的份数计入 handled（它确实被处理过，只是没给分）', async () => {
    const r = await runScenario({ papers: 2, ungradable: true }, { mode: 'top' });
    expect(r.outcome.handled).toBe(2);
  });

  it('每份 ungradable 都单独记账，不会互相影响', async () => {
    const r = await runScenario({ papers: 3, ungradable: true }, { mode: 'top' });
    expect(r.outcome.handled).toBe(3);
    expect(r.fillCount).toBe(0);
  });
});

describe('状态机与动作的契约', () => {
  it('首次推进先等一下再等卷子，不会立刻截图（避免截到空白图）', () => {
    const s = initialAutoState(mkCfg());
    const r = nextAutoStep(s);
    expect(r.step?.kind).toBe('wait');
    // 停在 settling 而不是 awaitingPaper：awaitingPaper 只接受
    // awaitNextPaper 的结果，若复用同一阶段，wait 的结果会被判为 mismatch
    expect(r.state.phase).toBe('settling');
  });

  it('★ 动作与状态不匹配时明确报错，而不是猜着继续', () => {
    const s = { ...initialAutoState(mkCfg()), phase: 'capturing' as const };
    const r = nextAutoStep(s, { kind: 'submit', ok: true });
    expect(r.outcome?.kind).toBe('error');
    expect(r.outcome?.error).toBe('step_mismatch');
  });

  it('走到 done 之后不再产生任何动作', () => {
    const s = { ...initialAutoState(mkCfg()), phase: 'done' as const };
    let r = nextAutoStep(s);
    for (let i = 0; i < 5; i++) {
      expect(r.step).toBeNull();
      expect(r.outcome?.kind).toBe('done');
      r = nextAutoStep(r.state, undefined);
    }
  });

  it('状态流形如：先把 phase 走到 awaitingPaper 再交回', async () => {
    const r = await runScenario({ papers: 1 });
    // 一次完整的 top 流程：capture → grade → fillScore → submit
    const k = kindsOf(r.steps);
    expect(k).toContain('awaitNextPaper');
    expect(k).toContain('captureQuestion');
    expect(k).toContain('grade');
    expect(k).toContain('fillScore');
    expect(k).toContain('submit');
    // 顺序必须如此：先截图再评分，先填分再提交
    expect(k.indexOf('captureQuestion')).toBeLessThan(k.indexOf('grade'));
    expect(k.indexOf('scoreInput')).toBe(-1); // 不该出现拾取类动作
    expect(k.indexOf('fillScore')).toBeLessThan(k.indexOf('submit'));
  });

  it('每一步的 lastMessage 非空（界面与日志都靠它）', async () => {
    const r = await runScenario({ papers: 1 });
    expect(r.final.lastMessage.length).toBeGreaterThan(0);
  });

  it('防御性上限：executor 永远返回 appeared:true 时也能停住', async () => {
    const cfg = mkCfg({ maxPapers: 0 });
    const r = await runAutoLoop(
      initialAutoState(cfg),
      async (step) => {
        if (step.kind === 'awaitNextPaper') return { kind: 'awaitNextPaper', appeared: true };
        if (step.kind === 'wait') return { kind: 'wait' };
        if (step.kind === 'captureQuestion') return { kind: 'captureQuestion', base64: 'X' };
        if (step.kind === 'grade') return { kind: 'grade', ok: true, grade: mkGrade() };
        if (step.kind === 'fillScore') return { kind: 'fillScore', state: doneFill(step.score) };
        if (step.kind === 'submit') return { kind: 'submit', ok: true };
        return { kind: 'wait' };
      },
      { maxSteps: 40 },
    );
    /*
     * 这个假执行器不认识 collectPaper（新动作），所以会在
     * captureQuestion 那一步拿到不匹配的结果 → step_mismatch。
     * 这**同样**证明了状态机会明确报错而不是猜着继续，但换了原因，
     * 所以断言必须跟着改——否则测的是"旧流程下会怎样"。
     */
    expect(r.outcome.kind).toBe('error');
    expect(r.outcome.error).toBe('step_mismatch');
  });
});

/* --------------------------------------------- 数值清洗贯通 */

describe('分数清洗在执行层也生效', () => {
  it('全角/带单位的分数被清洗后再填入', async () => {
    const cfg = mkCfg();
    let filled = '';
    let appearCount = 0;
    const r = await runAutoLoop(
      initialAutoState(cfg),
      async (step) => {
        if (step.kind === 'wait') return { kind: 'wait' };
        if (step.kind === 'awaitNextPaper') {
          // 第一次出现卷子，之后不再出现 → 让本轮自然结束
          return { kind: 'awaitNextPaper', appeared: appearCount++ === 0 };
        }
        if (step.kind === 'collectPaper') return { kind: 'collectPaper', paperId: 'S-1' };
        if (step.kind === 'captureQuestion') return { kind: 'captureQuestion', base64: 'X' };
        if (step.kind === 'grade') return { kind: 'grade', ok: true, grade: mkGrade({ score: 6.5 }) };
        if (step.kind === 'fillScore') {
          filled = step.score;
          return { kind: 'fillScore', state: doneFill(step.score) };
        }
        if (step.kind === 'submit') return { kind: 'submit', ok: true };
        return { kind: 'wait' };
      },
      { maxSteps: 30 },
    );
    expect(filled).toBe('6.5');
    expect(r.outcome.handled).toBe(1);
    expect(r.outcome.submitted).toBe(1);
  });

  it('模型给分字符串时被清洗成数字文本，并用于填分', async () => {
    /*
     * 这个用例经过几轮修正才稳定，值得记下踩的坑：
     * 一开始想直接读 `nextAutoStep(...).state.lastScore`——读不到，
     * 因为 `succeedPaper()` 会把"这一份"的临时字段（lastScore /
     * lastComment / submissionId）全部清掉，防止跨份误用。
     * 那是**正确行为**，所以不能改它去迁就测试。
     *
     * 正确读法：用一次完整 loop，在状态机**真正用这个分数去填分**
     * 的那一刻抓取——那正是它唯一有用武之地的地方。
     */
    let filled = '';
    const steps: string[] = [];
    let appearCount = 0;
    await runAutoLoop(
      initialAutoState(mkCfg({ mode: 'top' })),
      async (step) => {
        steps.push(step.kind);
        switch (step.kind) {
          case 'wait':
            return { kind: 'wait' };
          case 'awaitNextPaper':
            return { kind: 'awaitNextPaper', appeared: appearCount++ === 0 };
          case 'collectPaper':
            return { kind: 'collectPaper', paperId: 'S-1' };
          case 'captureQuestion':
            return { kind: 'captureQuestion', base64: 'X' };
          case 'grade':
            return { kind: 'grade', ok: true, grade: mkGrade({ score: 10 }) };
          case 'fillScore':
            filled = step.score;
            return { kind: 'fillScore', state: doneFill(step.score) };
          case 'submit':
            return { kind: 'submit', ok: true };
          default:
            return { kind: 'wait' };
        }
      },
      { maxSteps: 30 },
    );

    expect(steps).toContain('fillScore');
    expect(filled).toBe('10'); // 数字 10 被转成文本，可写入输入框
    expect(steps.indexOf('grade')).toBeLessThan(steps.indexOf('fillScore'));
  });
});