/**
 * AI 客户端 —— Phase 1 的核心。
 *
 * 分层：
 *   compat.ts  纯函数：请求体构造、响应抽取、诊断、归一化（无 I/O，可单测）
 *   client.ts  带 I/O：发请求、超时、重试、JSON 清洗、用量记账
 *
 * 本文件最重要的部分是 **sanitizeGradeResult**，理由：
 * 模型偶尔会返回坏 JSON、越界分数、缺字段。若直接把模型说的分数当结果，
 * 就会出现"AI 给了 8 分而满分是 6 分"这类静默错误——这在阅卷场景里比崩溃更糟。
 * 所以：**任何进入系统的分数都必须先过清洗**。
 */
import { randomUUID } from 'node:crypto';
import type {
  AICallResult,
  AIConfig,
  ChatMessage,
  ExtractedRubric,
  GradeResult,
  ImagePart,
  QuestionType,
  TokenUsage,
  PaperState,
} from '../../shared/types';
import { verifyMathIntegrity } from './math-integrity';
import {
  DEFAULT_ENSEMBLE,
  judgeEnsemble,
  mergeEnsemble,
  temperatureForRun,
  type EnsembleOptions,
  type EnsembleVerdict,
} from './ensemble';
import {
  DEFAULT_MAX_TOKENS, buildRequestBody, diagnoseEmpty, extractContent, modelSupportsVision } from './compat';
import {
  LOW_CONFIDENCE_THRESHOLD,
  PROMPT_VERSION,
  PROMPT_SET_HASH,
  GRADING_SYSTEM,
  buildGradePrompt,
  buildParsePaperPrompt,
  buildPingPrompt,
  buildVisionAnswersPrompt,
  buildExtractRubricPrompt,
  buildOptimizeCriteriaPrompt,
  type GradePromptInput,
} from './prompts';

export const EMPTY_USAGE: TokenUsage = { prompt: 0, completion: 0, total: 0, costCNY: 0 };

// GradeResult 定义在 shared/types.ts —— 渲染层要直接渲染它，属跨进程契约。

export interface CallOptions {
  json?: boolean;
  timeoutMs?: number;
  /** 网络类失败的重试次数（4xx 不重试） */
  retries?: number;
  signal?: AbortSignal;
  /** 覆盖本次请求的采样温度（多次运行分歧度需要每次不同温度） */
  temperature?: number;
}

/* ------------------------------------------------------------ 底层调用 */

/**
 * 发一次 chat completion 请求。
 * 不在 HTTP 层抛异常——所有失败都编码进 AICallResult，让调用方统一处理，
 * 因为「AI 调用失败」在本应用里是**常规情形**（限额、断网、模型不支持图片），
 * 不是异常。若为它写 try/catch 到处兜，代码会很难读。
 */
export async function callAI(
  cfg: AIConfig,
  messages: ChatMessage[],
  opts: CallOptions = {},
): Promise<AICallResult> {
  const timeoutMs = opts.timeoutMs ?? (cfg.timeoutMs > 0 ? cfg.timeoutMs : 60_000);
  const retries = Math.max(0, opts.retries ?? 2);

  // 视觉前置校验：含图 + 非视觉模型 ⇒ 请求前就报错，而不是等一个必然为空的响应
  const hasImage = messages.some((m) => (m.images?.length ?? 0) > 0);
  if (hasImage && !modelSupportsVision(cfg.model)) {
    return {
      ok: false,
      text: '',
      usage: { ...EMPTY_USAGE },
      diag: {
        model: cfg.model,
        errorCode: 'VISION_UNSUPPORTED',
        rawSnippet: `模型 ${cfg.model} 不在视觉模型白名单内，无法处理图片输入。请在设置中改用支持视觉的模型。`,
      },
    };
  }

  if (!cfg.apiKey?.trim()) {
    return {
      ok: false,
      text: '',
      usage: { ...EMPTY_USAGE },
      diag: { model: cfg.model, errorCode: 'NO_API_KEY', rawSnippet: '未填写 API Key。' },
    };
  }

  const body = buildRequestBody(cfg, messages, {
    json: opts.json ?? false,
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
  });
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  let last: AICallResult | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = (): void => controller.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const httpStatus = res.status;
      const rawText = await res.text();

      if (!res.ok) {
        const diag = safeJson(rawText);
        const errMsg = (diag as { error?: { message?: string } })?.error?.message;
        last = {
          ok: false,
          text: '',
          usage: { ...EMPTY_USAGE },
          diag: {
            model: cfg.model,
            httpStatus,
            errorCode: `HTTP_${httpStatus}`,
            rawSnippet: errMsg || rawText.slice(0, 400),
          },
        };
        // 4xx 是配置/权限问题，重试无意义
        if (httpStatus >= 400 && httpStatus < 500) return last;
        continue;
      }

      const json = safeJson(rawText);
      const extracted = extractContent(json);

      if (!extracted.text) {
        last = {
          ok: false,
          text: '',
          usage: extractUsage(json),
          diag: {
            model: cfg.model,
            httpStatus,
            finishReason: extracted.finishReason,
            errorCode: 'EMPTY_CONTENT',
            rawSnippet: diagnoseEmpty(extracted, httpStatus),
            thinkingDisabled: shouldReportThinking(cfg),
          },
        };
        continue; // 空响应值得重试
      }

      return {
        ok: true,
        text: extracted.text,
        usage: extractUsage(json),
        diag: {
          model: cfg.model,
          httpStatus,
          finishReason: extracted.finishReason,
          usedReasoningFallback: extracted.usedReasoningFallback,
          thinkingDisabled: shouldReportThinking(cfg),
          rawSnippet: extracted.usedReasoningFallback
            ? '正文为空，已回退读取思考字段（reasoning_content）。'
            : undefined,
        },
      };
    } catch (err) {
      const isAbort = (err as { name?: string })?.name === 'AbortError';
      last = {
        ok: false,
        text: '',
        usage: { ...EMPTY_USAGE },
        diag: {
          model: cfg.model,
          errorCode: isAbort ? 'TIMEOUT' : 'NETWORK_ERROR',
          rawSnippet: isAbort
            ? `请求超时（${timeoutMs} ms）。已重试 ${attempt} 次。`
            : `网络请求失败：${(err as Error)?.message ?? String(err)}。已重试 ${attempt} 次。`,
        },
      };
      // 调用方主动取消，不重试
      if (opts.signal?.aborted) return last;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  return last ?? {
    ok: false,
    text: '',
    usage: { ...EMPTY_USAGE },
    diag: { model: cfg.model, errorCode: 'UNKNOWN', rawSnippet: '未发起任何请求。' },
  };
}

function shouldReportThinking(cfg: AIConfig): boolean {
  return cfg.disableThinking === true;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** 从响应里取 token 用量；不同商家字段名略有差异，做兼容 */
function extractUsage(json: unknown): TokenUsage {
  const u = (json as { usage?: Record<string, unknown> })?.usage ?? {};
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const prompt = num(u.prompt_tokens) || num(u.input_tokens);
  const completion = num(u.completion_tokens) || num(u.output_tokens);
  const total = num(u.total_tokens) || prompt + completion;
  return { prompt, completion, total, costCNY: 0 };
}

/* ------------------------------------------------------------ JSON 清洗 */

/**
 * 从模型输出里宽松地取出 JSON 对象。
 * 三种策略依次尝试，覆盖真实见过的三种脏输出：
 *   1. 纯 JSON（理想情况）
 *   2. 被 ``` 或 ```json 包裹（很常见）
 *   3. 前后有解释性文字（"好的，以下是结果：{...}"）
 */
export function parseJsonLoose(text: string): { value: unknown; strategy: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    return { value: JSON.parse(trimmed), strategy: 'direct' };
  } catch {
    /* 继续 */
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return { value: JSON.parse(fenced[1].trim()), strategy: 'fenced' };
    } catch {
      /* 继续 */
    }
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return { value: JSON.parse(trimmed.slice(start, end + 1)), strategy: 'bracketed' };
    } catch {
      /* 继续 */
    }
  }

  return null;
}

function asString(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map(asString).filter((s) => s.length > 0);
  }
  if (typeof v === 'string' && v.trim()) {
    // 模型有时把要点写成一段用分号/换行分隔的文字
    return v
      .split(/[;\n；]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const cleaned = v.replace(/[^\d.\-]/g, '');
    // ★ 必须至少含一个数字字符。
    //   否则 'abc' 清洗后变空串，而 Number('') === 0 ——
    //   那会把「模型返回了非数字分数」静默记成 0 分：学生明明答了，系统给 0。
    //   这是最危险的一类静默错误，必须显式拒绝。
    if (!/\d/.test(cleaned)) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 按 0.5 分粒度吸附，避免出现 5.3 这种不符合阅卷惯例的分数 */
export function snapToGranularity(score: number, granularity = 0.5): number {
  if (granularity <= 0) return score;
  return Math.round(score / granularity) * granularity;
}

/**
 * 清洗模型的评分输出 —— 拦住所有"静默错误"。
 *
 * 拦截清单：
 *   - JSON 解析失败            → 返回 null，由调用方判为失败（**绝不猜分数**）
 *   - 缺少 score               → 同上
 *   - score 非数字 / NaN / Infinity → 同上
 *   - score 越界               → 夹到 [0, fullScore] 并记警告
 *   - score 不是 0.5 的整数倍   → 吸附到 0.5 并记警告
 *   - confidence 缺失/越界     → 默认保守值 0.5 并记警告（**默认低，不默认高**）
 *   - confidence < 阈值        → 强制 reviewRequested = true（不论模型怎么说）
 *   - hitPoints/missedPoints 非数组 → 尽力转换
 */
export function sanitizeGradeResult(raw: unknown, fullScore: number): GradeResult | null {
  const warnings: string[] = [];
  const obj = raw as Record<string, unknown> | null;
  if (!obj || typeof obj !== 'object') return null;

  // 1. 提取试卷四状态 (正常/空白/任务完成/错位)
  let paperState: PaperState = 'normal';
  const rawState = asString(obj.paperState || obj['试卷状态']).toLowerCase();
  if (rawState.includes('blank') || rawState.includes('空白')) {
    paperState = 'blank';
  } else if (rawState.includes('finish') || rawState.includes('完成') || rawState.includes('结束')) {
    paperState = 'task_finished';
    warnings.push('检测到平台阅卷已完成指示图');
  } else if (rawState.includes('mismatch') || rawState.includes('错位') || rawState.includes('其他题目')) {
    paperState = 'mismatched';
    warnings.push('检测到疑似错位答卷或答非所问，强制置入复核队列');
  }

  const rawScore = asNumber(obj.score);
  if (rawScore === null) {
    // 特殊状态下允许没有显式分数时按 0 处理
    if (paperState === 'blank' || paperState === 'task_finished' || paperState === 'mismatched') {
      // 允许继续按 0 分结算
    } else {
      return null; // 没有可用分数且不是特殊状态，一律判失败
    }
  }

  let score = rawScore ?? 0;
  if (paperState === 'blank' || paperState === 'task_finished' || paperState === 'mismatched') {
    score = 0;
  }

  if (score < 0) {
    warnings.push(`模型给出负分 ${score}，已夹到 0`);
    score = 0;
  }
  if (score > fullScore) {
    warnings.push(`模型给出 ${score} 分，超过满分 ${fullScore}，已夹到满分`);
    score = fullScore;
  }

  const snapped = snapToGranularity(score);
  if (Math.abs(snapped - score) > 1e-9) {
    warnings.push(`分数 ${score} 非 0.5 的整数倍，已吸附为 ${snapped}`);
    score = snapped;
  }

  let confidence = asNumber(obj.confidence);
  if (confidence === null) {
    // 默认保守：宁可多复核，不可少复核
    warnings.push('模型未返回 confidence，按保守值 0.5 处理并强制复核');
    confidence = 0.5;
  }
  if (confidence > 1) {
    if (confidence <= 100) {
      warnings.push(`confidence=${confidence} 疑似百分制，已归一化为 ${(confidence / 100).toFixed(2)}`);
      confidence = confidence / 100;
    } else {
      warnings.push(`confidence=${confidence} 超出 [0,1]，按保守值 0.5 处理`);
      confidence = 0.5;
    }
  }
  if (confidence < 0) {
    warnings.push(`confidence=${confidence} 为负，按保守值 0 处理`);
    confidence = 0;
  }

  let reviewRequested = obj.reviewRequested === true;
  if (paperState === 'mismatched') {
    confidence = Math.min(confidence, 0.3);
    reviewRequested = true;
  } else if (paperState === 'task_finished') {
    reviewRequested = false;
  } else if (paperState === 'blank') {
    reviewRequested = false;
  }

  // 2. 四则运算对账 (sizhejisuan)
  let subScores: number[] | undefined;
  if (Array.isArray(obj.subScores)) {
    subScores = obj.subScores.map((v) => asNumber(v) ?? 0);
  }
  const mathExpression = asString(obj.mathExpression || obj['分数计算']);
  const mathIntegrity = verifyMathIntegrity({
    score,
    subScores,
    mathExpression: mathExpression || undefined,
  });

  if (!mathIntegrity.ok && mathIntegrity.reason && paperState === 'normal') {
    warnings.push(`[算术对账] ${mathIntegrity.reason}`);
    confidence = Math.min(confidence, 0.6);
    reviewRequested = true;
  }

  if (confidence < LOW_CONFIDENCE_THRESHOLD && !reviewRequested && paperState !== 'task_finished' && paperState !== 'blank') {
    warnings.push(
      `confidence=${confidence.toFixed(3)} 低于阈值 ${LOW_CONFIDENCE_THRESHOLD}，已强制置 reviewRequested=true`,
    );
    reviewRequested = true;
  }

  const comment = asString(obj.comment) || (paperState === 'blank' ? '学生未作答（空白卷）' : (paperState === 'mismatched' ? '答非所问/疑似错位答卷' : ''));

  return {
    score,
    comment,
    hitPoints: asStringArray(obj.hitPoints),
    missedPoints: asStringArray(obj.missedPoints),
    confidence,
    reviewRequested,
    warnings,
    paperState,
    subScores,
    mathExpression: mathExpression || undefined,
    mathIntegrity,
    promptVersion: PROMPT_VERSION,
    promptHash: PROMPT_SET_HASH,
  };
}

/* ------------------------------------------------------------ 业务封装 */

export interface GradeOutcome {
  ok: boolean;
  result: GradeResult | null;
  usage: TokenUsage;
  diag: AICallResult['diag'];
  /** 原始响应文本，便于人工核对与失败案例库 */
  rawText: string;
}

/** 单题评分：组装提示 → 调用 → 清洗 */
export async function gradeQuestion(
  cfg: AIConfig,
  input: GradePromptInput,
  opts: { images?: ImagePart[]; signal?: AbortSignal; temperature?: number } = {},
): Promise<GradeOutcome> {
  const messages: ChatMessage[] = [
    { role: 'system', content: GRADING_SYSTEM },
    { role: 'user', content: buildGradePrompt(input), images: opts.images },
  ];

  const call = await callAI(cfg, messages, {
    json: true,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
  });

  if (!call.ok) {
    return { ok: false, result: null, usage: call.usage, diag: call.diag, rawText: call.text };
  }

  const parsed = parseJsonLoose(call.text);
  if (!parsed) {
    return {
      ok: false,
      result: null,
      usage: call.usage,
      diag: {
        ...call.diag,
        errorCode: 'BAD_JSON',
        rawSnippet: `模型返回的内容不是合法 JSON，已拒绝记分。原始片段：${call.text.slice(0, 200)}`,
      },
      rawText: call.text,
    };
  }

  const result = sanitizeGradeResult(parsed.value, input.fullScore);
  if (!result) {
    return {
      ok: false,
      result: null,
      usage: call.usage,
      diag: {
        ...call.diag,
        errorCode: 'MISSING_SCORE',
        rawSnippet: `模型 JSON 中缺少可用的 score 字段，已拒绝记分。原始片段：${call.text.slice(0, 200)}`,
      },
      rawText: call.text,
    };
  }

  if (parsed.strategy !== 'direct') {
    result.warnings.unshift(`JSON 经 ${parsed.strategy} 策略提取（模型未输出纯 JSON）`);
  }

  return { ok: true, result, usage: call.usage, diag: call.diag, rawText: call.text };
}

/**
 * 多次运行评分 —— 用自一致性（self-consistency）得到**真实**的不确定性信号。
 *
 * 为什么必须这么做：
 *   让模型自评 confidence 是弱信号（模型普遍过度自信，常吐固定值）。
 *   同一输入独立跑多次，结果散不散才是模型自身不确定性的可观测表现。
 *   领域里对 LLM 置信度估计有专门综述（arXiv:2311.08298），说明这是开放问题；
 *   而"自一致性 + 选择性人工复核"是有文献支撑的成熟做法。
 *
 * 成本控制（关键取舍）：
 *   **不是所有题都跑多次。** 调用方应先用单次评分，只在结果"可疑"时
 *   （边界分、低质量图、得分点不自洽）才追加多次 —— 这类约占 20~30%。
 *   多两次 API 调用（几厘钱）对比人工复核一次（几分钟），成本差两个数量级。
 *
 * 独立性保证：每次用**不同温度**采样。同一温度同一输入会退化成完全相同的
 * 请求，测不出任何分歧——那样这个机制就是装饰。
 *
 * 部分失败的处理：某次调用失败不整体失败，只要取得 ≥2 次有效结果就能判定；
 * 全部失败才返回失败。这与"单份失败只告警不中断"的全局纪律一致。
 */
export async function gradeQuestionMulti(
  cfg: AIConfig,
  input: GradePromptInput,
  opts: { images?: ImagePart[]; signal?: AbortSignal; ensemble?: EnsembleOptions } = {},
): Promise<GradeOutcome & { verdict?: EnsembleVerdict }> {
  const ensCfg = { ...DEFAULT_ENSEMBLE, ...opts.ensemble };
  const runs = Math.max(1, ensCfg.runs);

  const results: GradeResult[] = [];
  const usages: TokenUsage[] = [];
  const failures: string[] = [];
  let lastDiag: AICallResult['diag'] = { model: cfg.model };
  let lastText = '';

  for (let i = 0; i < runs; i++) {
    if (opts.signal?.aborted) {
      failures.push(`第 ${i + 1} 次运行被取消`);
      break;
    }

    const temperature = temperatureForRun(i, ensCfg.temperatures);
    const attempt = await gradeQuestion(cfg, input, {
      ...(opts.images ? { images: opts.images } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      temperature,
    });

    usages.push(attempt.usage);
    lastDiag = attempt.diag;
    lastText = attempt.rawText;

    if (attempt.ok && attempt.result) {
      results.push(attempt.result);
    } else {
      failures.push(`第 ${i + 1} 次运行失败：${attempt.diag.errorCode ?? '未知原因'}`);
    }
  }

  const totalUsage = sumUsage(usages);

  if (results.length === 0) {
    return {
      ok: false,
      result: null,
      usage: totalUsage,
      diag: { ...lastDiag, errorCode: lastDiag.errorCode ?? 'ALL_RUNS_FAILED', rawSnippet: failures.join('；') },
      rawText: lastText,
    };
  }

  const verdict = judgeEnsemble(results, input.fullScore, ensCfg);
  const merged = mergeEnsemble(results, verdict);

  if (failures.length > 0) {
    merged.warnings.unshift(...failures);
  }

  // 歧义点合并进清洗警告：这些是改提示词/rubric 的直接线索
  if (merged.ensemble && merged.ensemble.commonMisses.length > 0) {
    merged.warnings.push(
      `各次运行共同未命中的得分点：${merged.ensemble.commonMisses.join('、')}` +
        `（系统性盲区线索，非随机波动，建议检查该得分点表述或提示词）`,
    );
  }
  if (merged.ensemble && merged.ensemble.contradictoryPoints.length > 0) {
    merged.warnings.push(`各次运行判断矛盾的得分点：${merged.ensemble.contradictoryPoints.join('、')}`);
  }

  return {
    ok: true,
    result: merged,
    usage: totalUsage,
    diag: lastDiag,
    rawText: lastText,
    verdict,
  };
}

/** 累加多次调用的用量（不能只记最后一次，否则计费显示会少算） */
function sumUsage(list: TokenUsage[]): TokenUsage {
  return list.reduce<TokenUsage>(
    (acc, u) => ({
      prompt: acc.prompt + (u?.prompt ?? 0),
      completion: acc.completion + (u?.completion ?? 0),
      total: acc.total + (u?.total ?? 0),
      costCNY: (acc.costCNY ?? 0) + (u?.costCNY ?? 0),
    }),
    { ...EMPTY_USAGE },
  );
}

/** 连通性测试：用一个最小请求验证 baseUrl / apiKey / model 三者是否可用 */
export async function testConnection(cfg: AIConfig): Promise<AICallResult> {
  const messages: ChatMessage[] = [{ role: 'user', content: buildPingPrompt() }];
  return callAI(cfg, messages, { json: false, retries: 0, timeoutMs: Math.min(cfg.timeoutMs || 60_000, 30_000) });
}

/** 试卷解析 */
export async function parsePaper(
  cfg: AIConfig,
  rawText: string,
  subject?: string,
): Promise<{ ok: boolean; data: unknown; usage: TokenUsage; diag: AICallResult['diag']; rawText: string }> {
  const messages: ChatMessage[] = [{ role: 'user', content: buildParsePaperPrompt(rawText, subject) }];
  const call = await callAI(cfg, messages, { json: true });
  if (!call.ok) return { ok: false, data: null, usage: call.usage, diag: call.diag, rawText: call.text };

  const parsed = parseJsonLoose(call.text);
  if (!parsed) {
    return {
      ok: false,
      data: null,
      usage: call.usage,
      diag: { ...call.diag, errorCode: 'BAD_JSON', rawSnippet: call.text.slice(0, 300) },
      rawText: call.text,
    };
  }
  return { ok: true, data: parsed.value, usage: call.usage, diag: call.diag, rawText: call.text };
}

/** 答卷识别（视觉） */
export async function visionAnswers(
  cfg: AIConfig,
  images: ImagePart[],
  questionCount: number,
): Promise<{ ok: boolean; data: unknown; usage: TokenUsage; diag: AICallResult['diag']; rawText: string }> {
  const messages: ChatMessage[] = [
    { role: 'user', content: buildVisionAnswersPrompt(questionCount), images },
  ];
  const call = await callAI(cfg, messages, { json: true });
  if (!call.ok) return { ok: false, data: null, usage: call.usage, diag: call.diag, rawText: call.text };

  const parsed = parseJsonLoose(call.text);
  if (!parsed) {
    return {
      ok: false,
      data: null,
      usage: call.usage,
      diag: { ...call.diag, errorCode: 'BAD_JSON', rawSnippet: call.text.slice(0, 300) },
      rawText: call.text,
    };
  }
  return { ok: true, data: parsed.value, usage: call.usage, diag: call.diag, rawText: call.text };
}

/** 生成本次运行 id，用于审计留痕与失败案例库关联 */

/** 截图提取评分细则（Phase B3） */
export async function extractRubric(
  cfg: AIConfig,
  image: ImagePart,
  subject?: string,
): Promise<{ ok: boolean; rubric?: ExtractedRubric; rawText?: string; usage: TokenUsage; error?: string }> {
  const prompt = buildExtractRubricPrompt(subject);
  const messages: ChatMessage[] = [
    { role: 'user', content: prompt, images: [image] },
  ];
  const call = await callAI(cfg, messages, { json: true });
  if (!call.ok) {
    return { ok: false, rawText: call.text, usage: call.usage, error: call.diag.rawSnippet ?? '调用失败' };
  }

  const parsed = parseJsonLoose(call.text);
  if (!parsed || typeof parsed.value !== 'object' || parsed.value === null) {
    return { ok: false, rawText: call.text, usage: call.usage, error: '未能从模型响应解析出结构化 JSON' };
  }

  const val = parsed.value as Record<string, unknown>;
  const stem = typeof val.stem === 'string' ? val.stem : '';
  const questionType = (['choice', 'judge', 'fill', 'short', 'calc', 'essay'].includes(String(val.questionType))
    ? val.questionType
    : 'short') as QuestionType;
  const fullScore = typeof val.fullScore === 'number' && val.fullScore > 0 ? val.fullScore : 10;
  const referenceAnswer = typeof val.referenceAnswer === 'string' ? val.referenceAnswer : '';
  const scoringPoints = Array.isArray(val.scoringPoints)
    ? val.scoringPoints.map((pt) => String(pt).trim()).filter(Boolean)
    : [];

  return {
    ok: true,
    rubric: {
      stem,
      questionType,
      fullScore,
      referenceAnswer,
      scoringPoints,
    },
    rawText: call.text,
    usage: call.usage,
  };
}

export function newRunId(): string {
  return randomUUID();
}

/* -------------------------------------------------------------- 内部 */

export { DEFAULT_MAX_TOKENS };
export interface OptimizedCriteriaResult {
  scoringPoints: string[];
  supplementaryCorrect: string[];
  supplementaryIncorrect: string[];
  rawText: string;
}

/**
 * 细则结构化扩充优化器 (借鉴木鱼 youhua_prompt)
 */
export async function optimizeCriteria(
  cfg: AIConfig,
  rawCriteria: string,
  options: { subject?: string; fullScore?: number; signal?: AbortSignal } = {},
): Promise<{ ok: boolean; result?: OptimizedCriteriaResult; error?: string }> {
  if (!rawCriteria.trim()) {
    return { ok: false, error: '原始评分细则不能为空' };
  }

  const prompt = buildOptimizeCriteriaPrompt(rawCriteria, options.subject, options.fullScore);
  const callRes = await callAI(
    cfg,
    [
      { role: 'system', content: '你是一位精通国家命题与中高考阅卷标准的资深学科专家，擅长将简要答案拆解为评分细则。' },
      { role: 'user', content: prompt },
    ],
    { signal: options.signal, temperature: 0.2 },
  );

  if (!callRes.ok) {
    return { ok: false, error: callRes.diag?.rawSnippet || '调用大模型扩充细则失败' };
  }

  const parsed = parseJsonLoose(callRes.text);
  if (!parsed || !parsed.value || typeof parsed.value !== 'object') {
    return { ok: false, error: '模型返回内容无法解析为细则 JSON: ' + callRes.text.slice(0, 100) };
  }

  const obj = parsed.value as Record<string, unknown>;
  const scoringPoints = asStringArray(obj.scoringPoints);
  const supplementaryCorrect = asStringArray(obj.supplementaryCorrect);
  const supplementaryIncorrect = asStringArray(obj.supplementaryIncorrect);

  return {
    ok: true,
    result: {
      scoringPoints: scoringPoints.length > 0 ? scoringPoints : [rawCriteria.trim()],
      supplementaryCorrect,
      supplementaryIncorrect,
      rawText: callRes.text,
    },
  };
}
