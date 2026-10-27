/**
 * AI 层单测。
 *
 * 重点不在"能不能调通"（那要真 Key），而在**输出不可信时系统的行为**：
 * 模型返回坏 JSON、越界分数、缺置信度时，系统必须拒绝记分或保守降级，
 * 绝不能把模型说的数字直接当结果——那是阅卷场景里最危险的静默错误。
 *
 * 全部用 mock fetch，零网络、零 token、不需要 API Key。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AIConfig } from '@shared/types';
import {
  callAI,
  gradeQuestion,
  parseJsonLoose,
  sanitizeGradeResult,
  snapToGranularity,
  testConnection,
} from '../src/main/ai/client';
import {
  LOW_CONFIDENCE_THRESHOLD,
  PROMPT_SET_HASH,
  PROMPT_VERSION,
  buildGradePrompt,
  buildParsePaperPrompt,
  buildVisionAnswersPrompt,
  promptStamp,
} from '../src/main/ai/prompts';
import { buildRequestBody, extractContent, normalizeAnswer, compareObjective } from '../src/main/ai/compat';

const CFG: AIConfig = {
  provider: 'deepseek',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  model: 'deepseek-chat',
  disableThinking: true,
  maxTokens: 8000,
  temperature: 0.1,
  timeoutMs: 5000,
};

/** 构造一个 chat completion 响应体 */
function completion(payload: Record<string, unknown>, usage: Record<string, number> = {}): string {
  return JSON.stringify({
    id: 'x',
    choices: [{ index: 0, message: payload, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: usage.prompt ?? 100,
      completion_tokens: usage.completion ?? 50,
      total_tokens: usage.total ?? 150,
    },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ------------------------------------------------ callAI 的失败语义 */

describe('callAI —— 所有失败都编码进返回值，不抛异常', () => {
  it('成功时返回正文与用量', async () => {
    fetchMock.mockResolvedValue(
      new Response(completion({ content: '可用' }, { prompt: 10, completion: 2, total: 12 }), { status: 200 }),
    );
    const r = await callAI(CFG, [{ role: 'user', content: 'hi' }], { retries: 0 });
    expect(r.ok).toBe(true);
    expect(r.text).toBe('可用');
    expect(r.usage.total).toBe(12);
    expect(r.diag.httpStatus).toBe(200);
  });

  it('未填 API Key 时直接失败，且不发请求', async () => {
    const r = await callAI({ ...CFG, apiKey: '' }, [{ role: 'user', content: 'hi' }], { retries: 0 });
    expect(r.ok).toBe(false);
    expect(r.diag.errorCode).toBe('NO_API_KEY');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('含图 + 非视觉模型 → 请求前拦截（VISION_UNSUPPORTED）', async () => {
    const r = await callAI(
      CFG, // deepseek-chat 非视觉模型
      [{ role: 'user', content: '看图', images: [{ data: 'AAAA', mime: 'image/png' }] }],
      { retries: 0 },
    );
    expect(r.ok).toBe(false);
    expect(r.diag.errorCode).toBe('VISION_UNSUPPORTED');
    // 关键：不浪费一次必然失败的请求
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('正文为空且思考字段有内容 → 回退读取，标记 usedReasoningFallback', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({
        choices: [{ message: { content: '', reasoning_content: '思考后的结论：6 分' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 900, total_tokens: 910 },
      }), { status: 200 }),
    );
    const r = await callAI(CFG, [{ role: 'user', content: 'x' }], { retries: 0 });
    expect(r.ok).toBe(true);
    expect(r.text).toBe('思考后的结论：6 分');
    expect(r.diag.usedReasoningFallback).toBe(true);
  });

  it('全空响应 → EMPTY_CONTENT 且带可读诊断', async () => {
    fetchMock.mockResolvedValue(
      new Response(completion({ content: '' }), { status: 200 }),
    );
    const r = await callAI(CFG, [{ role: 'user', content: 'x' }], { retries: 0 });
    expect(r.ok).toBe(false);
    expect(r.diag.errorCode).toBe('EMPTY_CONTENT');
    expect(r.diag.rawSnippet).toBeTruthy();
  });

  it('finish_reason=length 的诊断提示应指向 max_tokens 与思考模式', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({
        choices: [{ message: { content: '' }, finish_reason: 'length' }],
        usage: {},
      }), { status: 200 }),
    );
    const r = await callAI(CFG, [{ role: 'user', content: 'x' }], { retries: 0 });
    expect(r.diag.rawSnippet).toContain('max_tokens');
    expect(r.diag.rawSnippet).toContain('思考');
  });

  it('HTTP 401 不重试（配置问题重试无意义）', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":{"message":"bad key"}}', { status: 401 }));
    const r = await callAI(CFG, [{ role: 'user', content: 'x' }], { retries: 3 });
    expect(r.ok).toBe(false);
    expect(r.diag.httpStatus).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('HTTP 500 会重试到上限', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));
    const r = await callAI(CFG, [{ role: 'user', content: 'x' }], { retries: 2 });
    expect(r.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 首次 + 2 次重试
  });

  it('网络异常被捕获为 NETWORK_ERROR，不向上抛', async () => {
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));
    await expect(callAI(CFG, [{ role: 'user', content: 'x' }], { retries: 0 })).resolves.toMatchObject({
      ok: false,
      diag: { errorCode: 'NETWORK_ERROR' },
    });
  });

  it('按 allowlist 解析 usage，字段缺失不报错', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }),
    );
    const r = await callAI(CFG, [{ role: 'user', content: 'x' }], { retries: 0 });
    expect(r.ok).toBe(true);
    expect(r.usage).toEqual({ prompt: 0, completion: 0, total: 0, costCNY: 0 });
  });
});

/* ------------------------------------------------- JSON 宽松解析 */

describe('parseJsonLoose —— 覆盖真实见过的三种脏输出', () => {
  it('纯 JSON', () => {
    expect(parseJsonLoose('{"score":5}')).toMatchObject({ value: { score: 5 }, strategy: 'direct' });
  });

  it('```json 包裹', () => {
    const r = parseJsonLoose('```json\n{"score":5}\n```');
    expect(r?.value).toEqual({ score: 5 });
    expect(r?.strategy).toBe('fenced');
  });

  it('无语言标记的 ``` 包裹', () => {
    expect(parseJsonLoose('```\n{"score":5}\n```')?.strategy).toBe('fenced');
  });

  it('前后有解释性文字', () => {
    const r = parseJsonLoose('好的，以下是评分结果：\n{"score":5}\n以上就是我的判断。');
    expect(r?.value).toEqual({ score: 5 });
    expect(r?.strategy).toBe('bracketed');
  });

  it('嵌套对象也能取出', () => {
    const r = parseJsonLoose('结果：{"score":5,"nested":{"a":[1,2]}} 完毕');
    expect(r?.value).toEqual({ score: 5, nested: { a: [1, 2] } });
  });

  it('彻底不是 JSON → null（绝不猜）', () => {
    expect(parseJsonLoose('我觉得这道题应该给 5 分吧')).toBeNull();
    expect(parseJsonLoose('')).toBeNull();
    expect(parseJsonLoose('{坏掉的')).toBeNull();
  });
});

/* ------------------------------------------- 分数清洗（核心防线） */

describe('sanitizeGradeResult —— 拦住所有静默错误', () => {
  it('正常输入原样通过', () => {
    const r = sanitizeGradeResult(
      { score: 5, comment: '步骤完整', hitPoints: ['列方程'], missedPoints: ['单位'], confidence: 0.95, reviewRequested: false },
      6,
    );
    expect(r).toMatchObject({ score: 5, confidence: 0.95, reviewRequested: false });
    expect(r!.warnings).toHaveLength(0);
  });

  it('★ 缺 score → 返回 null（拒绝记分，不猜）', () => {
    expect(sanitizeGradeResult({ comment: '写得不错' }, 6)).toBeNull();
    expect(sanitizeGradeResult({ score: 'abc' }, 6)).toBeNull();
    expect(sanitizeGradeResult({ score: null }, 6)).toBeNull();
  });

  it('★ 回归：非数字字符串分数绝不能被当成 0 分', () => {
    // 曾经的实现用 Number(s.replace(/[^\d.-]/g,''))，
    // 'abc' 清洗后为空串，而 Number('') === 0 ——
    // 于是「模型返回了非数字分数」被静默记成 0 分：学生明明答了，系统给 0。
    // 这是最危险的一类静默错误，用本用例钉死。
    for (const bad of ['abc', '良好', '待定', 'N/A', '-', '.', '分', '', '   ']) {
      expect(sanitizeGradeResult({ score: bad }, 6), `score=${JSON.stringify(bad)} 应被拒绝`).toBeNull();
    }
  });

  it('★ 纯符号置信度也不能被当成 0 而绕过阈值', () => {
    // confidence 走同一个 asNumber：'abc' → null → 应落到保守值 0.5 并强制复核
    const r = sanitizeGradeResult({ score: 5, confidence: 'abc' }, 6)!;
    expect(r.confidence).toBe(0.5);
    expect(r.reviewRequested).toBe(true);
  });

  it('★ NaN / Infinity → 返回 null', () => {
    expect(sanitizeGradeResult({ score: NaN }, 6)).toBeNull();
    expect(sanitizeGradeResult({ score: Infinity }, 6)).toBeNull();
    expect(sanitizeGradeResult({ score: -Infinity }, 6)).toBeNull();
  });

  it('非对象输入 → null', () => {
    expect(sanitizeGradeResult(null, 6)).toBeNull();
    expect(sanitizeGradeResult('5', 6)).toBeNull();
    expect(sanitizeGradeResult([], 6)).toBeNull();
  });

  it('★ 超过满分 → 夹到满分并记警告', () => {
    const r = sanitizeGradeResult({ score: 8, fullScore: 6 }, 6)!;
    expect(r.score).toBe(6);
    expect(r.warnings.join('')).toContain('超过满分');
  });

  it('★ 负分 → 夹到 0 并记警告', () => {
    const r = sanitizeGradeResult({ score: -3 }, 6)!;
    expect(r.score).toBe(0);
    expect(r.warnings.join('')).toContain('负分');
  });

  it('分数吸附到 0.5 粒度', () => {
    const r = sanitizeGradeResult({ score: 5.3 }, 6)!;
    expect(r.score).toBe(5.5);
    expect(r.warnings.join('')).toContain('吸附');
  });

  it('字符串分数可解析', () => {
    expect(sanitizeGradeResult({ score: '5.5 分' }, 6)!.score).toBe(5.5);
  });

  it('★ 缺 confidence → 默认保守值 0.5 且强制复核（不默认高）', () => {
    const r = sanitizeGradeResult({ score: 5 }, 6)!;
    expect(r.confidence).toBe(0.5);
    expect(r.reviewRequested).toBe(true);
    expect(r.warnings.join('')).toContain('未返回 confidence');
  });

  it('★ confidence 低于阈值 → 强制 reviewRequested=true（覆盖模型自己的 false）', () => {
    const r = sanitizeGradeResult({ score: 5, confidence: 0.6, reviewRequested: false }, 6)!;
    expect(r.reviewRequested).toBe(true);
    expect(r.warnings.join('')).toContain('强制');
  });

  it('confidence 达到阈值时尊重模型判断', () => {
    const r = sanitizeGradeResult({ score: 5, confidence: LOW_CONFIDENCE_THRESHOLD, reviewRequested: false }, 6)!;
    expect(r.reviewRequested).toBe(false);
  });

  it('confidence 百分制 → 归一化', () => {
    const r = sanitizeGradeResult({ score: 5, confidence: 90 }, 6)!;
    expect(r.confidence).toBeCloseTo(0.9);
    expect(r.warnings.join('')).toContain('百分制');
  });

  it('confidence 超范围（>100）→ 保守值 0.5', () => {
    const r = sanitizeGradeResult({ score: 5, confidence: 500 }, 6)!;
    expect(r.confidence).toBe(0.5);
    expect(r.reviewRequested).toBe(true);
  });

  it('hitPoints/missedPoints 非数组时尽力转换', () => {
    const r = sanitizeGradeResult(
      { score: 5, hitPoints: '列方程；求解正确', missedPoints: ['单位'] },
      6,
    )!;
    expect(r.hitPoints).toEqual(['列方程', '求解正确']);
    expect(r.missedPoints).toEqual(['单位']);
  });

  it('hitPoints 含空串与多余类型时被过滤', () => {
    const r = sanitizeGradeResult({ score: 5, hitPoints: ['ok', '', null, 123] }, 6)!;
    expect(r.hitPoints).toEqual(['ok', '123']);
  });

  it('附带提示词版本指纹', () => {
    const r = sanitizeGradeResult({ score: 5 }, 6)!;
    expect(r.promptVersion).toBe(PROMPT_VERSION);
    expect(r.promptHash).toBe(PROMPT_SET_HASH);
  });
});

describe('snapToGranularity', () => {
  it('按 0.5 吸附', () => {
    expect(snapToGranularity(5.3)).toBe(5.5);
    expect(snapToGranularity(5.2)).toBe(5);
    expect(snapToGranularity(5.25)).toBe(5.5);
  });
  it('粒度 <= 0 时原样返回', () => {
    expect(snapToGranularity(5.3, 0)).toBe(5.3);
  });
});

/* --------------------------------------------------- 端到端评分 */

describe('gradeQuestion —— 端到端（mock fetch）', () => {
  const input = {
    questionText: '求 4 秒末速度',
    fullScore: 6,
    referenceAnswer: 'v = 2 + 1.5×4 = 8 m/s',
    scoringPoints: ['列方程 2 分', '求解正确 3 分', '带单位 1 分'],
    answerText: 'v=8m/s',
  };

  it('成功时返回清洗后的结构化结果', async () => {
    fetchMock.mockResolvedValue(
      new Response(completion({
        content: JSON.stringify({
          score: 6, comment: '完整', hitPoints: ['列方程 2 分'], missedPoints: [],
          confidence: 0.92, reviewRequested: false,
        }),
      }), { status: 200 }),
    );
    const r = await gradeQuestion(CFG, input);
    expect(r.ok).toBe(true);
    expect(r.result!.score).toBe(6);
    expect(r.result!.confidence).toBe(0.92);
    expect(r.rawText).toContain('完整'); // 保留原始响应供人工核对
  });

  it('发送了 system + user 两条消息，且 system 含评分纪律', async () => {
    fetchMock.mockResolvedValue(
      new Response(completion({ content: '{"score":6,"confidence":0.9}' }), { status: 200 }),
    );
    await gradeQuestion(CFG, input);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('评分要点');
    expect(body.messages[1].content).toContain('求 4 秒末速度');
    expect(body.messages[1].content).toContain('列方程 2 分');
  });

  it('★ 请求关闭思考模式（deepseek 必须关，否则正文为空）', async () => {
    fetchMock.mockResolvedValue(
      new Response(completion({ content: '{"score":6,"confidence":0.9}' }), { status: 200 }),
    );
    await gradeQuestion(CFG, input);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.enable_thinking).toBe(false);
    expect(body.max_tokens).toBe(8000); // 不是 4000
  });

  it('★ 模型返回非 JSON → 拒绝记分并给出 BAD_JSON', async () => {
    fetchMock.mockResolvedValue(
      new Response(completion({ content: '这道题我给 6 分。' }), { status: 200 }),
    );
    const r = await gradeQuestion(CFG, input);
    expect(r.ok).toBe(false);
    expect(r.result).toBeNull();
    expect(r.diag.errorCode).toBe('BAD_JSON');
    expect(r.rawText).toContain('6 分'); // 原文保留，便于排查
  });

  it('★ JSON 合法但缺 score → MISSING_SCORE，不记分', async () => {
    fetchMock.mockResolvedValue(
      new Response(completion({ content: '{"comment":"不错","confidence":0.9}' }), { status: 200 }),
    );
    const r = await gradeQuestion(CFG, input);
    expect(r.ok).toBe(false);
    expect(r.diag.errorCode).toBe('MISSING_SCORE');
  });

  it('★★ 越界分数在端到端流程里也被夹住', async () => {
    fetchMock.mockResolvedValue(
      new Response(completion({ content: '{"score":99,"comment":"x","confidence":0.9}' }), { status: 200 }),
    );
    const r = await gradeQuestion(CFG, input);
    expect(r.ok).toBe(true);
    expect(r.result!.score).toBe(6); // 满分 6，不是 99
    expect(r.result!.warnings.join('')).toContain('超过满分');
  });

  it('被 ``` 包裹的 JSON 也能解析，并在警告里说明提取策略', async () => {
    fetchMock.mockResolvedValue(
      new Response(completion({ content: '```json\n{"score":5,"confidence":0.9}\n```' }), { status: 200 }),
    );
    const r = await gradeQuestion(CFG, input);
    expect(r.ok).toBe(true);
    expect(r.result!.score).toBe(5);
    expect(r.result!.warnings.join('')).toContain('fenced');
  });

  it('底层调用失败时原样上抛 diag，不产生 result', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 403 }));
    const r = await gradeQuestion(CFG, input);
    expect(r.ok).toBe(false);
    expect(r.result).toBeNull();
    expect(r.diag.httpStatus).toBe(403);
  });
});

describe('testConnection', () => {
  it('不重试（快速反馈）；失败时返回诊断', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 500 }));
    const r = await testConnection(CFG);
    expect(r.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/* ---------------------------------------------------- 提示词契约 */

describe('提示词模板', () => {
  it('评分提示包含全部关键要素', () => {
    const p = buildGradePrompt({
      questionText: '题干X', fullScore: 6, referenceAnswer: '答案Y',
      scoringPoints: ['要点1', '要点2'], answerText: '学生Z', subject: '数学',
    });
    for (const s of ['题干X', '6 分', '答案Y', '要点1', '要点2', '学生Z', '数学', 'confidence', 'reviewRequested']) {
      expect(p, `缺少 ${s}`).toContain(s);
    }
  });

  it('未提供评分要点时明确要求模型自行拆分并说明', () => {
    const p = buildGradePrompt({
      questionText: 'x', fullScore: 6, referenceAnswer: 'y', scoringPoints: [], answerText: 'z',
    });
    expect(p).toContain('未提供评分要点');
    expect(p).toContain('说明你拆出了哪几点');
  });

  it('学生未作答时给出显式占位，避免模型把空白当内容', () => {
    const p = buildGradePrompt({
      questionText: 'x', fullScore: 6, referenceAnswer: 'y', scoringPoints: ['a'], answerText: '',
    });
    expect(p).toContain('学生未作答');
  });

  it('试卷解析提示要求保真录入、禁止编造得分点', () => {
    const p = buildParsePaperPrompt('试卷原文', '数学');
    expect(p).toContain('保真录入');
    expect(p).toContain('不要自己编造');
    expect(p).toContain('试卷原文');
  });

  it('视觉提示要求题号全覆盖且不臆造', () => {
    const p = buildVisionAnswersPrompt(20);
    expect(p).toContain('1 到 20 题');
    expect(p).toContain('不要凭上下文编造');
    expect(p).toContain('□');
  });

  it('★ 提示词集合哈希是确定的（同进程内两次一致）', () => {
    expect(promptStamp().hash).toBe(promptStamp().hash);
    expect(promptStamp().hash).toHaveLength(16);
  });

  it('promptStamp 暴露版本、哈希与复核阈值', () => {
    const s = promptStamp();
    expect(s.version).toBe(PROMPT_VERSION);
    expect(s.hash).toBe(PROMPT_SET_HASH);
    expect(s.lowConfidenceThreshold).toBe(LOW_CONFIDENCE_THRESHOLD);
  });

  it('低置信度阈值取 0.75（与 PLAN v2.0 复核策略一致）', () => {
    expect(LOW_CONFIDENCE_THRESHOLD).toBe(0.75);
  });
});

/* ----------------------------------------------------- compat 回归 */

describe('compat —— 复刻里三次故障的防回归', () => {
  it('deepseek 会关闭思考模式', () => {
    const body = buildRequestBody(CFG, [{ role: 'user', content: 'x' }]);
    expect(body.thinking).toEqual({ type: 'disabled' });
  });

  it('自定义供应商默认不塞 thinking 字段（避免未知字段副作用）', () => {
    const body = buildRequestBody(
      { ...CFG, provider: 'custom', model: 'qwen2.5:7b', disableThinking: true },
      [{ role: 'user', content: 'x' }],
    );
    expect(body.thinking).toBeUndefined();
  });

  it('多模态消息被组装为 image_url 数组', () => {
    const body = buildRequestBody(
      { ...CFG, model: 'gpt-4o', provider: 'openai' },
      [{ role: 'user', content: '看图', images: [{ data: 'AAAA', mime: 'image/png' }] }],
    );
    const msgs = body.messages as Array<{ content: unknown }>;
    expect(Array.isArray(msgs[0]!.content)).toBe(true);
    expect(JSON.stringify(msgs[0]!.content)).toContain('data:image/png;base64,AAAA');
  });

  it('extractContent 对数组式 content 做拼接', () => {
    const r = extractContent({ choices: [{ message: { content: [{ text: 'a' }, { text: 'b' }] } }] });
    expect(r.text).toBe('ab');
  });

  it('extractContent 无 choices 时标记 degenerate', () => {
    expect(extractContent({}).degenerate).toBe(true);
  });

  it('客观题归一化：全角半角、空格、标点、大小写', () => {
    expect(normalizeAnswer(' Ａ， B ')).toBe('AB');
    expect(normalizeAnswer('正确')).toBe('T');
    expect(normalizeAnswer('×')).toBe('F');
  });

  it('客观题严格比对（默认行为）', () => {
    expect(compareObjective(' A,B ', 'A,B')).toBe(true);
    expect(compareObjective('B,A', 'A,B')).toBe(false); // 严格顺序
  });
});