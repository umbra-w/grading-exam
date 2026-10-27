/*
 * ══════════════════════════════════════════════════════════════════════════
 *  图片质量闸门（纯逻辑）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 解决一个很具体的浪费：**图看不清的时候，模型不会说"我看不清"，
 * 它会编一个分**。而且我们付了钱。
 *
 * 闸门有两个作用，缺一不可：
 *   1. 把"根本不该送去评分的图"拦在 API 调用之前——省钱，且不产生假分
 *   2. 把"勉强能看但不可靠的图"标记出来，结果走复核队列而不是自动填分
 *
 * ── 为什么尺寸判定必须按**逻辑像素**而不是截图像素 ────────────────────
 *
 * 高 DPI 屏上截图的实际像素会翻倍甚至三倍（2 倍屏 → 像素数 4 倍）。
 * 若直接拿像素数判定，一个只有 300 逻辑像素宽、老师肉眼都嫌小的
 * 题目区域，会被判成"尺寸充足"，然后送去评分。这是本模块最容易
 * 写错的一处，所以 `devicePixelRatio` 是**必填参数**而不是可选。
 *
 * ── 关于 OCR：本版本**没有接入 OCR** ────────────────────────────────────
 *
 * 学生答案由视觉模型直接从截图读取（`gradeQuestion` 的 images 参数），
 * `answerText` 留空。这个闸门因此替代了 OCR 质量检测的生态位：
 * 与其"识别失败再报错"，不如**在送图之前就判断这张图能不能看清**。
 *
 * 将来真接入 OCR 时，这里应当只增加一条 `checks.ocr`，
 * 而不是把判定逻辑搬去 OCR 侧——否则口径会分叉成两处。
 *
 * ── 阈值是未标定的经验值 ────────────────────────────────────────────────
 *
 * 与 `0.75` 置信度阈值同性质：**未经真实平台截图样本标定**
 * （BLOCKERS.md 的教师资源与平台账号依赖）。改阈值请只改这里的常量，
 * 不要在调用方另写一套。
 */

/** 题目区域的长边至少要有这么多**逻辑**像素，否则文字必然不可辨 */
export const MIN_LONGEST_EDGE = 400;

/** 低于此值判 `marginal`（能看但不可靠，建议复核） */
export const MARGINAL_LONGEST_EDGE = 560;

/** 长宽比超过这个值怀疑拾取框选歪了（题目区域不会这么细长） */
export const MAX_ASPECT_RATIO = 12;

/**
 * 压缩后字节数 / 像素数 低于此值，怀疑截图几乎全是空白。
 *
 * 依据：PNG 对均匀色块压缩率极高。一张 1200×500 的正常题目截图
 * （有文字、有线条）通常在几十到几百 KB；而同样尺寸的纯白/纯色图
 * 会压到几 KB。所以"像素多而字节少"是强信号。
 *
 * ⚠ 这是**启发式**，不是像素级空白检测。真要做准确判定得解码位图，
 * 代价大且本模块必须保持纯函数。启发式的失败方向是"多送一次评分"，
 * 可以接受；反过来（把正常图误判成空白）才是问题，所以阈值取得很保守。
 */
export const MIN_BYTES_PER_PIXEL = 0.02;

import { PROMPT_VERSION } from '../ai/prompts';

export type QualityVerdict =
  | 'ok'
  /** 逻辑尺寸不足，文字不可辨——**不该送去评分** */
  | 'too_small'
  /** 截图几乎空白 */
  | 'mostly_blank'
  /** 长宽比异常，多半拾取框选歪了 */
  | 'aspect_suspect'
  /** 能看但偏小，可评分但建议复核 */
  | 'marginal'
  /** 拿不到尺寸信息，无从判断——按"必须复核"处理 */
  | 'insufficient';

/**
 * 哪些判定必须人工复核（不可自动采信）。
 *
 * ⚠ 这是**唯一真源**：`classifyImageQuality` 用它算 `mustReview`，
 * `gradeYield` 也用它决定"要不要拒绝给分"。
 *
 * 为什么不复用报告里的 `mustReview` 字段：那两个字段由不同代码路径产生，
 * 可能不同步（测试里就构造出过 verdict='too_small' 而 mustReview=false
 * 的矛盾对象）。此时若下游信任字段，看不清的卷子就会被放行——
 * 正是这个闸门要防的事。所以下游一律从 verdict 自己算。
 */
export const MUST_REVIEW_VERDICTS: ReadonlySet<QualityVerdict> = new Set<QualityVerdict>([
  'too_small',
  'mostly_blank',
  'aspect_suspect',
  'insufficient',
]);

export interface QualityInput {
  /** 截图实际像素宽；null = 拿不到 */
  width: number | null;
  /** 截图实际像素高；null = 拿不到 */
  height: number | null;
  /** 截图时的设备像素比。必填——见文件头"为什么必须按逻辑像素判定" */
  devicePixelRatio: number;
  /** 编码后的字节数。不给则跳过空白判定（不猜） */
  encodedBytes?: number;
}

/** 每项检查的三态：通过 / 不通过 / **没测**（绝不把"没测"混进"通过"） */
export type CheckState = 'pass' | 'fail' | 'not_measured';

export interface QualityReport {
  verdict: QualityVerdict;
  /** 必须复核才能采信（不可自动填分） */
  mustReview: boolean;
  /** 建议复核（含 mustReview 的情况） */
  shouldReview: boolean;
  /** 归一化后的 DPR（非法值按 1 处理） */
  devicePixelRatio: number;
  /** 逻辑像素尺寸；拿不到时为 null */
  effectiveWidth: number | null;
  effectiveHeight: number | null;
  /** 实际截图长边（像素） */
  longestEdge: number | null;
  checks: {
    size: CheckState;
    blank: CheckState;
    aspect: CheckState;
  };
  /** 判定依据，逐条可读 */
  reasons: string[];
  /** 处置建议——要指向"怎么办"，不是复述"哪里坏了" */
  advice: string[];
}

/**
 * 从 PNG 字节流里读尺寸。
 *
 * 只读 IHDR，不解码位图：本模块必须保持纯函数、零依赖。
 * 不是合法 PNG、或数据不够长，一律返回 null —— **不猜尺寸**。
 * 猜出来的尺寸会让后续判定基于一个编造的数字，比直接拒判更危险。
 */
export function parsePngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== SIG[i]) return null;
  }
  // 偏移 12 起是 chunk 类型，必须是 'IHDR'
  if (!(bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52)) {
    return null;
  }
  const width = ((bytes[16]! << 24) | (bytes[17]! << 16) | (bytes[18]! << 8) | bytes[19]!) >>> 0;
  const height = ((bytes[20]! << 24) | (bytes[21]! << 16) | (bytes[22]! << 8) | bytes[23]!) >>> 0;
  if (width === 0 || height === 0) return null;
  return { width, height };
}

/** 把非法的 DPR 归一成 1——不让它把整条判定链带偏 */
function normalizeDpr(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return raw;
}

export function classifyImageQuality(input: QualityInput): QualityReport {
  const dpr = normalizeDpr(input.devicePixelRatio);
  const reasons: string[] = [];
  const advice: string[] = [];

  const hasSize =
    typeof input.width === 'number' &&
    typeof input.height === 'number' &&
    Number.isFinite(input.width) &&
    Number.isFinite(input.height) &&
    input.width > 0 &&
    input.height > 0;

  if (!hasSize) {
    /*
     * 拿不到尺寸 → `insufficient`，**必须复核**。
     *
     * 关键纪律（§6.3 同源）：「没测过」不等于「测过且通过」。
     * 如果这里放行，闸门就变成了"测不出来时一律通过"，
     * 那比没有闸门更糟——它会给出一个"已检查"的假象。
     */
    reasons.push('拿不到截图尺寸，无法判断题目区域是否清晰');
    advice.push('检查题目区域拾取是否仍然有效（页面可能已跳转或改版），重新拾取后再试。');
    return {
      verdict: 'insufficient',
      mustReview: true,
      shouldReview: true,
      devicePixelRatio: dpr,
      effectiveWidth: null,
      effectiveHeight: null,
      longestEdge: null,
      checks: { size: 'not_measured', blank: 'not_measured', aspect: 'not_measured' },
      reasons,
      advice,
    };
  }

  const width = input.width!;
  const height = input.height!;
  const effectiveWidth = Math.round(width / dpr);
  const effectiveHeight = Math.round(height / dpr);
  const longestEdge = Math.max(width, height);
  const effectiveLongest = Math.max(effectiveWidth, effectiveHeight);
  const aspect = Math.max(width, height) / Math.min(width, height);

  // ── 1) 尺寸：按逻辑像素判，不是截图像素
  const sizeState: CheckState = effectiveLongest < MIN_LONGEST_EDGE ? 'fail' : 'pass';
  if (effectiveLongest < MIN_LONGEST_EDGE) {
    reasons.push(
      `题目区域逻辑尺寸仅 ${effectiveWidth}×${effectiveHeight}（长边 ${effectiveLongest}，下限 ${MIN_LONGEST_EDGE}），文字无法辨认`,
    );
    advice.push('框选时把整个题干与作答区域都包含进去；若平台本身缩放太小，先在页面上放大再拾取。');
  }

  // ── 2) 空白：只在给了字节数时才判
  let blankState: CheckState = 'not_measured';
  if (typeof input.encodedBytes === 'number' && Number.isFinite(input.encodedBytes)) {
    const bytesPerPixel = input.encodedBytes / (width * height);
    if (bytesPerPixel < MIN_BYTES_PER_PIXEL) {
      blankState = 'fail';
      reasons.push(
        `截图压缩后仅 ${Math.round(input.encodedBytes / 1024)} KB（${bytesPerPixel.toFixed(4)} 字节/像素，低于 ${MIN_BYTES_PER_PIXEL}），内容几乎为空白`,
      );
      advice.push('确认页面已加载完成、题目区域不是空白占位；必要时滚动到题目可见位置后再截图。');
    } else {
      blankState = 'pass';
    }
  }

  // ── 3) 长宽比：拾取框选歪了的强信号
  const aspectState: CheckState = aspect > MAX_ASPECT_RATIO ? 'fail' : 'pass';
  if (aspect > MAX_ASPECT_RATIO) {
    reasons.push(`长宽比 ${aspect.toFixed(1)}:1 异常（上限 ${MAX_ASPECT_RATIO}:1），多半框选偏了`);
    advice.push('重新拾取题目区域，确保框选的是完整题目而不是一条边或一行。');
  }

  /*
   * 判定优先级：**先报更根本的问题**。
   *
   * 一条 120×20 的框同时"太小"和"太细长"，但真正的原因是图太小——
   * 若报 aspect_suspect，人会去修长宽比，而问题根本不在那。
   * 所以 too_small 优先于 aspect_suspect。
   */
  let verdict: QualityVerdict;
  if (sizeState === 'fail') {
    verdict = 'too_small';
  } else if (blankState === 'fail') {
    verdict = 'mostly_blank';
  } else if (aspectState === 'fail') {
    verdict = 'aspect_suspect';
  } else if (effectiveLongest < MARGINAL_LONGEST_EDGE) {
    verdict = 'marginal';
    reasons.push(`尺寸偏小（长边 ${effectiveLongest}，建议 ${MARGINAL_LONGEST_EDGE} 以上），可以评分但结果不够可靠`);
    // 刻意给的建议与上面"太小"不同：这里是"可以继续但要盯着"，不是"别送"
    advice.push('可以继续评分，但建议把这份放进复核队列再看一眼，不要直接采信。');
  } else {
    verdict = 'ok';
  }

  const mustReview = MUST_REVIEW_VERDICTS.has(verdict);

  return {
    verdict,
    mustReview,
    // shouldReview 覆盖 mustReview：强制复核的必然也"建议复核"（单调性）
    shouldReview: mustReview || verdict === 'marginal',
    devicePixelRatio: dpr,
    effectiveWidth,
    effectiveHeight,
    longestEdge,
    checks: { size: sizeState, blank: blankState, aspect: aspectState },
    reasons,
    advice,
  };
}

/** 给日志/界面用的一句话摘要 */
export function describeQuality(r: QualityReport): string {
  if (r.verdict === 'ok') return '图片质量检查通过';
  const head = r.reasons[0] ?? '未通过';
  return `图片质量${r.mustReview ? '不合格（必须复核）' : '偏低'}：${head}`;
}

/* ══════════════════════════════════════════════════════════════════════════
 *  闸门 → 评分结果
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 为什么需要这一层，而不是让适配器自己判断"图坏了该怎么办"：
 *
 * 下游的复核队列（`ai/review.ts`）只接受 `GradeResult`，
 * 它的 `poor_image` 理由由 `ReviewSignals.poorImage` 驱动
 * ——两者**早就存在**，只是此前没有东西去产生它们。
 * 所以闸门的正确接法不是"新增一种状态机动作"（那要动已冻结的
 * 状态机契约），而是**产出一份显式的"不可评分"结果**，让它
 * 顺着已有的复核管道走。
 *
 * 这段映射决定"看不清楚的卷子会不会被静默打 0 分"，属于 §6.1 那类
 * 静默失败的高危处，因此必须留在纯模块里可测，不能写在适配器里。
 */

/** 只读的评分结果子集：够本模块用，也避免与 client/ensemble 循环依赖 */
export interface GradeLike {
  score: number;
  comment: string;
  confidence: number;
  hitPoints?: string[];
  missedPoints?: string[];
  reviewRequested?: boolean;
  /** 不可省略：本模块产出的结果**必须**带上质量原因，否则查不出为什么没评分 */
  warnings: string[];
  /** 结果指纹，入复核队列必须可回溯。同样是必需的 */
  promptVersion: string;
  promptHash: string;
  /** 见 shared/types.ts 的说明："没有被评分"而不是"学生得了 0 分" */
  ungradable?: boolean;
  ensemble?: unknown;
}

export interface GradeYield {
  /** 最终应被采信的结果 */
  result: GradeLike;
  /** 是否应作为"图片质量差"入复核队列（清单：mustReview 的那几档） */
  poorImage: boolean;
  /** 本次评分调用本不该发生（图不可用）。仅用于日志与统计 */
  blockedApiCall: boolean;
}

/**
 * 把"不可评分的图片"变成一份显式结果。
 *
 * 关键取舍：**不假装做过评分**。
 * `hitPoints` / `missedPoints` 一律为空数组，而不是编造几个要点——
 * 界面若显示"命中了某点"，就等于捏造了评分过程，比给 0 分更糟。
 * `comment` 里必须带上处置建议，因为老师需要的是"怎么办"。
 */
export function ungradableResult(
  report: QualityReport,
  /** 卷子标识（卷子指纹）。写进 comment 便于从日志直接定位是哪一份 */
  paperId: string,
  /** 满分。入复核队列入队时要快照满分，避免之后取不到 */
  fullScore: number,
  promptHash: string,
): GradeLike {
  const reasons = report.reasons.length > 0 ? report.reasons : ['图片质量检查未通过（未给出具体原因）'];
  const advice = report.advice.length > 0 ? report.advice : ['请重新拾取题目区域后重试。'];
  return {
    // 0 分不是"学生得了 0 分"，而是"这份卷子没有被评分"。
    // 两者在数据上无法区分，所以必须靠 reviewRequested + confidence 0
    // + warnings 三者共同表达，缺一个就会被误读成真实得分。
    score: 0,
    comment: `未评分（${paperId}，满分 ${fullScore}）：${reasons.join('；')}。建议：${advice.join('；')}`,
    hitPoints: [],
    missedPoints: [],
    confidence: 0,
    reviewRequested: true,
    warnings: reasons,
    // ⚠ 提示词版本与哈希必须是真的：入复核队列的结果要可回溯。
    // 这里刻意没有任何默认值——传空的指纹等于让这条记录无法归因。
    promptVersion: PROMPT_VERSION,
    promptHash,
    ungradable: true,
  };
}

/**
 * 闸门与评分结果的汇合点。
 *
 * @param report    质量报告
 * @param grade     真实评分结果（`blockedApiCall` 路径下为 undefined）
 * @param paperId   卷子标识，写进不可评分结果的说明里
 * @param fullScore 满分
 * @param promptHash 提示词集合指纹
 */
export function gradeYield(
  report: QualityReport,
  grade: GradeLike | undefined,
  paperId: string,
  fullScore: number,
  promptHash: string,
): GradeYield {
  /*
   * 只有 `mustReview` 那几档才拒绝给分。
   *
   * `marginal`（尺寸偏小但能看）刻意**不**拒绝：它的问题是"不够可靠"，
   * 不是"看不清"，处置是"仍输出模型分但要求复核"。
   * 把两者合并会损失一个有价值的区分——前者可以自信地报分，
   * 后者必须拒绝报分，混在一起就只能按最保守的那个来。
   */
  // 从 verdict 自己算，不用 report.mustReview —— 见 MUST_REVIEW_VERDICTS 的注释
  const unusable = MUST_REVIEW_VERDICTS.has(report.verdict);

  if (unusable) {
    return {
      result: ungradableResult(report, paperId, fullScore, promptHash),
      poorImage: true,
      blockedApiCall: true,
    };
  }

  if (!grade) {
    /*
     * 不该出现的组合：图合格却没有评分结果。
     *
     * 不能静默返回一个假分（那是最坏的选择），也不能抛异常
     * （会让整轮阅卷中止）。如实报成"需要复核的 0 分"——
     * 与图不可用的处置一致，因为对老师来说"这份没评上，请看"
     * 这个信息本身就是准确的。
     */
    return {
      result: ungradableResult(
        {
          ...report,
          reasons: [...report.reasons, '评分流程未产出结果（图质量合格，问题在评分环节）'],
          advice: [...report.advice, '检查 AI 配置与网络；持续出现请看日志中的错误码。'],
        },
        paperId,
        fullScore,
        promptHash,
      ),
      poorImage: true,
      blockedApiCall: true,
    };
  }

  return { result: grade, poorImage: false, blockedApiCall: false };
}