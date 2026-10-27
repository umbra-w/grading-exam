/**
 * 界面预览用的 IPC 模拟层 —— **仅用于本地渲染验证，不参与打包产物**。
 *
 * 存在的理由：本机 Electron 启动即崩（见 BLOCKERS.md B3），
 * 而"改了 CSS 但没看过一眼"等于没做。用系统自带的 Edge（Chromium）
 * 加载同一份渲染层代码 + 这份假桥，就能真实渲染并验证布局与配色。
 *
 * 用法（三条命令）：
 *   pnpm ui:preview      # 打包预览页（vite）
 *   pnpm ui:serve        # 起静态服务（127.0.0.1:8765）
 *   preview\shoot-all.cmd  # 逐面板截图 + dump DOM
 *   pnpm ui:verify       # 算对比度 + 统计截图像素
 *
 * 所有返回值都是**写死的假数据**，唯一目的是让界面水合到"有内容"的状态，
 * 从而能看出卡片、拾取槽、模式卡在真实数据下的样子。
 * 严禁在任何形式的真实运行中引入本文件。
 *
 * 维护提醒：这里的假数据必须**跟着 AppSettings 的真实结构走**。
 * 本文件踩过一次坑——顶层写了 exportDir 而真实结构是 general.exportDir，
 * 结果设置面板直接白屏。假数据与真类型脱节时，预览反而会骗人。
 */

const now = Date.now();

window.gradingExam = {
  getSettings: async () => ({
    ai: {
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-PREVIEW-PLACEHOLDER-NOT-A-REAL-KEY',
      model: 'deepseek-chat',
      temperature: 0.2,
      maxTokens: 4096,
      timeoutMs: 60000,
      disableThinking: true,
    },
    general: { theme: 'light', exportDir: 'C:\\exports', pollIntervalMs: 800 },
    autoDefaults: { mode: 'steady', throttleMs: 1200, maxPapers: 50, nextPaperTimeoutMs: 15000 },
  }),
  // settings:save 的契约是 Partial<AppSettings>，桩也照 Partial 回填，
  // 不要在这里断言成完整对象——那会掩盖真实的结构错误（本文件已经踩过一次）。
  saveSettings: async (patch) => ({
    ai: {
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-PREVIEW',
      model: 'deepseek-chat',
      temperature: 0.2,
      maxTokens: 4096,
      timeoutMs: 60000,
      disableThinking: true,
      ...(patch && patch.ai ? patch.ai : {}),
    },
    general: { theme: 'light', exportDir: 'C:\\exports', pollIntervalMs: 800, ...(patch && patch.general ? patch.general : {}) },
    autoDefaults: { mode: 'steady', throttleMs: 1200, maxPapers: 50, nextPaperTimeoutMs: 15000, ...(patch && patch.autoDefaults ? patch.autoDefaults : {}) },
  }),
  getUsage: async () => ({ prompt: 18420, completion: 3915, total: 22335, costCNY: 0.41 }),
  resetUsage: async () => ({ prompt: 0, completion: 0, total: 0, costCNY: 0 }),
  getAppInfo: async () => ({
    version: '0.1.0',
    electron: '45.0.0',
    node: '24.11.0',
    chrome: '140.0.0',
    storePath: 'C:\\Users\\PREVIEW\\AppData\\Roaming\\Grading_exam\\config.json',
  }),
  getLogHistory: async () => [
    { ts: now - 5200, level: 'info', message: '应用启动 · Grading_exam 0.1.0' },
    { ts: now - 4800, level: 'info', message: '已加载设置：模型 deepseek-v4，温度 0.20' },
    { ts: now - 4100, level: 'ok', message: '已打开阅卷窗口：https://YOUR_PLATFORM/exam/123' },
    { ts: now - 3600, level: 'warn', message: '元素拾取：题目区域尚未拾取，请先在页面上点击目标位置' },
    { ts: now - 2900, level: 'ok', message: '已拾取「题目区域」：x812 y364 · div' },
    { ts: now - 2100, level: 'info', message: '多次评分结果：6 / 6.5 / 6 → 取中位数 6/10；3 次运行结果接近（极差 0.5 分，中位数 6），差异在可接受范围。' },
    { ts: now - 1500, level: 'warn', message: '⚠ 系统性盲区（各次都漏）：单位' },
    { ts: now - 800, level: 'error', message: '第 2 次运行失败：TIMEOUT（网络类失败已自动重试 1 次）' },
  ],
  writeLog: async () => undefined,
  pickFile: async () => ({ canceled: false, paths: ['C:\\samples\\answer-01.png'] }),
  pickDir: async () => ({ canceled: false, path: 'C:\\exports' }),

  aiTest: async () => ({ ok: true, text: 'pong', usage: { prompt: 8, completion: 2, total: 10, costCNY: 0 }, diag: { model: 'deepseek-v4' } }),
  aiGrade: async () => ({ ok: true, text: '', usage: { prompt: 900, completion: 120, total: 1020, costCNY: 0.02 }, diag: { model: 'x' } }),
  aiGradeMulti: async () => ({ ok: true, text: '', usage: { prompt: 2700, completion: 360, total: 3060, costCNY: 0.06 }, diag: { model: 'x' } }),
  aiParsePaper: async () => ({ ok: true, text: '', usage: { prompt: 0, completion: 0, total: 0, costCNY: 0 }, diag: { model: 'x' } }),
  aiVisionAnswers: async () => ({ ok: true, text: '', usage: { prompt: 0, completion: 0, total: 0, costCNY: 0 }, diag: { model: 'x' } }),

  browserOpen: async () => ({ ok: true }),
  browserNavigate: async () => ({ ok: true }),
  browserClose: async () => ({ ok: true }),

  pickerStart: async () => ({ ok: true }),
  pickerCancel: async () => ({ ok: true }),
  pickerCoordinate: async () => ({ ok: true }),
  // 回显两项：题目区域 + 分数框已拾取，提交按钮未拾取，
  // 这样截图里能同时看到「已拾取」与「未拾取」两种视觉状态。
  pickerState: async () => ({
    picks: {
      questionRegion: {
        kind: 'questionRegion', mode: 'element', topX: 812, topY: 364,
        localX: 412, localY: 214, framePath: [], selector: 'role=group[name="第 3 题"]',
        candidates: [
          { kind: 'role', selector: 'role=group[name="第 3 题"]', score: 100 },
          { kind: 'testid', selector: '[data-testid="q3-body"]', score: 88 },
          { kind: 'css', selector: '.exam-question-body', score: 30 },
        ],
        width: 620, height: 180, tag: 'div', inIframe: false, pickedAt: now - 2900,
      },
      scoreInput: {
        kind: 'scoreInput', mode: 'element', topX: 1180, topY: 522,
        localX: 780, localY: 372, framePath: [], selector: 'role=spinbutton[name="得分"]',
        candidates: [
          { kind: 'role', selector: 'role=spinbutton[name="得分"]', score: 100 },
          { kind: 'label', selector: 'label="得分"', score: 92 },
          { kind: 'id', selector: '#a1b2c3d4e5f60718', score: 20 },
        ],
        width: 96, height: 32, tag: 'input', inIframe: false, pickedAt: now - 1800,
      },
    },
  }),
  captureQuestion: async () => ({ ok: true, base64: 'iVBORw0KGgoAAAANSUhEUg'.repeat(60) }),
  checkDrift: async () => ({ changed: false }),

  invoke: async () => ({ ok: false, error: '预览模式不支持该通道' }),

  onLog: () => () => undefined,
  onUsage: () => () => undefined,
  onPick: () => () => undefined,
  onProgress: () => () => undefined,
};

// 让自动化脚本能判断"界面确实水合成功了"，而不是只看截图猜
window.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    const root = document.getElementById('root');
    const ok = Boolean(root && root.children.length > 0);
    document.title = ok ? 'PREVIEW_RENDER_OK' : 'PREVIEW_RENDER_FAIL';
  }, 600);
});