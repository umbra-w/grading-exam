/**
 * 供应商兼容层 —— 本文件是整个复刻里最容易踩坑的地方。
 * 对应原版 v1.2.10 ~ v1.2.12 的三次「AI 返回为空」故障。
 *
 * 三个事实：
 *  1. DeepSeek v4 系列（含 deepseek-flash）默认开启思考模式，
 *     reasoning_content 也计入 max_tokens；思考把额度吃光后 content 就是空的。
 *  2. 部分国产服务商用非标准字段名返回思考内容（reasoning / reasoning_content /
 *     thinking），正文为空时必须回退读取。
 *  3. max_tokens 给小了（4000）同样会正文为空，默认值必须给足。
 */
import type { AIConfig, ChatMessage, ProviderPreset } from '../../shared/types';
import { VISION_MODEL_PREFIXES } from '../../shared/types';

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    disableThinking: false,
    vision: true,
    sampleModels: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1'],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    disableThinking: true, // ★ 必须关
    vision: false,
    sampleModels: ['deepseek-chat', 'deepseek-flash', 'deepseek-v4'],
  },
  {
    id: 'qwen',
    label: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    disableThinking: true,
    vision: true,
    sampleModels: ['qwen-plus', 'qwen-max', 'qwen-vl-max', 'qwen2.5-vl-72b-instruct'],
  },
  {
    id: 'zhipu',
    label: '智谱',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-plus',
    disableThinking: true,
    vision: true,
    sampleModels: ['glm-4-plus', 'glm-4v-plus', 'glm-4.1v'],
  },
  {
    id: 'kimi',
    label: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-32k',
    disableThinking: true,
    vision: true,
    sampleModels: ['moonshot-v1-32k', 'kimi-latest', 'moonshot-v1-8k-vision-preview'],
  },
  {
    id: 'custom',
    label: '自定义（OpenAI 兼容）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'qwen2.5:7b',
    disableThinking: false,
    vision: false,
    sampleModels: [],
  },
];

export const DEFAULT_MAX_TOKENS = 8000; // ★ 不是 4000

/** 判断模型是否具备视觉能力（白名单前缀匹配，故意宽松，避免误杀） */
export function modelSupportsVision(model: string): boolean {
  const m = (model || '').toLowerCase();
  return VISION_MODEL_PREFIXES.some((p) => m.startsWith(p));
}

/**
 * 是否应该发送关闭思考模式的开关。
 * 只对「已知会默认思考」的供应商/模型发送，避免给不认识的商家塞未知字段。
 */
export function shouldDisableThinking(cfg: Pick<AIConfig, 'provider' | 'model' | 'disableThinking'>): boolean {
  if (!cfg.disableThinking) return false;
  const m = (cfg.model || '').toLowerCase();
  const thinkingProne =
    cfg.provider === 'deepseek' ||
    cfg.provider === 'qwen' ||
    cfg.provider === 'zhipu' ||
    cfg.provider === 'kimi' ||
    /\b(v4|r1|reasoner|thinking|qwq|o[1-9])\b/.test(m) ||
    m.includes('-r1') ||
    m.includes('reasoner');
  return thinkingProne;
}

/** 组装 OpenAI 兼容的请求体（含多模态与思考开关） */
export function buildRequestBody(
  cfg: AIConfig,
  messages: ChatMessage[],
  opts: { json?: boolean; temperature?: number } = {},
): Record<string, unknown> {
  const disableThinking = shouldDisableThinking(cfg);

  const body: Record<string, unknown> = {
    model: cfg.model,
    max_tokens: cfg.maxTokens > 0 ? cfg.maxTokens : DEFAULT_MAX_TOKENS,
    // 允许逐次覆盖温度：多次运行分歧度需要每次用不同温度采样，
    // 否则同一输入同一温度会退化成完全相同的请求，测不出任何分歧。
    temperature: opts.temperature ?? cfg.temperature,
    messages: messages.map((m) => {
      if (!m.images?.length) return { role: m.role, content: m.content };
      return {
        role: m.role,
        content: [
          { type: 'text', text: m.content },
          ...m.images.map((img) => ({
            type: 'image_url',
            image_url: {
              url: img.data.startsWith('data:') ? img.data : `data:${img.mime};base64,${img.data}`,
            },
          })),
        ],
      };
    }),
  };

  if (disableThinking) {
    // DeepSeek 兼容写法；Zhipu/Qwen 的兼容端点会忽略未知字段，无副作用
    body.thinking = { type: 'disabled' };
    body.enable_thinking = false;
  }

  if (opts.json) body.response_format = { type: 'json_object' };

  return body;
}

/** 可能的思考内容字段名 */
const REASONING_KEYS = ['reasoning_content', 'reasoning', 'thinking', 'thought'] as const;

export interface ExtractResult {
  text: string;
  usedReasoningFallback: boolean;
  finishReason?: string;
  /** 模型主动拒绝或额度耗尽等服务质量问题 */
  degenerate: boolean;
}

/**
 * 从响应 JSON 中抽取正文 —— 空响应兜底的核心。
 * 顺序：choices[0].message.content → 各 reasoning 字段 → choices[0].text（补全式端点）
 */
export function extractContent(json: unknown): ExtractResult {
  const j = json as {
    choices?: Array<{
      message?: Record<string, unknown>;
      text?: string;
      finish_reason?: string;
    }>;
    error?: { message?: string; code?: string };
  };

  const choice = j?.choices?.[0];
  if (!choice) {
    return {
      text: '',
      usedReasoningFallback: false,
      degenerate: true,
      finishReason: undefined,
    };
  }

  const finishReason = choice.finish_reason;
  const raw = choice.message?.content;

  // content 可能是 string，也可能是 [{type:'text',text}] 数组
  let content = '';
  if (typeof raw === 'string') content = raw;
  else if (Array.isArray(raw)) {
    content = raw
      .map((p) => (typeof p === 'string' ? p : ((p as { text?: string })?.text ?? '')))
      .join('');
  }

  if (content.trim()) {
    return { text: content.trim(), usedReasoningFallback: false, finishReason, degenerate: false };
  }

  // ★ 正文为空 → 回退读思考字段（v1.2.10 的修复）
  for (const key of REASONING_KEYS) {
    const v = choice.message?.[key];
    if (typeof v === 'string' && v.trim()) {
      return {
        text: v.trim(),
        usedReasoningFallback: true,
        finishReason,
        degenerate: false,
      };
    }
  }

  // 补全式端点
  if (typeof choice.text === 'string' && choice.text.trim()) {
    return { text: choice.text.trim(), usedReasoningFallback: false, finishReason, degenerate: false };
  }

  return { text: '', usedReasoningFallback: false, finishReason, degenerate: true };
}

/** 把失败原因翻译成能让人一眼看懂的中文诊断 */
export function diagnoseEmpty(res: ExtractResult, httpStatus?: number): string {
  const fr = res.finishReason;
  if (fr === 'length') {
    return `模型输出被 max_tokens 截断（finish_reason=length，当前 ${DEFAULT_MAX_TOKENS} 起）。若为思考型模型，请在设置中开启「关闭思考模式」。`;
  }
  if (fr === 'content_filter') {
    return '输出被内容安全策略拦截（finish_reason=content_filter）。请检查题目内容或更换服务商。';
  }
  if (httpStatus === 401) return 'API Key 无效或过期（HTTP 401）。';
  if (httpStatus === 403) return '无权访问该模型（HTTP 403）。请确认账号已开通该模型。';
  if (httpStatus === 429) return '触发限流或余额不足（HTTP 429）。';
  if (httpStatus && httpStatus >= 500) return `服务商侧错误（HTTP ${httpStatus}），稍后重试。`;
  return `服务商返回了空内容（finish_reason=${fr ?? 'unknown'}）。常见原因：思考模式耗尽输出额度、模型不支持图片输入。`;
}

/* -------------------------------------------------------------- 归一化 */

/**
 * 客观题答案归一化：去空格、去标点、统一大小写、全角转半角。
 * 纯本地运算，不消耗任何 token（对应产品说明 F3.2 / FAQ Q2）。
 */
export function normalizeAnswer(input: string): string {
  if (!input) return '';
  let s = input.normalize('NFKC');
  s = s.replace(/\s+/g, '');
  // 去中英文标点
  s = s.replace(/[.,;:!?'"`~\-_/\\|()[\]{}<>，。、；：！？…—“”‘’《》（）【】〔〕·]/g, '');
  // 判断题口语统一
  s = s
    .replace(/^(正确|对|是|true|t|v|√|✓)$/i, 'T')
    .replace(/^(错误|错|否|false|f|x|×|✗)$/i, 'F');
  // 多选题排序统一（A,C,B → ABC），产品说明里是「严格比对」，这里给个更宽松的可选项
  return s.toUpperCase();
}

/** 严格顺序比对（产品说明的默认行为） */
export function compareObjective(stu: string, std: string): boolean {
  return normalizeAnswer(stu) === normalizeAnswer(std);
}

/** 宽松比对：多选题忽略选项顺序。产品说明 FAQ Q2 提到严格比对是当前行为，这里作为可选增强 */
export function compareObjectiveLoose(stu: string, std: string): boolean {
  const a = normalizeAnswer(stu);
  const b = normalizeAnswer(std);
  if (a === b) return true;
  if (/^[A-Z]+$/.test(a) && /^[A-Z]+$/.test(b)) {
    return a.split('').sort().join('') === b.split('').sort().join('');
  }
  return false;
}

/** 从识别文本首行提取姓名 / 考号（对应 F2.3 与 FAQ Q3） */
export function parseStudentHeader(text: string): { name: string; examNo: string; rest: string } {
  const lines = (text ?? '').split(/\r?\n/);
  let name = '';
  let examNo = '';
  let consumed = 0;

  // 最多看前 3 行，姓名/考号顺序不定
  for (let i = 0; i < Math.min(3, lines.length); i++) {
    const line = lines[i].trim();
    if (!line) {
      consumed = i + 1;
      continue;
    }
    const noMatch = line.match(/(?:考号|学号|准考证号|编号)\s*[:：]?\s*([A-Za-z0-9-]{3,})/);
    const nameMatch = line.match(/(?:姓名|学生|名字)\s*[:：]?\s*([\u4e00-\u9fa5·]{2,10})/);
    const bareNo = line.match(/^([A-Za-z0-9]{6,})$/);
    const bareName = line.match(/^([\u4e00-\u9fa5·]{2,4})$/);

    if (noMatch) {
      examNo = noMatch[1];
      consumed = i + 1;
    } else if (nameMatch) {
      name = nameMatch[1];
      consumed = i + 1;
    } else if (bareNo && !examNo) {
      examNo = bareNo[1];
      consumed = i + 1;
    } else if (bareName && !name) {
      name = bareName[1];
      consumed = i + 1;
    } else {
      break;
    }
  }

  return { name, examNo, rest: lines.slice(consumed).join('\n') };
}