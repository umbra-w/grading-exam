/**
 * 主流网阅平台预设配置 (Phase B1 —— 参考 AI-Marker-Suite 逆向与实操实践)。
 *
 * 覆盖国内主流在线网阅平台（智学网、好分数、七天网络、通用平台）：
 * 1. 域名自动识别与匹配
 * 2. 试卷题目图像/Canvas 选择器候选链
 * 3. 分数输入框选择器候选链
 * 4. 提交/下一题按钮候选链
 * 5. 安全风控防抖节流建议（避免高频触发平台风控）
 */

export interface PlatformPreset {
  id: 'zhixue' | 'haofenshu' | 'qitian' | 'generic';
  name: string;
  domainMatches: string[];
  defaultUrl: string;
  selectors: {
    /** 试卷/答题卡展示区候选选择器列表 */
    questionArea: string[];
    /** 填分输入框候选选择器列表 */
    scoreInput: string[];
    /** 提交/保存并下一份候选按钮选择器列表 */
    submitButton: string[];
  };
  /** 平台建议的最低操作间隔（毫秒），防机器人风控 */
  defaultThrottleMs: number;
  /** 平台适配要点说明 */
  notes: string;
}

export const PLATFORM_PRESETS: PlatformPreset[] = [
  {
    id: 'zhixue',
    name: '智学网',
    domainMatches: ['zhixue.com', 'teacher.zhixue.com', 'marking.zhixue.com'],
    defaultUrl: 'https://teacher.zhixue.com',
    selectors: {
      questionArea: [
        '#paper-image',
        '.marking-img-box img',
        'img.marking-img',
        'canvas.paper-canvas',
        '.question-paper img',
        '#mainPaperImg',
      ],
      scoreInput: [
        'input.score-input',
        'input.mark-input',
        '#curScore',
        '.score-wrapper input',
        'input[name="score"]',
        'input.total-score',
      ],
      submitButton: [
        'button.btn-submit',
        '.submit-mark',
        '#submitScore',
        '.btn-next-paper',
        'button.submit-btn',
        '.action-btn.submit',
      ],
    },
    defaultThrottleMs: 1800,
    notes: '科大讯飞智学网：通常采用多重 iframe 嵌套与受控 input 监听。建议节流 1.8s+。',
  },
  {
    id: 'haofenshu',
    name: '好分数 / 易择阅卷',
    domainMatches: ['haofenshu.com', 'yize.com', 'mark.haofenshu.com'],
    defaultUrl: 'https://mark.haofenshu.com',
    selectors: {
      questionArea: [
        '.paper-pic img',
        '#paperImg',
        '.answer-sheet img',
        '.sheet-container img',
        '.question-box img',
      ],
      scoreInput: [
        'input.score-ipt',
        'input.total-score',
        'input.sub-score',
        '#txtScore',
        '.score-input-container input',
      ],
      submitButton: [
        '.btn-submit-score',
        '.btn-confirm',
        '#btnNext',
        '.btn-next-paper',
        'button.submit-score-btn',
      ],
    },
    defaultThrottleMs: 2000,
    notes: '好分数云阅卷：支持按小题分步打分与总分联动，提交时通常会触发焦点离焦校验。',
  },
  {
    id: 'qitian',
    name: '七天网络',
    domainMatches: ['7tin.cn', 'qitian.com', 'mark.7tin.cn'],
    defaultUrl: 'https://mark.7tin.cn',
    selectors: {
      questionArea: [
        '#imgPaper',
        '.paper-box img',
        '#mainImg',
        '.paper-viewer img',
        '.marking-content img',
      ],
      scoreInput: [
        '#txtScore',
        'input.input-score',
        '#giveScore',
        '.score-box input',
        'input[id*="Score"]',
      ],
      submitButton: [
        '#btnSubmit',
        '.btn-save-score',
        '#btnSave',
        '.btn-next',
        'button.save-btn',
      ],
    },
    defaultThrottleMs: 1800,
    notes: '七天网络评卷系统：DOM 输入框相对规范，支持回读校验与键盘回车流。',
  },
  {
    id: 'generic',
    name: '通用 / 其它网阅平台',
    domainMatches: ['*'],
    defaultUrl: 'https://',
    selectors: {
      questionArea: [
        'img[src*="paper"]',
        'img[src*="marking"]',
        '.paper-img',
        '.marking-img',
        'canvas',
      ],
      scoreInput: [
        'input[type="number"]',
        'input[name*="score"]',
        'input[class*="score"]',
        'input[id*="score"]',
      ],
      submitButton: [
        'button[type="submit"]',
        'button.submit',
        '.btn-submit',
        'button:has-text("提交")',
        '#btnSubmit',
      ],
    },
    defaultThrottleMs: 1500,
    notes: '通用启发式预设，适用于自建系统或小型在线测验平台。',
  },
];

/**
 * 根据页面 URL 自动匹配最佳平台预设配置。
 */
export function matchPlatformPreset(url: string): PlatformPreset {
  if (!url || typeof url !== 'string') {
    return PLATFORM_PRESETS[PLATFORM_PRESETS.length - 1];
  }

  const lower = url.toLowerCase();

  for (const preset of PLATFORM_PRESETS) {
    if (preset.id === 'generic') continue;
    for (const d of preset.domainMatches) {
      if (lower.includes(d)) {
        return preset;
      }
    }
  }

  // 默认回退至通用配置
  return PLATFORM_PRESETS[PLATFORM_PRESETS.length - 1];
}

/**
 * 根据预设 ID 直接检索配置。
 */
export function getPlatformPresetById(id: string): PlatformPreset {
  return PLATFORM_PRESETS.find((p) => p.id === id) ?? PLATFORM_PRESETS[PLATFORM_PRESETS.length - 1];
}
