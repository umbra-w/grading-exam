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
    // 与 AppInfo 真实结构保持一致（§7.4：假桥漂移编译期发现不了）。
    // 预览里演示"便携模式"，因为它最能体现这个字段的意义。
    storeSource: 'portable',
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
  // F3.4 假桥：返回 1 张真实可解码的 SVG 图（黑白条纹）——
  // 预览的 Edge 能真解码算出灰度统计，展示「可识别」徽标的真实分支。
  // 与 paperAggregate 假桥同一理由：真实形状才能让断言抓到字段名写错。
  readImages: async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48">' +
      '<rect width="64" height="48" fill="#ffffff"/><rect width="16" height="48" fill="#111111"/></svg>';
    return {
      ok: true,
      errors: [],
      images: [
        { fileName: 'answer-01.png', dataUrl: 'data:image/svg+xml;base64,' + btoa(svg), bytes: 1284 },
      ],
    };
  },

  aiTest: async () => ({ ok: true, text: 'pong', usage: { prompt: 8, completion: 2, total: 10, costCNY: 0 }, diag: { model: 'deepseek-v4' } }),
  aiGrade: async () => ({ ok: true, text: '', usage: { prompt: 900, completion: 120, total: 1020, costCNY: 0.02 }, diag: { model: 'x' } }),
  aiGradeMulti: async () => ({ ok: true, text: '', usage: { prompt: 2700, completion: 360, total: 3060, costCNY: 0.06 }, diag: { model: 'x' } }),
  aiParsePaper: async () => ({ ok: true, text: '', usage: { prompt: 0, completion: 0, total: 0, costCNY: 0 }, diag: { model: 'x' } }),
  aiExtractRubric: async () => ({
    ok: true,
    rubric: {
      stem: '题目题干',
      questionType: 'short',
      fullScore: 10,
      referenceAnswer: '参考答案',
      scoringPoints: ['得分点1: 5分', '得分点2: 5分'],
    },
    usage: { prompt: 0, completion: 0, total: 0, costCNY: 0 },
  }),
  aiExtractRubric: async () => ({
    ok: true,
    rubric: {
      stem: '题目题干',
      questionType: 'short',
      fullScore: 10,
      referenceAnswer: '参考答案',
      scoringPoints: ['得分点1: 5分', '得分点2: 5分'],
    },
    usage: { prompt: 0, completion: 0, total: 0, costCNY: 0 },
  }),
  aiVisionAnswers: async () => ({ ok: true, text: '', usage: { prompt: 0, completion: 0, total: 0, costCNY: 0 }, diag: { model: 'x' } }),

  browserOpen: async () => ({ ok: true }),
  browserNavigate: async () => ({ ok: true }),
  windowCompact: async (enable) => ({ ok: true, isCompact: Boolean(enable) }),
  recoveryCheck: async () => ({ hasCrash: false }),
  recoverySave: async () => ({ ok: true }),
  recoveryClear: async () => ({ ok: true }),
  browserClose: async () => ({ ok: true }),
  windowCompact: async (enable) => ({ ok: true, isCompact: Boolean(enable) }),
  recoveryCheck: async () => ({ hasCrash: false }),
  recoverySave: async () => ({ ok: true }),
  recoveryClear: async () => ({ ok: true }),

  pickerStart: async () => ({ ok: true }),
  pickerCancel: async () => ({ ok: true }),
  pickerCoordinate: async () => ({ ok: true }),
  // 回显两项：题目区域 + 分数框已拾取，提交按钮未拾取，
  // 这样截图里能同时看到「已拾取」与「未拾取」两种视觉状态。
  pickerState: async () => ({
    // BrowserStateSnapshot 的完整形状。缺字段会让面板读到 undefined 而不报错——
    // 之前这里就漏了 open/url/kernel/pendingPick，面板显示的窗口状态是假的。
    open: true,
    url: 'https://platform.example.com/grading/paper/12345',
    kernel: 'chrome',
    pendingPick: null,
    fingerprint: 'preview-fingerprint-0000',
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

  // ⚠ 这里**刻意不提供 invoke 逃生口**：真实的 Window 类型是
  // `Omit<typeof api, 'invoke'>`，渲染层拿不到任意通道的调用能力。
  // 假桥比真桥多出这个能力，就会让"渲染层绕过契约"的代码在预览里跑通、
  // 到真机上才炸 —— 预览的职责是复现真实约束，不是放宽它。

  onLog: () => () => undefined,
  onUsage: () => () => undefined,
  onPick: () => () => undefined,
  onProgress: () => () => undefined,
  onBrowserClosed: () => () => undefined,
  onAwaitConfirm: () => () => undefined,

  // Phase 4：解析与导出。返回**真实形状**的假结果，
  // 让界面能渲染出"解析成功 + 警告"和"解析失败 + 原因"两种状态。
  parseFile: async (filePath) => {
    const name = String(filePath || '').split(/[\\/]/).pop() || 'unknown.txt';
    if (name.endsWith('.pdf')) {
      // 演示失败分支：界面必须能显示原因码与中文说明
      return {
        ok: false, name, ext: '.pdf', code: 'SCANNED_PDF',
        message: '这个 PDF 共 12 页，几乎提取不到文字，应该是扫描件或整页图片。本软件不做 OCR。',
      };
    }
    return {
      ok: true, name, ext: '.docx', charCount: 1284, pageCount: 4,
      text: '一、选择题（每题 3 分）\n1. 下列关于碳酸钙的说法正确的是（ ）\n...',
      warnings: [{ code: 'PARTIAL_TEXT', message: '有 1 页没有提取到文字（可能是图片页），请核对。' }],
    };
  },
  exportExcel: async (p) => ({ ok: true, path: String(p?.outPath || 'C:\\exports\\report.xlsx') }),
  exportMarkdown: async (p) => ({ ok: true, path: String(p?.outPath || 'C:\\exports\\report.md') }),

  /*
   * 整卷聚合的假实现。刻意返回**一份真实的报告形状**（含 null 统计），
   * 而不是空对象：界面若字段名写错，空对象会让它静默显示占位，
   * 真实形状才能让 ui:verify 的文案断言抓到问题。
   */
  paperAggregate: async (p) => {
    const results = Array.isArray(p?.results) ? p.results : [];
    const count = results.length;
    return {
      paperId: String(p?.paperId || 'DEMO'),
      paperTitle: String(p?.paperTitle || '预览试卷'),
      results,
      stats: {
        count,
        average: count > 0 ? 22 : null,
        max: count > 0 ? 22 : null,
        min: count > 0 ? 22 : null,
        passRate: count > 0 ? 1 : null,
        fullTotal: 25,
        mixedFullScore: false,
        numberValid: true,
        distribution: [
          { bucket: '0~59%', count: 0 },
          { bucket: '60~69%', count: 0 },
          { bucket: '70~79%', count: 0 },
          { bucket: '80~89%', count: 0 },
          { bucket: '90~100%', count },
        ],
        lossRanking: [],
        byType: [{ type: 'calc', count: 1, avgScoreRate: 0.9, reviewRate: 0 }],
      },
      generatedAt: Date.now(),
    };
  },

  /* ---- AI ---- */
  // ⚠ AICallResult 的字段名：诊断信息叫 `diag`（不是 diagnostic），
  // 评分类结构化结果叫 `grade`（不是 result）。写错不报错，
  // 只是读出来永远是 undefined —— 这正是本轮修过的一类缺陷。
  aiGrade: async () => ({
    ok: true,
    text: '{"score":8,"confidence":0.86}',
    usage: { promptTokens: 812, completionTokens: 168, totalTokens: 980 },
    diag: { model: 'preview-model', finishReason: 'stop', httpStatus: 200, thinkingDisabled: true },
    grade: {
      score: 8,
      comment:
        'M(CaCO₃) = 40 + 12 + 16×3 = 100 g/mol 的计算完全正确，也标注了单位。' +
        '但式中 16×3 未单独写出，扣 2 分。',
      hitPoints: ['写出相对原子质量求和式', '结果 100 正确', '标注了单位 g/mol'],
      missedPoints: ['未单独写出 16×3 = 48 这一步'],
      confidence: 0.86,
      reviewRequested: false,
      warnings: ['模型把「相对分子质量」说成了「摩尔质量」，术语已在校验中纠正'],
      promptVersion: 'p1',
      promptHash: 'a1b2c3d4e5f60718',
    },
  }),

  aiParsePaper: async () => ({
    ok: true,
    text: '{"questions":[]}',
    usage: { promptTokens: 1240, completionTokens: 420, totalTokens: 1660 },
    diag: { model: 'preview-model', finishReason: 'stop', httpStatus: 200 },
    data: { questions: [] },
  }),

  // 多次运行（自一致性）：界面要能看出"模型自己都不一致"的证据
  aiGradeMulti: async () => ({
    ok: true,
    text: '{}',
    usage: { promptTokens: 2400, completionTokens: 500, totalTokens: 2900 },
    diag: { model: 'preview-model', finishReason: 'stop' },
    grade: {
      score: 8,
      comment: '三次运行结果一致。',
      hitPoints: ['写出求和式'],
      missedPoints: ['未写出 16×3'],
      confidence: 0.86,
      reviewRequested: false,
      warnings: [],
      promptVersion: 'p1',
      promptHash: 'a1b2c3d4e5f60718',
      ensemble: {
        runs: 3,
        scores: [8, 8, 7.5],
        disagreement: 0.05,
        agreement: 'consistent',
        commonMisses: ['未写出 16×3'],
        contradictoryPoints: [],
      },
    },
  }),

  aiExtractRubric: async () => ({
    ok: true,
    rubric: {
      stem: '题目题干',
      questionType: 'short',
      fullScore: 10,
      referenceAnswer: '参考答案',
      scoringPoints: ['得分点1: 5分', '得分点2: 5分'],
    },
    usage: { prompt: 0, completion: 0, total: 0, costCNY: 0 },
  }),
  aiVisionAnswers: async () => ({
    ok: true,
    text: '{}',
    usage: { promptTokens: 3200, completionTokens: 300, totalTokens: 3500 },
    diag: { model: 'preview-vision', finishReason: 'stop' },
    data: { answers: [] },
  }),

  aiTest: async () => ({
    ok: true,
    text: 'pong',
    usage: { promptTokens: 8, completionTokens: 2, totalTokens: 10 },
    diag: { model: 'preview-model', finishReason: 'stop', httpStatus: 200 },
  }),

  /* ---- 客观题本地比对（零网络零 token） ---- */
  // 特意演示 suspect 分支：学生写了选项内容而不是字母。
  // 真实实现里这个分支**不给分且要求人工确认**，界面必须能看到它，
  // 否则这个最容易被忽略的分支就永远没被人看过。
  compareObjective: async () => ({
  /*
   * 连续阅卷（Phase 5）。预览里这三个方法**只做假响应**：
   *   · auto:start 返回 ok:true，让面板切到"运行中"的样子
   *   · auto:stop / auto:confirm 返回 ok:true
   * 注意：预览**不模拟 evt:progress 推送**，所以"运行中 N 份"
   * 在预览里会停在 0 份——这是刻意留白，不假装预览能演示进度。
   */
  autoStart: async () => ({ ok: true }),
  autoStop: async () => ({ ok: true }),
  autoConfirm: async () => ({ ok: true }),
    verdict: 'suspect',
    awarded: false,
    normalized: '碳酸钙的摩尔质量',
    expected: 'B',
    reason: '学生填写的是选项内容而非选项字母，无法自动确认对应关系，需人工核对。',
    needsReview: true,
  }),

  /*
   * ---- 复核队列（P1-8） ----
   *
   * 刻意造出**四种状态各一条**，并摆出两个最有价值的边界：
   *   · corrected：模型分 5 → 当前分 6。界面必须同时显示两个数，否则
   *     "老师改之前模型给了几分"这个唯一可回溯的证据就看不到了
   *   · pending 且理由有三条：验证多理由标签与警示的就地显示
   * 假数据覆盖不到的分支，在预览里永远没人看过。
   */
  reviewQueue: async () => ({
    items: [
      {
        id: 'P1::第17题',
        paperId: 'P1',
        questionNo: '第17题',
        subject: '数学',
        createdAt: Date.now() - 3600000,
        updatedAt: Date.now() - 1800000,
        original: {
          score: 5,
          comment: '步骤基本完整，单位换算有误',
          hitPoints: ['列方程', '求解正确'],
          missedPoints: ['单位换算'],
          confidence: 0.62,
          reviewRequested: true,
          warnings: [],
          promptVersion: 'v1',
          promptHash: 'demo',
        },
        effective: {
          score: 6,
          comment: '步骤基本完整，单位换算有误',
          hitPoints: ['列方程', '求解正确', '单位换算'],
          missedPoints: [],
          confidence: 0.62,
          reviewRequested: false,
          warnings: [],
          promptVersion: 'v1',
          promptHash: 'demo',
        },
        reasons: ['low_confidence', 'extreme_score'],
        status: 'corrected',
        history: [
          {
            at: Date.now() - 1800000,
            by: '张老师',
            fromScore: 5,
            toScore: 6,
            markedHit: ['单位换算'],
            markedMissed: [],
            note: '单位换算正确，应给分',
          },
        ],
        fullScore: 6,
      },
      {
        id: 'P1::第18题',
        paperId: 'P1',
        questionNo: '第18题',
        subject: '数学',
        createdAt: Date.now() - 600000,
        updatedAt: Date.now() - 600000,
        original: {
          score: 4,
          comment: '思路方向正确但结论缺失',
          hitPoints: ['设未知数'],
          missedPoints: ['列不等式', '得出结论'],
          confidence: 0.48,
          reviewRequested: true,
          warnings: ['score 字段是字符串 "4"，已转换为数字'],
          promptVersion: 'v1',
          promptHash: 'demo',
        },
        effective: {
          score: 4,
          comment: '思路方向正确但结论缺失',
          hitPoints: ['设未知数'],
          missedPoints: ['列不等式', '得出结论'],
          confidence: 0.48,
          reviewRequested: true,
          warnings: ['score 字段是字符串 "4"，已转换为数字'],
          promptVersion: 'v1',
          promptHash: 'demo',
        },
        reasons: ['low_confidence', 'output_warnings', 'ensemble_disagreement'],
        status: 'pending',
        history: [],
        fullScore: 8,
      },
      {
        id: 'P1::第19题',
        paperId: 'P1',
        questionNo: '第19题',
        subject: '数学',
        createdAt: Date.now() - 900000,
        updatedAt: Date.now() - 300000,
        original: {
          score: 3,
          comment: '仅写出公式',
          hitPoints: ['写出公式'],
          missedPoints: ['代入计算'],
          confidence: 0.88,
          reviewRequested: false,
          warnings: [],
          promptVersion: 'v1',
          promptHash: 'demo',
        },
        effective: {
          score: 3,
          comment: '仅写出公式',
          hitPoints: ['写出公式'],
          missedPoints: ['代入计算'],
          confidence: 0.88,
          reviewRequested: false,
          warnings: [],
          promptVersion: 'v1',
          promptHash: 'demo',
        },
        reasons: ['model_requested'],
        status: 'confirmed',
        history: [
          {
            at: Date.now() - 300000,
            by: '',
            fromScore: 3,
            toScore: 3,
            markedHit: [],
            markedMissed: [],
            note: '人工确认模型结果正确',
          },
        ],
        fullScore: 10,
      },
      {
        id: 'P1::第20题',
        paperId: 'P1',
        questionNo: '第20题',
        subject: '数学',
        createdAt: Date.now() - 1200000,
        updatedAt: Date.now() - 900000,
        original: {
          score: 0,
          comment: '未作答',
          hitPoints: [],
          missedPoints: ['全部'],
          confidence: 0.55,
          reviewRequested: true,
          warnings: [],
          promptVersion: 'v1',
          promptHash: 'demo',
        },
        effective: {
          score: 0,
          comment: '未作答',
          hitPoints: [],
          missedPoints: ['全部'],
          confidence: 0.55,
          reviewRequested: false,
          warnings: [],
          promptVersion: 'v1',
          promptHash: 'demo',
        },
        reasons: ['extreme_score'],
        status: 'excluded',
        history: [
          {
            at: Date.now() - 900000,
            by: '张老师',
            fromScore: 0,
            toScore: 0,
            markedHit: [],
            markedMissed: [],
            note: '该生缺考，本题不计入统计',
          },
        ],
        fullScore: 10,
      },
    ],
    stats: {
      total: 4,
      pending: 1,
      corrected: 1,
      confirmed: 1,
      excluded: 1,
      // 1 修正 / (1 修正 + 1 确认) = 0.5
      correctionRate: 0.5,
      netScoreDelta: 1,
    },
    // 刻意给非零值：验证"队列可能不完整"这条警告在预览里真的会被渲染。
    // 若恒为 0，这条警告永远没人看过。
    invalidDropped: 1,
  }),
  reviewCorrect: async () => ({ ok: true, warnings: [] }),
  reviewVerdict: async () => ({ ok: true }),
  reviewRemove: async () => ({ ok: true, removed: 1 }),
};

// 让自动化脚本能判断"界面确实水合成功了"，而不是只看截图猜
window.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    const root = document.getElementById('root');
    const ok = Boolean(root && root.children.length > 0);
    document.title = ok ? 'PREVIEW_RENDER_OK' : 'PREVIEW_RENDER_FAIL';
  }, 600);
});