/**
 * 稳定选择器生成器 —— 从 preload/viewer.ts 抽出的纯逻辑。
 *
 * 抽出来的理由：这段逻辑决定拾取能不能用，是整个 Phase 2 最该被测的部分；
 * 留在 preload 里只能靠真实 Electron 跑（而本机 Electron 起不来，见 BLOCKERS.md B3）。
 * 抽成纯模块后可用 jsdom 直接单测，不依赖 GUI。
 *
 * 设计取舍：
 *  - 优先 id → 语义化属性 → 稳定 class → nth-of-type 路径
 *  - **排除哈希类名**（css-xxxx / sc-xxx / 含 6 位以上十六进制），
 *    因为这类类名是构建工具生成的，平台一次发版就全变，比不用还糟
 *  - 路径最长 6 层，避免生成又长又脆的选择器
 */

const ESCAPE_MAP: Record<string, string> = {
  '\\': '\\\\',
  '.': '\\.',
  '#': '\\#',
  ':': '\\:',
  '[': '\\[',
  ']': '\\]',
  '>': '\\>',
  '+': '\\+',
  '~': '\\~',
  ' ': '\\ ',
  '"': '\\"',
  "'": "\\'",
};

/** CSS.escape 的降级实现（部分阅卷页的精简环境里没有） */
export function cssEscapeIdent(s: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
  return s.replace(/[\\.#:\[\]>+~ "']/g, (c) => ESCAPE_MAP[c] ?? c);
}

/**
 * 判断类名是否"稳定"（值得写进选择器）。
 * 排除 CSS-in-JS 与构建工具产物：它们形如 css-1a2b3c、sc-bdVaJa、含随机哈希。
 */
export function isStableClass(cls: string): boolean {
  if (!cls) return false;
  if (cls.length > 40) return false;
  if (/^(css-|sc-|jsx-|styled-)/i.test(cls)) return false;
  if (/[0-9a-f]{6,}/i.test(cls)) return false;
  if (/^[a-z]+-[0-9a-f]{4,}$/i.test(cls)) return false;
  return true;
}

/** 语义化属性优先：这类属性由业务代码写死，最稳定 */
export function attrSelector(el: Element): string | null {
  const attrs = ['data-testid', 'data-test', 'data-id', 'name', 'aria-label', 'placeholder'];
  for (const attr of attrs) {
    const v = el.getAttribute(attr);
    if (v && v.length <= 60) return `[${attr}="${v.replace(/"/g, '\\"')}"]`;
  }
  return null;
}

export interface BuildSelectorOptions {
  /** 用于判定唯一性的根；默认全局 document。jsdom 下可显式传入 */
  doc?: Document;
  /** 路径最大层数 */
  maxDepth?: number;
  /**
   * 是否优先向上寻找"稳定祖先锚点"（带 id 的祖先）。
   *
   * 为什么默认开启：只在自己不唯一时才向上找，会导致生成
   * `b.deep` 这种看似简洁、实则脆弱的路径——平台一改 CSS 就失效。
   * 若能找到带 id 的祖先，改写为 `#anchor > b.deep` 显著更稳，
   * 因为 id 通常由业务代码写死，不随构建产物变化。
   *
   * 代价：个别场景下选择器变长。用 maxAnchorDepth 限制搜索范围。
   */
  preferAncestorAnchor?: boolean;
  /** 向上搜索锚点的最大层数，默认 5（再深则 DOM 嵌套过深，收益递减） */
  maxAnchorDepth?: number;
}

export function buildSelector(el: Element, opts: BuildSelectorOptions = {}): string {
  const doc: Document | undefined = opts.doc ?? (typeof document !== 'undefined' ? document : undefined);
  const maxDepth = opts.maxDepth ?? 6;
  const preferAnchor = opts.preferAncestorAnchor ?? true;
  const maxAnchorDepth = opts.maxAnchorDepth ?? 5;

  const unique = (sel: string): boolean => {
    if (!doc) return false;
    try {
      return doc.querySelectorAll(sel).length === 1;
    } catch {
      return false; // 选择器语法错误（多为转义问题），视为不唯一
    }
  };

  // 1) 自身 id 最优
  if (el.id && !/^\d/.test(el.id) && el.id.length <= 80) {
    const sel = `#${cssEscapeIdent(el.id)}`;
    if (unique(sel)) return sel;
  }

  // 2) 向上找稳定祖先锚点：用较短路径拼成 `#anchor > 相对路径`
  if (preferAnchor) {
    let anc: Element | null = el.parentElement;
    let up = 0;
    while (anc && up < maxAnchorDepth) {
      if (anc.id && !/^\d/.test(anc.id) && anc.id.length <= 80) {
        const rel = relativePath(el, anc, maxDepth);
        if (rel) {
          const sel = `#${cssEscapeIdent(anc.id)} > ${rel}`;
          if (unique(sel)) return sel;
        }
        break; // 最近的可锚定祖先不成立，再往上收益有限
      }
      anc = anc.parentElement;
      up++;
    }
  }

  const parts: string[] = [];
  let cur: Element | null = el;

  while (cur && cur.nodeType === 1 && parts.length < maxDepth) {
    const tag = cur.tagName.toLowerCase();

    if (cur.id && !/^\d/.test(cur.id) && cur.id.length <= 80) {
      parts.unshift(`#${cssEscapeIdent(cur.id)}`);
      break;
    }

    const byAttr = attrSelector(cur);
    if (byAttr) {
      parts.unshift(`${tag}${byAttr}`);
      const sel = parts.join(' > ');
      if (unique(sel)) return sel;
      cur = cur.parentElement;
      continue;
    }

    const stableClasses = Array.from(cur.classList).filter(isStableClass).slice(0, 2);
    let part = tag + stableClasses.map((c) => `.${cssEscapeIdent(c)}`).join('');

    const parent: Element | null = cur.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
      if (sameTag.length > 1) {
        part += `:nth-of-type(${sameTag.indexOf(cur) + 1})`;
      }
    }

    parts.unshift(part);

    const sel = parts.join(' > ');
    if (unique(sel)) return sel;

    cur = parent;
  }

  return parts.join(' > ') || el.tagName.toLowerCase();
}

/**
 * 生成从 root 到 el 的相对路径（不含 root 自身），最多 limit 层。
 * 供 `#anchor > 相对路径` 使用。返回 null 表示层级超限或路径为空。
 */
function relativePath(el: Element, root: Element, limit: number): string | null {
  const segs: string[] = [];
  let cur: Element | null = el;

  while (cur && cur !== root) {
    if (segs.length >= limit) return null;
    const tag = cur.tagName.toLowerCase();
    const byAttr = attrSelector(cur);
    let seg: string;

    if (byAttr) {
      seg = `${tag}${byAttr}`;
    } else {
      const stable = Array.from(cur.classList).filter(isStableClass).slice(0, 2);
      seg = tag + stable.map((c) => `.${cssEscapeIdent(c)}`).join('');
      const parent: Element | null = cur.parentElement;
      if (parent && parent !== root) {
        const sameTag = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
        if (sameTag.length > 1) seg += `:nth-of-type(${sameTag.indexOf(cur) + 1})`;
      }
    }
    segs.unshift(seg);
    cur = cur.parentElement;
  }

  if (cur !== root) return null; // 未到达 root，说明层级过深
  return segs.length ? segs.join(' > ') : null;
}

/**
 * 判断选择器是否仍然唯一且能命中元素。
 * 用于 R11「平台页面结构变化」的检测（SPEC P2-11）。
 */
export function selectorStillValid(selector: string, doc?: Document): boolean {
  const d = doc ?? (typeof document !== 'undefined' ? document : undefined);
  if (!d) return false;
  try {
    return d.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
}

/**
 * 页面结构指纹 —— 对应 SPEC P2-11 / 调研 R11。
 *
 * 只对**拾取到的关键元素**（分数框、提交按钮）取指纹，而不是整页 DOM：
 * 整页指纹在含时间戳、随机 id 的页面上会频繁误报"结构已变"。
 *
 * 指纹内容：关键元素的选择器 + tagName + type + 关键属性。
 */
export function structureFingerprint(
  selectors: Record<string, string | null>,
  doc?: Document,
): string {
  const d = doc ?? (typeof document !== 'undefined' ? document : undefined);
  if (!d) return '';
  const bits: string[] = [];
  for (const key of Object.keys(selectors).sort()) {
    const sel = selectors[key];
    let el: Element | null = null;
    try {
      el = sel ? d.querySelector(sel) : null;
    } catch {
      el = null;
    }
    if (!el) {
      bits.push(`${key}:MISSING`);
      continue;
    }
    const attrs = ['type', 'name', 'data-testid', 'id']
      .map((a) => `${a}=${el!.getAttribute(a) ?? ''}`)
      .join(',');
    bits.push(`${key}:${el.tagName.toLowerCase()}|${attrs}`);
  }
  return bits.join(';');
}