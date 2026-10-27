/**
 * 供应商预设 —— 渲染层（设置面板）与主进程（兼容层）共用的唯一真源。
 *
 * 为什么必须在 shared：这两处用的是**同一套事实**（baseUrl / 默认模型 /
 * thinking 开关 / 是否支持视觉），曾各写一遍 —— 改一处忘另一处就会出现
 * 「选了预设但请求发错地址」或「面板说支持视觉、主进程却拦截」的静默漂移。
 * 类似的前科：preview-api 假桥与真实 API 漂移（§7.4），同样靠单源解决。
 *
 * 改这里时注意：`sampleModels` 只是输入建议（datalist），不是白名单；
 * 视觉能力白名单是 types.ts 的 `VISION_MODEL_PREFIXES`（按模型名前缀判定），
 * 两者职责不同，不要合并。
 */
import type { ProviderPreset } from './types';

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
    disableThinking: true, // ★ 必须关：reasoning_content 也计入 max_tokens，思考把额度吃光后正文为空
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