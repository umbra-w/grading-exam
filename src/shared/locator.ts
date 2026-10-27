/**
 * 韧性选择器候选器 —— 按 Playwright 官方优先级生成"多候选 + 韧性评分"。
 *
 * 为什么重写成"候选列表"而不是"一个选择器"：
 *   Playwright 官方文档的结论是——为让定位有韧性，应优先使用**用户可见属性**
 *   （role / label / text）与显式契约（testid），把 CSS/XPath 列为"实在没别的
 *   办法才用"。参考：https://playwright.dev/dotnet/docs/locators
 *
 *   但用测试框架时的前提是「人要写对」。我们没法要求用户懂这个，所以改为：
 *   程序一次生成**全部可用候选**并各自打韧性分，运行时从上往下试着用。
 *   这样既吃到官方优先级的好处，又不用人判断。
 *
 * 关键收益（本模块的核心取舍）：
 *   把"排序对不对"从运行时问题变成了**纯函数问题**。原实现只有一个选择器，
 *   排序错了只能等平台改版后才发现；现在排序可以被单测直接钉死。
 *
 * 运行时用法：
 *   1. 拾取时生成候选列表并存入 PickResult
 *   2. 填分/点击前按 score 从高到低，选第一个**能唯一命中**的候选
 *   3. 全都命中不了 → 判定改版，暂停并提示重新拾取
 */

/* ------------------------------------------------------- 可访问名 */

const LABELLABLE = new Set(['input', 'select', 'textarea', 'button', 'meter', 'output', 'progress']);

/** 取元素的可访问名（Accessible Name）——Playwright 按 role 定位时的核心依据 */
export function accessibleName(el: Element): string {
  const tag = el.tagName.toLowerCase();

  // 1. aria-label 直接给出
  const aria = el.getAttribute('aria-label');
  if (aria && aria.trim()) return normalize(aria);

  // 2. aria-labelledby → 按 id 取引用元素的文本（可多个，按顺序拼接）
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const texts = labelledBy
      .split(/\s+/)
      .map((id) => el.ownerDocument?.getElementById(id)?.textContent ?? '')
      .filter(Boolean);
    if (texts.length > 0) return normalize(texts.join(' '));
  }

  // 3. 原生 label（仅可标注元素）——label[for] 与 label 包裹两种写法
  if (LABELLABLE.has(tag)) {
    const wrapped = el.closest('label');
    if (wrapped?.textContent?.trim()) return normalize(wrapped.textContent);

    // 直接遍历 label 比对 for 属性，不用 querySelector 拼属性选择器。
    // 原因：id 里可能含 `.` `:` 等字符，拼进属性选择器需要转义，
    // 而转义实现在跨环境（jsdom / 精简 webview）行为不一致，
    // 容易出现"看着对但匹配不到"的静默失败。遍历没有这个问题。
    const id = el.getAttribute('id');
    if (id) {
      const labels = el.ownerDocument?.querySelectorAll('label') ?? [];
      for (const lab of Array.from(labels)) {
        if (lab.getAttribute('for') === id && lab.textContent?.trim()) {
          return normalize(lab.textContent);
        }
      }
    }
  }

  // 4. placeholder 作为退化名（表单控件常见且稳定）
  const ph = el.getAttribute('placeholder');
  if (ph && ph.trim()) return normalize(ph);

  // 5. title 作为退化
  const title = el.getAttribute('title');
  if (title && title.trim()) return normalize(title);

  // 6. 自身文本。
  //
  // 这一步对**按钮/链接**同样适用，不只是 div/span：
  // 按钮文本（"提交答卷"）是页面上最稳的定位依据之一，产品很少改。
  // 早先只在非可标注元素上取文本，等于丢掉了最有价值的 role 候选——
  // 表现为 role=button 拿不到 name，评分被扣 40，退化到脆弱的 CSS 路径。
  const own = el.textContent;
  if (own && own.trim() && normalize(own).length <= 120) return normalize(own);

  return '';
}

/** 文本归一化：与 Playwright 一致——多空格合并、换行转空格、去首尾空白 */
export function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * 只取"真正的标签名"：aria-label / aria-labelledby / 原生 label。
 *
 * 为什么不能直接用 accessibleName()：可访问名会退化到 placeholder 与 title，
 * 但 Playwright 的 `label=` 定位**只认标签**。若用可访问名生成 label=，
 * 遇到只有 placeholder 的输入框会生成一个永远匹配不到的选择器——
 * 这是最坏的一类 bug：不报错，只是静默失效。
 */
export function labelText(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria?.trim()) return normalize(aria);

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => el.ownerDocument?.getElementById(id)?.textContent ?? '')
      .filter(Boolean);
    if (parts.length > 0) return normalize(parts.join(' '));
  }

  if (LABELLABLE.has(el.tagName.toLowerCase())) {
    const wrapped = el.closest('label');
    if (wrapped?.textContent?.trim()) return normalize(wrapped.textContent);

    const id = el.getAttribute('id');
    if (id) {
      const labels = el.ownerDocument?.querySelectorAll('label') ?? [];
      for (const lab of Array.from(labels)) {
        if (lab.getAttribute('for') === id && lab.textContent?.trim()) {
          return normalize(lab.textContent);
        }
      }
    }
  }

  return '';
}

/* --------------------------------------------------------- 候选 */

export type CandidateKind =
  | 'role'
  | 'label'
  | 'placeholder'
  | 'text'
  | 'testid'
  | 'id'
  | 'attr'
  | 'css';

export interface SelectorCandidate {
  kind: CandidateKind;
  /** 选择器字符串（`role=button[name="提交"]` / `#id` / `.cls` 等） */
  selector: string;
  /**
   * 韧性评分 0~100，**越高越抗改版**。
   * 依据 Playwright 官方优先级排序，并对"看起来唯一但其实脆弱"的形式扣分。
   */
  score: number;
}

/**
 * 各定位方式的基准分。
 * 顺序取自 Playwright 官方推荐；扣分规则见 scoreCandidate()。
 */
const BASE_SCORE: Record<CandidateKind, number> = {
  role: 100,
  label: 92,
  testid: 88,
  placeholder: 80,
  text: 70,
  id: 60,
  attr: 50,
  css: 30,
};

/**
 * 计算候选择性分，**可低于 0**。
 *
 * 两个独立的扣分维度，刻意分开：
 *  - **定位方式**（kind）：决定基准分，反映"这类定位方式多抗改版"
 *  - **路径深度**（depth）：只在真实 DOM 元素上才有意义
 *
 * 为什么分开：早先给深度设了默认值，导致 `scoreCandidate(cand('text','x'))`
 * 这样不传深度的调用也被扣了 12 分，不同 kind 之间就**不可比**了——
 * 排序正确性根本无法断言。现在 depth 默认 0（不扣），
 * 真实候选由 selectorCandidates 显式传入实际深度。
 *
 * 下界为什么不是 0：扣分累加后若钳到 0，多个"都很糟"的候选会并列同分，
 * 排序失去区分度。允许负分才保住相对次序。上界 100 便于阅读。
 */
export function scoreCandidate(cand: SelectorCandidate, depth = 0): number {
  let s = BASE_SCORE[cand.kind] ?? 20;

  // 路径深度惩罚：每层 -6，6 层封顶（再深收益递减且几乎必然脆）
  if (depth > 0) s -= Math.min(depth, 6) * 6;

  const sel = cand.selector;

  // 结构位置依赖
  if (/:nth-child|:nth-of-type|:first-child|:last-child/.test(sel)) s -= 25;

  // 构建产物类名
  if (/\.(css|sc|jsx|styled)-[a-z0-9]/i.test(sel)) s -= 20;
  if (/\.[a-z]+-[0-9a-f]{6,}/i.test(sel)) s -= 20;

  // role 候选：可访问名是它的价值所在，无名则几乎没用
  if (cand.kind === 'role') {
    const m = /\[name="([^"]*)"\]/.exec(sel);
    const label = m?.[1] ?? '';
    if (label.length === 0) s -= 40; // 无名 role 只能靠标签名区分，几乎没用
    else if (label.length > 40) s -= 8; // 长文案易被改动或截断
  }

  // 属性型候选：name/id 由业务写死较稳，但动态生成的自增 id 不可信
  if (cand.kind === 'id' || cand.kind === 'attr') {
    // -40 而非 -25：形如 #a1b2c3d4e5f60718 的 id 几乎必然每次构建都变，
    // 等于"一定会失效"，应比一个语义清晰的 class 更不可信。
    if (/[0-9a-f]{8,}/i.test(sel)) s -= 40; // 疑似 uuid / 哈希
    if (/[-_]\d{4,}\b/.test(sel)) s -= 15; // 疑似自增序号
  }

  return Math.max(-50, Math.min(100, s));
}

/* ------------------------------------------------------- 生成 */

/** role=... 语法：带 name 时更精确 */
function roleSelector(el: Element): { selector: string; depth: number } | null {
  const raw = (el.getAttribute('role') ?? implicitRole(el)).trim();
  if (!raw) return null;

  const name = accessibleName(el);
  // 无名的非唯一 role 意义不大，但仍作为候选保留（运行时按唯一性筛掉）
  if (!name) return { selector: `role=${raw}`, depth: 1 };

  const escaped = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return { selector: `role=${raw}[name="${escaped}"]`, depth: 1 };
}

/**
 * 隐式 ARIA 角色 —— 只覆盖阅卷页面真正会出现的元素类型。
 * 不追求 HTML-AAM 完整实现：覆盖不到的返回 null，退化到 CSS 候选即可，
 * 不影响正确性（只是少一个更优候选）。
 */
export function implicitRole(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') ?? '').toLowerCase();

  switch (tag) {
    case 'button':
      return 'button';
    case 'select':
      return el.hasAttribute('multiple') ? 'listbox' : 'combobox';
    case 'textarea':
      return 'textbox';
    case 'a':
      return el.hasAttribute('href') ? 'link' : '';
    case 'img':
      return 'img';
    case 'table':
      return 'table';
    case 'input':
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      if (type === 'search') return 'searchbox';
      if (type === 'number') return 'spinbutton';
      if (type === 'range') return 'slider';
      if (type === 'file') return '';
      return 'textbox';
    default:
      if (el.hasAttribute('role')) return el.getAttribute('role') ?? '';
      return '';
  }
}

/**
 * 生成全部候选并按韧性降序排列。
 *
 * 注意**不做唯一性过滤**：唯一性需要真实 DOM 查询，而那是运行时的事。
 * 本函数是纯逻辑，只负责"有哪些可用定位方式、谁更稳"。
 * 运行时按 score 从高到低，取第一个唯一命中的候选。
 */
export function selectorCandidates(el: Element): SelectorCandidate[] {
  const out: SelectorCandidate[] = [];

  const push = (kind: CandidateKind, selector: string | null, depth = 0): void => {
    if (!selector) return;
    if (out.some((c) => c.selector === selector)) return; // 去重
    out.push({ kind, selector, score: scoreCandidate({ kind, selector, score: 0 }, depth) });
  };

  // 1) role + 可访问名（Playwright 官方首选）
  const role = roleSelector(el);
  if (role) push('role', role.selector, role.depth);

  // 2) label（表单控件最自然的定位方式）——只认真正的标签，不退化到 placeholder
  if (LABELLABLE.has(el.tagName.toLowerCase())) {
    const name = labelText(el);
    if (name) push('label', `label=${escapeName(name)}`, 1);
  }

  // 3) placeholder
  const ph = el.getAttribute('placeholder');
  if (ph?.trim()) push('placeholder', `placeholder=${escapeName(normalize(ph))}`, 1);

  // 4) text（非交互元素的稳定文本）
  if (!LABELLABLE.has(el.tagName.toLowerCase())) {
    const own = el.textContent;
    if (own?.trim() && normalize(own).length <= 60) push('text', `text=${escapeName(normalize(own))}`, 1);
  }

  // 5) testid 类显式契约
  for (const attr of ['data-testid', 'data-test', 'data-cy', 'data-qa']) {
    const v = el.getAttribute(attr);
    if (v) push('testid', `[${attr}="${escapeAttr(v)}"]`, 1);
  }

  // 6) id / 稳定语义属性
  const id = el.getAttribute('id');
  if (id && id.length <= 80 && !/^\d/.test(id)) push('id', `#${cssEscapeIdentLocal(id)}`, 1);

  for (const attr of ['name', 'aria-label']) {
    const v = el.getAttribute(attr);
    if (v && v.length <= 60) push('attr', `[${attr}="${escapeAttr(v)}"]`, 1);
  }

  // 7) CSS 兜底（复用已有的稳定路径生成器）
  push('css', cssFallback(el), 3);

  return out.sort((a, b) => b.score - a.score);
}

/** CSS 兜底：本模块不重复实现，交给 selector.ts 的 buildSelector */
function cssFallback(el: Element): string | null {
  const tag = el.tagName.toLowerCase();

  // 稳定的 class 优先
  const classes = (el.getAttribute('class') ?? '')
    .split(/\s+/)
    .filter((c) => c && isStableClassLocal(c));
  if (classes.length > 0) return `${tag}.${classes.map(cssEscapeIdentLocal).join('.')}`;

  // 退化为标签名（运行时靠唯一性筛选，不唯一则不用）
  return tag;
}

function escapeName(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function escapeAttr(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// 与 selector.ts 保持一致的类名稳定性判定（此处内联以免循环依赖）
function isStableClassLocal(cls: string): boolean {
  if (!cls || cls.length > 40) return false;
  if (/^(css-|sc-|jsx-|styled-)/i.test(cls)) return false;
  if (/[0-9a-f]{6,}/i.test(cls)) return false;
  if (/^[a-z]+-[0-9a-f]{4,}$/i.test(cls)) return false;
  return true;
}

function cssEscapeIdentLocal(s: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
  return s.replace(/[\\.#:\[\]>+~ "']/g, (c) => `\\${c}`);
}

/* ------------------------------------------------- 运行时解析辅助 */

/**
 * 把候选择性分解读成"能否用 querySelector 解析"。
 * 只有 CSS 可解析的 kind 才支持直接 querySelector；
 * role=/label=/text= 需要专门的解析器（浏览器侧用专用实现）。
 *
 * 这个划分很重要：**不要把 role= 语法误当 CSS 传给 querySelector**——
 * 会抛异常，而捕获后当成"不命中"就变成静默失效。
 */
export function isCssResolvable(cand: SelectorCandidate): boolean {
  return cand.kind === 'css' || cand.kind === 'id' || cand.kind === 'attr' || cand.kind === 'testid';
}

/**
 * 选一个候选作为主选择器（用于展示、持久化与结构指纹）。
 * 取评分最高者；若最高的是 role 而环境不支持 role 解析，则退到可 CSS 解析的最优项。
 */
export function primarySelector(cands: SelectorCandidate[], opts: { cssOnly?: boolean } = {}): SelectorCandidate | null {
  const pool = opts.cssOnly ? cands.filter(isCssResolvable) : cands;
  return pool.length > 0 ? pool[0]! : null;
}

/** 候选列表的稳定指纹：用于结构漂移比对（只取各候选的 kind + selector） */
export function candidatesFingerprint(cands: SelectorCandidate[]): string {
  return cands.map((c) => `${c.kind}:${c.selector}`).join(';');
}