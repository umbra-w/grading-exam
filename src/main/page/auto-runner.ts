import type { AIConfig, AutoGradeConfig, GradeResult, ImagePart, PickResult } from '../../shared/types';
import { gradeQuestion } from '../ai/client';
import { addUsage, loadSettings } from '../store';
import { resolveFrameId } from './cdp';
import { type FillCheck, classifyError, verifyFilledValue } from './geometry';
import {
  type QualityReport,
  classifyImageQuality,
  gradeYield,
  parsePngSize,
} from './quality';
import { PROMPT_SET_HASH } from '../ai/prompts';
import { type FillAction, type FillState, initialFillState, nextFillStep } from './autoloop';
import {
  type AutoState,
  type AutoStep,
  type AutoStepResult,
  initialAutoState,
  nextAutoStep,
} from './auto-orchestrator';
import type { PlatformBrowser } from './browser';

/*
 * ══════════════════════════════════════════════════════════════════════════
 *  auto:* 的**薄绑定层**
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ⚠ 验证状态：**本机无法验证**。
 * 本段依赖真实 BrowserWindow 与 CDP（Electron 在 app.whenReady() 处崩溃，
 * 见 BLOCKERS.md B3）。它包含的一切**判定逻辑**都已经抽到纯模块里并被单测
 * 覆盖：状态机在 auto-orchestrator.ts（28 项）、填分重试在 autoloop.ts
 * （37 项）、坐标与错误分类在 geometry.ts（66 项）。
 * 本文件只剩"把动作翻译成 CDP 调用"这一件事，而这件事只能在真机上验。
 *
 * 要验证它需要：一台能启动 Electron 的 Windows 机器 + 一个真实阅卷平台账号
 * （见 BLOCKERS.md）。在此之前，它**不得**被描述为"已验证可用"。
 *
 * ── 与状态机的分工（§4.4）────────────────────────────────────────────────
 *
 * 状态机负责"下一步该做什么"与全部安全不变量（standard 不填分、
 * steady 不提交、同一份不提交两次）；本文件只负责"把那个动作做出来"。
 * 任何判断只要能放进状态机，就必须放进去 —— 留在这里就无法单测。
 *
 * ── 为什么此处另写一个填分循环，而不是复用 runFillLoop ─────────────────────
 *
 * `runFillLoop` 的 responder 是**同步**的（`(attempt) => FillCheck | undefined`），
 * 而"回读输入框的值"必须 `await`（走 CDP）。同步签名在这里用不了。
 * 所以本文件用 `nextFillStep`（同一个纯状态机）驱动一个异步循环——
 * 判定与重试策略仍全部来自已测过的纯逻辑，这里只管 await。
 */

/* ------------------------------------------------------- 真实适配器 */

export interface AutoRunnerHooks {
  log: (level: 'info' | 'warn' | 'error' | 'ok', message: string) => void;
  progress: (p: { running: boolean; handled: number; current: string; lastScore: number | null }) => void;
  awaitConfirm: (payload: { score: number; comment: string }) => void;
  finished: (outcome: { kind: string; handled: number; submitted: number; error?: string }) => void;
}

/** 分数输入框的回读表达式：兼容 input/textarea 与 contenteditable */
const READ_VALUE_JS = `(() => {
  const el = document.activeElement;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return el.value;
  return null;
})()`;

export class AutoRunner {
  private state: AutoState;
  /**
   * 最近一次截图的质量报告。
   *
   * 为什么要存而不是现场再算：截图是一次性的，重算需要再截一次图
   * （代价高，而且两次截图的内容可能已经变了）。质量判定的输入
   * （尺寸、DPR、字节数）在截图那一刻就确定，存下来最省也最准。
   */
  private lastQuality: QualityReport | null = null;
  private running = false;
  private stopped = false;
  private confirmResolve: ((ok: boolean) => void) | null = null;

  constructor(
    private readonly browser: PlatformBrowser,
    cfg: AutoGradeConfig,
    private readonly hooks: AutoRunnerHooks,
    private readonly aiCfg?: AIConfig,
  ) {
    this.state = initialAutoState(cfg);
  }

  isRunning(): boolean {
    return this.running;
  }

  /** auto:stop —— 停止整轮。正在等待的确认会被判为"未确认" */
  stop(): void {
    this.stopped = true;
    const r = this.confirmResolve;
    this.confirmResolve = null;
    r?.(false);
    this.hooks.log('info', '收到停止请求，本轮将在此之前收尾。');
  }

  /** auto:confirm —— 老师点了确认 */
  confirm(): boolean {
    const r = this.confirmResolve;
    if (!r) {
      // 没有待确认的请求时收到 confirm：如实说，不假装成功
      this.hooks.log('warn', '当前没有等待确认的评分，本次确认被忽略。');
      return false;
    }
    this.confirmResolve = null;
    r(true);
    return true;
  }

  /**
   * 跑完整轮。由 `auto:start` 调用（**不 await**：可能跑几十分钟，
   * 阻塞 IPC 会让整个界面卡死）。
   */
  async run(): Promise<void> {
    if (this.running) {
      this.hooks.log('warn', '上一轮尚未结束，本次启动被忽略。');
      return;
    }
    this.running = true;
    this.emitProgress('启动中', null);

    let prev: AutoStepResult | undefined;
    try {
      for (let guard = 0; guard < 4096; guard++) {
        if (this.stopped) {
          this.hooks.log('ok', `已停止。本轮共处理 ${this.state.handled} 份。`);
          return;
        }

        const r = nextAutoStep(this.state, prev);
        this.state = r.state;

        if (r.outcome) {
          this.hooks.finished({
            kind: r.outcome.kind,
            handled: r.outcome.handled,
            submitted: r.outcome.submitted,
            ...(r.outcome.error === undefined ? {} : { error: r.outcome.error }),
          });
          this.hooks.log(r.outcome.kind === 'error' ? 'error' : 'ok', r.state.lastMessage);
          return;
        }

        if (!r.step) {
          // 这一份处理完毕且无需后续动作（standard 评分完 / steady 填完不提交）
          prev = undefined;
          this.emitProgress(this.state.lastMessage, null);
          continue;
        }

        this.emitProgress(this.state.lastMessage, this.state.lastScore);
        prev = await this.perform(r.step);
      }
      // 走到这里说明 4096 步还没结束——这本身就是 bug，必须说出来
      const msg = '连续阅卷超过 4096 步仍未结束，已强制停止（这本身是个 bug）。';
      this.hooks.log('error', msg);
      this.hooks.finished({ kind: 'error', handled: this.state.handled, submitted: this.state.submittedIds.length, error: msg });
    } catch (err) {
      // 兜底：未预期异常必须留下记录，而不是静默结束一轮
      const msg = (err as Error)?.message ?? String(err);
      this.hooks.log('error', `连续阅卷异常终止：${msg}`);
      this.hooks.finished({
        kind: 'error',
        handled: this.state.handled,
        submitted: this.state.submittedIds.length,
        error: msg,
      });
    } finally {
      this.running = false;
      this.hooks.progress({ running: false, handled: this.state.handled, current: '已结束', lastScore: null });
    }
  }

  private emitProgress(current: string, lastScore: string | null): void {
    this.hooks.progress({
      running: true,
      handled: this.state.handled,
      current,
      lastScore: lastScore === null ? null : Number(lastScore),
    });
  }

  /* ---------------------------------------------- 动作 → CDP 调用 */

  private async perform(step: AutoStep): Promise<AutoStepResult> {
    switch (step.kind) {
      case 'wait':
        await sleep(step.ms);
        return { kind: 'wait' };
      case 'awaitNextPaper':
        return await this.waitForNextPaper(step.timeoutMs);
      case 'collectPaper':
        return await this.collectPaper();
      case 'captureQuestion':
        return await this.captureQuestion();
      case 'grade':
        return await this.grade(step.paperBase64);
      case 'awaitConfirm':
        return await this.awaitConfirmStep(step.reason);
      case 'fillScore':
        return await this.fillScore(step.score, step.x, step.y);
      case 'submit':
        return await this.submit();
      default: {
        // 穷尽性检查：新增动作而漏写分支时这里会编译报错
        const never: never = step;
        return { kind: 'captureQuestion', error: `未知动作 ${JSON.stringify(never)}` };
      }
    }
  }

  /* ------------------------------------------------ 页面读取原语 */

  /**
   * 把拾取时记下的 framePath 换成**当前**的 frameId。
   *
   * 为什么不直接用拾取时存的路径：拾取与运行之间页面可能重载，frame 树
   * 会重建（framePath 是结构位置，位置对但 id 变了）。所以每次读取都
   * 重新取一次 frame 树再解析，代价是一次 `getFrameTree()`。
   */
  private async frameIdFor(pick: PickResult): Promise<string | null> {
    const session = this.browser.session();
    if (!session) return null;
    try {
      const tree = await session.getFrameTree();
      if (pick.framePath.length === 0) return tree.frame.id;
      return resolveFrameId(tree, pick.framePath);
    } catch {
      return null;
    }
  }

  /** 读取一个输入框的当前值。读不到返回 null（**不要**返回空串冒充成功） */
  private async readInputValue(pick: PickResult): Promise<string | null> {
    const session = this.browser.session();
    if (!session) return null;
    const frameId = await this.frameIdFor(pick);
    if (!frameId) return null;
    try {
      const raw = await session.evaluateInFrame(frameId, READ_VALUE_JS);
      return raw === null || raw === undefined ? null : String(raw);
    } catch {
      return null;
    }
  }

  /** 当前顶层页面 URL（用于识别"换了一份卷子"） */
  private async topUrl(): Promise<string> {
    const session = this.browser.session();
    if (!session) return '';
    try {
      const tree = await session.getFrameTree();
      const raw = await session.evaluateInFrame(tree.frame.id, 'location.href');
      return raw === null || raw === undefined ? '' : String(raw);
    } catch {
      return '';
    }
  }

  /* ------------------------------------------------ 各动作实现 */

  /**
   * 等下一份卷子出现。
   *
   * 判据是 URL 变了**或**分数框回到空值，两者取或：
   *  - 只看 URL 不行：很多平台在同一页面用 AJAX 换题，URL 不变
   *  - 只看分数框不行：老师手工填过分的题会被误判成"已完成"
   * 超时按**正常结束**处理（老师可能就是批完了），状态机会如实说明
   * "是等超时结束的"，而不是假装处理完了所有卷子。
   */
  private async waitForNextPaper(timeoutMs: number): Promise<AutoStepResult> {
    const session = this.browser.session();
    const pick = this.browser.picks().scoreInput;
    if (!session || !pick) return { kind: 'awaitNextPaper', appeared: false };

    const startUrl = await this.topUrl();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.stopped) return { kind: 'awaitNextPaper', appeared: false };
      await sleep(Math.min(500, Math.max(50, Math.floor(timeoutMs / 20))));
      const url = await this.topUrl();
      if (startUrl !== '' && url !== '' && url !== startUrl) {
        return { kind: 'awaitNextPaper', appeared: true };
      }
      const val = await this.readInputValue(pick);
      if (val !== null && val.trim() === '') return { kind: 'awaitNextPaper', appeared: true };
    }
    return { kind: 'awaitNextPaper', appeared: false };
  }

  /**
   * 卷子标识（幂等判据）。
   *
   * ⚠ 这是**近似物，不是真标识**。config 里没有"卷子标识元素"这一拾取项，
   * 且每个平台标识的取法都不同，没有通用解。所以用 URL + 分数框初值
   * 组成的指纹：
   *  - 同一份卷子重复出现（页面没跳转）→ 指纹不变 → 被正确拦下
   *  - 换成另一份卷子 → URL 或分数框值通常变化 → 指纹变化 → 正常批改
   * 撞指纹的后果是**少批一份**（被误判为重复），而不是重复提交。
   * 这是刻意选的失败方向：宁可少批一份让老师补，也不能把分数重复
   * 叠进平台的账里（那种事故事后极难发现与撤回）。
   */
  private async collectPaper(): Promise<AutoStepResult> {
    const pick = this.browser.picks().scoreInput;
    const url = await this.topUrl();
    const val = pick ? await this.readInputValue(pick) : null;
    const score = val === null ? '?' : val.trim();
    // 去掉 fragment：平台常拿它做锚点跳转，同一份卷子会出现不同 URL
    const cleanUrl = url.split('#')[0] ?? url;
    const paperId = `${cleanUrl}|score=${score}`;
    this.hooks.log('info', `识别当前卷子：${paperId}`);
    return { kind: 'collectPaper', paperId };
  }

  /**
   * 截图并**在送评分之前**判断这张图能不能看清。
   *
   * 为什么必须在这里判断：质量检查的唯一目的就是**避免那次 API 调用**。
   * 等评分完再发现图看不清，钱已经花了、假分也已经产生了。
   *
   * 判据必须按**逻辑像素**（用页面真实 devicePixelRatio 归一），
   * 否则高 DPI 屏上截图像素翻倍，一个老师肉眼都嫌小的题目区域
   * 会被判成"尺寸充足"。DPR 只能从页面读，所以这里要取一次 viewport。
   */
  private async captureQuestion(): Promise<AutoStepResult> {
    const r = await this.browser.captureQuestionRegion();
    if (!r.ok || !r.base64) {
      this.lastQuality = null;
      return { kind: 'captureQuestion', error: r.error ?? '截图返回空' };
    }

    // 取 DPR。取不到不编造——按 1 处理，与 quality 模块的归一化一致
    let dpr = 1;
    try {
      const vp = await this.browser.session()?.getViewport();
      if (vp && Number.isFinite(vp.devicePixelRatio) && vp.devicePixelRatio > 0) {
        dpr = vp.devicePixelRatio;
      }
    } catch {
      // 拿不到 DPR 不致命：quality 模块会按 1 处理并如实记录
    }

    /*
     * 从 base64 解出 PNG 尺寸。**不解码位图** —— 那需要图像库，
     * 而且代价与收益不成比例（我们要的只是"够不够大"）。
     * 解不出尺寸时 quality 模块会判 `insufficient`（必须复核），
     * 而不是默认放行。
     */
    let size: { width: number; height: number } | null = null;
    try {
      const raw = Buffer.from(r.base64, 'base64');
      size = parsePngSize(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
    } catch {
      size = null;
    }

    const quality = classifyImageQuality({
      width: size?.width ?? null,
      height: size?.height ?? null,
      devicePixelRatio: dpr,
      // base64 长度 ≈ 字节数 × 4/3，用这个估编码后大小做空白判定
      encodedBytes: Math.floor((r.base64.length * 3) / 4),
    });
    this.lastQuality = quality;

    this.hooks.log(
      quality.verdict === 'ok' ? 'info' : 'warn',
      `图片质量：${quality.verdict}（${quality.effectiveWidth}×${quality.effectiveHeight} 逻辑像素）`,
    );
    if (quality.mustReview && quality.advice.length > 0) {
      this.hooks.log('info', `建议：${quality.advice[0]}`);
    }

    return { kind: 'captureQuestion', base64: r.base64, quality };
  }

  private async grade(base64: string): Promise<AutoStepResult> {
    const cfg = this.state.cfg;
    const aiCfg = this.aiCfg ?? loadSettings().ai;
    const images: ImagePart[] = [{ data: base64, mime: 'image/png' }];

    /*
     * ★ 质量闸门：图看不清就**根本不调用 API**。
     *
     * `gradeYield` 在必须复核时返回一份 `ungradable` 结果
     * （分数 0，但那是"没评分"）。状态机会据 `ungradable` 拒绝填分
     * ——那道门在 auto-orchestrator.ts 里，已有专门测试。
     *
     * 质量报告为 null 时按 `insufficient` 处理（必须复核），
     * 而不是当"没检查过所以放行"：闸门的意义就在于
     * 「没测过」不等于「测过且通过」（§6.3）。
     */
    const quality: QualityReport =
      this.lastQuality ??
      classifyImageQuality({ width: null, height: null, devicePixelRatio: 1 });

    if (quality.mustReview) {
      const blocked = gradeYield(
        quality,
        undefined,
        this.paperIdForQuality(),
        cfg.question.fullScore,
        PROMPT_SET_HASH,
      );
      this.hooks.log('warn', `跳过 AI 评分（${quality.verdict}）：${quality.reasons[0] ?? '图片质量不合格'}`);
      return { kind: 'grade', ok: true, grade: blocked.result as GradeResult };
    }

    try {
      const out = await gradeQuestion(
        aiCfg,
        {
          questionText: cfg.question.stem,
          fullScore: cfg.question.fullScore,
          referenceAnswer: cfg.question.referenceAnswer,
          scoringPoints: cfg.question.scoringPoints,
          /*
           * answerText 留空：本版本**没有接入 OCR**，学生答案由视觉
           * 模型直接从截图读取。留空会让提示词里的"【学生答案】"显示
           * "（学生未作答）"——这是**已知的表达不准**处，由图片补足。
           * 不要在这里塞占位文本冒充 OCR 结果。
           *
           * 没有 OCR 就没有"识别置信度"可查，所以清晰度判断改由
           * page/quality.ts 的质量闸门承担，而且是在**送图之前**
           * 判（见本文件 captureQuestion 与 grade 的两处闸门）。
           * 将来真接入 OCR 时，应在 quality.ts 里增加一条 checks.ocr，
           * 而不是另起一套口径。
           */
          answerText: '',
          ...(cfg.question.subject ? { subject: cfg.question.subject } : {}),
        },
        { images },
      );
      addUsage(out.usage);
      if (!out.ok || !out.result) {
        return { kind: 'grade', ok: false, error: out.diag?.errorCode ?? 'AI 评分失败' };
      }
      /*
       * 质量已通过，但仍走一次 gradeYield：它同时负责
       * 「图合格却没有结果」这个不该出现的组合（返回需复核的 0 分，
       * 而不是静默返回假分或抛异常中止整轮）。
       */
      const y = gradeYield(quality, out.result, this.paperIdForQuality(), cfg.question.fullScore, PROMPT_SET_HASH);
      if (y.poorImage) {
        this.hooks.log('warn', '图片质量与评分结果不一致，已转为待复核。');
      }
      return { kind: 'grade', ok: true, grade: y.result as GradeResult };
    } catch (err) {
      return { kind: 'grade', ok: false, error: (err as Error)?.message ?? String(err) };
    }
  }

  /** 质量说明里用的卷子标识（状态机提交后会清空 submissionId，故留兜底） */
  private paperIdForQuality(): string {
    return this.state.submissionId || this.state.lastSubmittedId || '(未识别卷号)';
  }

  private async awaitConfirmStep(reason: string): Promise<AutoStepResult> {
    this.hooks.awaitConfirm({
      score: Number(this.state.lastScore ?? 0),
      comment: this.state.lastComment,
    });
    this.hooks.log('info', `${reason} 等待老师确认…`);
    const ok = await new Promise<boolean>((resolve) => {
      this.confirmResolve = resolve;
    });
    return { kind: 'confirm', ok };
  }

  /**
   * 填分：`nextFillStep`（纯逻辑，37 项单测）驱动，本函数只管 await。
   *
   * 严格照 FillAction 执行，不自己加减动作：
   *  - `click`     点分数框聚焦（先聚焦是必须的，受信任输入要打到焦点元素上）
   *  - `selectAll` 全选旧值（不清空会变成 "6.56.5" 这类拼接）
   *  - `insert`    用 Input.insertText 写入（不能用 el.value =，受控组件不认）
   *  - `read`      回读
   *  - `success`/`fail`  终态，带原因
   */
  private async fillScore(score: string, x: number, y: number): Promise<AutoStepResult> {
    const session = this.browser.session();
    const pick = this.browser.picks().scoreInput;
    if (!session || !pick) {
      const st = initialFillState(score, { x, y });
      return {
        kind: 'fillScore',
        state: {
          ...st,
          phase: 'gaveUp',
          lastCheck: { verdict: 'unreadable', expected: score, actual: null, message: '阅卷窗口或分数框拾取缺失' },
        },
      };
    }

    const cfg = this.state.cfg;
    // 元素模式用 write（写），坐标模式用 text（打字）：坐标模式通常落在
    // 无法用选择器定位的元素上，逐字打字更接近人工输入
    // 'insert' = Input.insertText 一次写入（受控组件需要它）；
    // 'type'   = 逐字打字，用于坐标模式（通常落在无法用选择器定位的元素上）
    const write: 'insert' | 'type' = pick.mode === 'element' ? 'insert' : 'type';
    let fill = initialFillState(score, { x, y, write });
    let pending: FillCheck | undefined;

    for (let guard = 0; guard < 64; guard++) {
      const { action, next } = nextFillStep(fill, pending);
      fill = next;
      pending = undefined;

      switch (action.kind) {
        case 'click':
          await session.clickAtTop(action.x, action.y);
          break;
        case 'selectAll':
          await session.pressKey('a');
          break;
        case 'insert':
          await session.insertText(action.text);
          break;
        case 'type':
          await session.typeText(action.text, Math.max(10, Math.min(60, cfg.throttleMs)));
          break;
        case 'read': {
          // `read` 动作本身不带期望值（FillAction 里没有 text）：
          // 期望值就是这一轮要写入的分数，即 nextFillStep 维护的 fill.text。
          // 上一版写成 action.text 会编译报错——幸好 TS 抓住了。
          const actual = await this.readInputValue(pick);
          pending = verifyFilledValue(fill.text, actual);
          break;
        }
        case 'success':
        case 'fail':
          return { kind: 'fillScore', state: fill };
        default: {
          const never: never = action;
          return { kind: 'fillScore', state: { ...fill, phase: 'gaveUp', lastCheck: { verdict: 'unreadable', expected: score, actual: null, message: `未知动作 ${String(never)}` } } };
        }
      }
    }

    return {
      kind: 'fillScore',
      state: { ...fill, phase: 'gaveUp', lastCheck: fill.lastCheck ?? { verdict: 'unreadable', expected: score, actual: null, message: '填分循环超过 64 步仍未收敛' } },
    };
  }

  /**
   * 点提交。
   *
   * ⚠ 这里**没有**"回读确认提交成功"的能力：提交后平台会跳转，而跳转是否
   * 成功、是否被服务端接受，前端无法确知。所以判定只能是"点击已派发"。
   * 因此：
   *   · 状态机把"点击已派发"记为提交成功（自动提交模式下这是可达的上界）
   *   · 平台上是否真的记了分，**仍需老师抽查**，不要宣称"已确认提交成功"
   * 这个局限写在这里，是为了不让上层把它当成已验证的闭环。
   */
  private async submit(): Promise<AutoStepResult> {
    const session = this.browser.session();
    const pick = this.browser.picks().submitButton;
    if (!session || !pick) return { kind: 'submit', ok: false, error: 'PICK_MISSING 提交按钮未拾取' };
    try {
      await session.clickAtTop(pick.topX, pick.topY);
      return { kind: 'submit', ok: true };
    } catch (err) {
      return { kind: 'submit', ok: false, error: (err as Error)?.message ?? String(err) };
    }
  }
}

/** 供日志使用的错误分类便捷入口（薄绑定里也统一走 classifError，避免自造文本） */
export function describeError(raw: string): string {
  const c = classifyError(raw);
  return `${c.message}（${c.kind}）${c.action}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 供测试断言用：导出 fill 动作的执行顺序说明 */
export type { FillAction, FillState };