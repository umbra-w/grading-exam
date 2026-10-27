// @vitest-environment jsdom
/**
 * 韧性选择器候选器单测。
 *
 * 这组测试的价值在于：**把"排序对不对"钉死**。
 * 原实现只有一个选择器，排序错了只能等平台改版后才发现；
 * 现在排序是纯函数输出，可以直接断言。
 *
 * 依据：Playwright 官方 locator 优先级
 * https://playwright.dev/dotnet/docs/locators
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  accessibleName,
  normalize,
  implicitRole,
  selectorCandidates,
  scoreCandidate,
  isCssResolvable,
  primarySelector,
  candidatesFingerprint,
  type SelectorCandidate,
} from '../src/shared/locator';

function mount(html: string): Document {
  const doc = document.implementation.createHTMLDocument('t');
  doc.documentElement.innerHTML = `<body>${html}</body>`;
  return doc;
}

function cand(kind: SelectorCandidate['kind'], selector: string): SelectorCandidate {
  return { kind, selector, score: 0 };
}

/* --------------------------------------------------- 可访问名 */

describe('accessibleName —— 按 ARIA 规范的优先级取名', () => {
  it('aria-label 最优先', () => {
    const doc = mount('<button aria-label="提交答卷">提交</button>');
    expect(accessibleName(doc.querySelector('button')!)).toBe('提交答卷');
  });

  it('aria-labelledby 按 id 引用取文本', () => {
    const doc = mount('<span id="l1">分数</span><input aria-labelledby="l1" type="number">');
    expect(accessibleName(doc.querySelector('input')!)).toBe('分数');
  });

  it('★ aria-labelledby 多个 id 按顺序拼接', () => {
    const doc = mount('<span id="a">本题</span><span id="b">得分</span><input aria-labelledby="a b">');
    expect(accessibleName(doc.querySelector('input')!)).toBe('本题 得分');
  });

  it('label[for] 关联', () => {
    const doc = mount('<label for="sc">得分</label><input id="sc" type="number">');
    expect(accessibleName(doc.querySelector('input')!)).toBe('得分');
  });

  it('label 包裹写法', () => {
    const doc = mount('<label>得分 <input type="number"></label>');
    expect(accessibleName(doc.querySelector('input')!)).toBe('得分');
  });

  it('placeholder 作为退化名', () => {
    const doc = mount('<input type="number" placeholder="请输入分数">');
    expect(accessibleName(doc.querySelector('input')!)).toBe('请输入分数');
  });

  it('title 作为最后退化', () => {
    const doc = mount('<input type="number" title="分数框">');
    expect(accessibleName(doc.querySelector('input')!)).toBe('分数框');
  });

  it('非交互元素用自身文本', () => {
    const doc = mount('<div class="stem">第 1 题 求导</div>');
    expect(accessibleName(doc.querySelector('div')!)).toBe('第 1 题 求导');
  });

  it('★ 无比名时返回空串（不是抛异常，也不是编一个）', () => {
    const doc = mount('<input type="number">');
    expect(accessibleName(doc.querySelector('input')!)).toBe('');
  });

  it('空白 aria-label 视为无值，继续退化', () => {
    const doc = mount('<input aria-label="   " placeholder="真名">');
    expect(accessibleName(doc.querySelector('input')!)).toBe('真名');
  });
});

describe('normalize —— 与 Playwright 一致的文本归一化', () => {
  it('多空格合并', () => {
    expect(normalize('a    b')).toBe('a b');
  });

  it('换行转空格并去首尾', () => {
    expect(normalize('\n  提交\n答卷  \n')).toBe('提交 答卷');
  });

  it('制表符也归一化', () => {
    expect(normalize('a\t\tb')).toBe('a b');
  });
});

/* ----------------------------------------------------- 隐式角色 */

describe('implicitRole —— 覆盖阅卷页会出现的元素', () => {
  it('常见表单控件', () => {
    const cases: Array<[string, string]> = [
      ['<button>x</button>', 'button'],
      ['<input type="number">', 'spinbutton'],
      ['<input type="text">', 'textbox'],
      ['<input type="checkbox">', 'checkbox'],
      ['<input type="radio">', 'radio'],
      ['<input type="submit">', 'button'],
      ['<textarea></textarea>', 'textbox'],
      ['<select></select>', 'combobox'],
      ['<select multiple></select>', 'listbox'],
    ];
    for (const [html, expected] of cases) {
      const doc = mount(html);
      expect(implicitRole(doc.body.firstElementChild!), html).toBe(expected);
    }
  });

  it('★ 显式 role 属性优先于隐式', () => {
    const doc = mount('<div role="button">提交</div>');
    expect(implicitRole(doc.querySelector('div')!)).toBe('button');
  });

  it('input[type=file] 无角色（不猜）', () => {
    const doc = mount('<input type="file">');
    expect(implicitRole(doc.querySelector('input')!)).toBe('');
  });

  it('无 href 的 a 不是 link', () => {
    const doc = mount('<a>纯锚点</a>');
    expect(implicitRole(doc.querySelector('a')!)).toBe('');
  });
});

/* ------------------------------------------------------- 评分 */

describe('scoreCandidate —— 韧性评分扣分规则', () => {
  it('★ 官方推荐的定位之间有明确高下（用各自的典型形态比较）', () => {
    // 比较基准用**各自的典型形态**，而不是同一个占位串：
    // role 的价值在于可访问名，无名 role 会被扣 40（另有专门用例覆盖）。
    const role = scoreCandidate(cand('role', 'role=button[name="提交"]'));
    const label = scoreCandidate(cand('label', 'label="得分"'));
    const testid = scoreCandidate(cand('testid', '[data-testid="score"]'));
    const placeholder = scoreCandidate(cand('placeholder', 'placeholder="请输入分数"'));
    const text = scoreCandidate(cand('text', 'text="第 1 题"'));
    const css = scoreCandidate(cand('css', '.score-input'));

    expect(role).toBeGreaterThan(label);
    expect(label).toBeGreaterThan(testid);
    expect(testid).toBeGreaterThan(placeholder);
    expect(placeholder).toBeGreaterThan(text);
    expect(text).toBeGreaterThan(css);
  });

  it('★ 任何官方推荐定位都高于 CSS 兜底', () => {
    // 最关键的一条：CSS 是最后手段
    const css = scoreCandidate(cand('css', '.score-input'));
    expect(scoreCandidate(cand('role', 'role=button[name="提交"]'))).toBeGreaterThan(css);
    expect(scoreCandidate(cand('label', 'label="得分"'))).toBeGreaterThan(css);
    expect(scoreCandidate(cand('testid', '[data-testid="s"]'))).toBeGreaterThan(css);
    expect(scoreCandidate(cand('placeholder', 'placeholder="分数"'))).toBeGreaterThan(css);
    expect(scoreCandidate(cand('text', 'text="题目"'))).toBeGreaterThan(css);
  });

  it('带动态特征的 id / attr 会掉到良好 CSS 之下（说明该特征确实不可信）', () => {
    // id 基准分不高是有意的：id 常由前端框架自动生成。
    // 一旦含 hash / 自增序号，应比一个语义清晰的 class 更不可信。
    const hashyId = scoreCandidate(cand('id', '#a1b2c3d4e5f60718'));
    const niceCss = scoreCandidate(cand('css', '.score-input'));
    expect(hashyId).toBeLessThan(niceCss);
  });

  it('★ :nth-child 等结构依赖被重罚（插入兄弟节点就错位）', () => {
    const plain = scoreCandidate(cand('css', 'div.score'));
    const nth = scoreCandidate(cand('css', 'div:nth-child(3) .score'));
    expect(nth).toBeLessThan(plain);
    expect(plain - nth).toBeGreaterThanOrEqual(25);
  });

  it('★ 构建产物类名被重罚', () => {
    const ok = scoreCandidate(cand('css', 'div.score-input'));
    const bad = scoreCandidate(cand('css', 'div.css-1a2b3c'));
    expect(bad).toBeLessThan(ok);
  });

  it('★ 无名 role 被重罚（只能靠标签名区分，几乎没用）', () => {
    const named = scoreCandidate(cand('role', 'role=button[name="提交"]'));
    const unnamed = scoreCandidate(cand('role', 'role=button'));
    expect(named).toBeGreaterThan(unnamed);
    expect(named - unnamed).toBeGreaterThanOrEqual(40);
  });

  it('★ 超长可访问名被扣分（文案最容易被改）', () => {
    const short = scoreCandidate(cand('role', 'role=button[name="提交"]'));
    const long = scoreCandidate(cand('role', `role=button[name="${'很长的按钮文案'.repeat(6)}"]`));
    expect(long).toBeLessThan(short);
  });

  it('★ 路径深度扣分（depth 显式传入时才生效）', () => {
    // depth 默认 0 = 不扣分，这样不同 kind 之间才可比；
    // 真实候选由 selectorCandidates 传实际深度。
    const d0 = scoreCandidate(cand('css', 'div'), 0);
    const d3 = scoreCandidate(cand('css', 'div'), 3);
    const d6 = scoreCandidate(cand('css', 'div'), 6);
    const d99 = scoreCandidate(cand('css', 'div'), 99);
    expect(d0).toBe(30); // 不扣
    expect(d3).toBe(d0 - 18);
    expect(d6).toBe(d0 - 36);
    expect(d99).toBe(d6); // 6 层以上不再扣
  });

  it('★ 极差候选允许为负分（保住相对次序，避免并列）', () => {
    const bad1 = scoreCandidate(cand('css', ':nth-child(2) .css-1a2b3c'), 6);
    const bad2 = scoreCandidate(cand('css', ':nth-child(2) .css-9z8y7x'), 6);
    expect(bad1).toBeLessThan(0);
    expect(bad2).toBeLessThan(0);
    expect(bad1).toBe(bad2); // 同样差 → 同分（合法）
  });

  it('★ 疑似 uuid / 哈希的 id 被扣分', () => {
    const stable = scoreCandidate(cand('id', '#score-input'));
    const hashy = scoreCandidate(cand('id', '#a1b2c3d4e5f60718'));
    expect(hashy).toBeLessThan(stable);
  });

  it('疑似自增序号的 id 被扣分', () => {
    const stable = scoreCandidate(cand('id', '#score'));
    const seq = scoreCandidate(cand('id', '#myid_12345'));
    expect(seq).toBeLessThan(stable);
  });

  it('评分有上下界（上界 100，下界 -50）', () => {
    for (const k of ['role', 'css', 'id', 'text'] as const) {
      const s = scoreCandidate(cand(k, '.css-abc:nth-child(3)'), 6);
      expect(s).toBeGreaterThanOrEqual(-50);
      expect(s).toBeLessThanOrEqual(100);
    }
    // 正常候选不会越过上界
    expect(scoreCandidate(cand('role', 'role=button[name="提交"]'))).toBeLessThanOrEqual(100);
  });
});

/* ------------------------------------------------------- 生成 */

describe('selectorCandidates —— 生成与排序', () => {
  let doc: Document;
  beforeEach(() => {
    doc = mount(`
      <label for="score">得分</label>
      <input id="score" name="score" type="number" data-testid="score-input" placeholder="请输入分数">

      <button type="submit" data-testid="submit-btn">提交答卷</button>

      <div class="css-1a2b3c"><input id="weird" type="text"></div>
      <div class="stem">第 1 题 求导</div>
    `);
  });

  it('★ 分数框：role 候选排在最前', () => {
    const cands = selectorCandidates(doc.querySelector('#score')!);
    expect(cands[0]!.kind).toBe('role');
    expect(cands[0]!.selector).toContain('role=spinbutton');
    expect(cands[0]!.selector).toContain('name="得分"');
  });

  it('★ 排序必须单调递减（这是本模块的核心契约）', () => {
    for (const sel of ['#score', 'button', '.stem', '#weird']) {
      const cands = selectorCandidates(doc.querySelector(sel)!);
      for (let i = 1; i < cands.length; i++) {
        expect(cands[i - 1]!.score, `${sel} 第 ${i} 项`).toBeGreaterThanOrEqual(cands[i]!.score);
      }
    }
  });

  it('候选里有 testid 且评分高于 css 兜底', () => {
    const cands = selectorCandidates(doc.querySelector('#score')!);
    const testid = cands.find((c) => c.kind === 'testid');
    const css = cands.find((c) => c.kind === 'css');
    expect(testid).toBeDefined();
    expect(testid!.score).toBeGreaterThan(css!.score);
  });

  it('★ 提交按钮：role=button 带可访问名', () => {
    const cands = selectorCandidates(doc.querySelector('button')!);
    const role = cands.find((c) => c.kind === 'role');
    expect(role!.selector).toBe('role=button[name="提交答卷"]');
  });

  it('CSS 兜底不会选中构建产物类名', () => {
    const cands = selectorCandidates(doc.querySelector('#weird')!);
    const css = cands.find((c) => c.kind === 'css');
    expect(css!.selector).not.toContain('css-1a2b3c');
  });

  it('★ 候选不重复', () => {
    const cands = selectorCandidates(doc.querySelector('#score')!);
    const sels = cands.map((c) => c.selector);
    expect(new Set(sels).size).toBe(sels.length);
  });

  it('可访问名含双引号时被正确转义（不产生坏选择器）', () => {
    const d = mount('<button aria-label=\'带"引号"的名字\'>x</button>');
    const cands = selectorCandidates(d.querySelector('button')!);
    const role = cands.find((c) => c.kind === 'role');
    expect(role!.selector).toContain('\\"');
  });

  it('无任何标识的裸元素仍能生成候选（退化到标签名）', () => {
    const d = mount('<div></div>');
    const cands = selectorCandidates(d.querySelector('div')!);
    expect(cands.length).toBeGreaterThan(0);
    expect(cands.some((c) => c.kind === 'css')).toBe(true);
  });
});

/* ----------------------------------------------- 运行时解析辅助 */

describe('isCssResolvable —— 别把 role= 当 CSS 传给 querySelector', () => {
  it('★ role/label/text/placeholder 不可 CSS 解析', () => {
    // 误当 CSS 会抛异常；若吞掉异常当作"不命中"，就变成静默失效
    for (const k of ['role', 'label', 'placeholder', 'text'] as const) {
      expect(isCssResolvable(cand(k, 'role=button')), k).toBe(false);
    }
  });

  it('css/id/attr/testid 可 CSS 解析', () => {
    for (const k of ['css', 'id', 'attr', 'testid'] as const) {
      expect(isCssResolvable(cand(k, '#x')), k).toBe(true);
    }
  });
});

describe('primarySelector', () => {
  const cands: SelectorCandidate[] = [
    { kind: 'role', selector: 'role=button[name="提交"]', score: 100 },
    { kind: 'css', selector: '#b', score: 60 },
    { kind: 'css', selector: '.b', score: 30 },
  ];

  it('默认取评分最高', () => {
    expect(primarySelector(cands)!.kind).toBe('role');
  });

  it('★ cssOnly 时跳过 role —— 用于不支持 role 解析的环境与结构指纹', () => {
    expect(primarySelector(cands, { cssOnly: true })!.selector).toBe('#b');
  });

  it('空列表返回 null', () => {
    expect(primarySelector([])).toBeNull();
  });
});

describe('candidatesFingerprint —— 供漂移检测', () => {
  it('同输入同输出', () => {
    const doc = mount('<input id="s" type="number">');
    const el = doc.querySelector('input')!;
    expect(candidatesFingerprint(selectorCandidates(el))).toBe(
      candidatesFingerprint(selectorCandidates(el)),
    );
  });

  it('★ 元素属性变化时指纹变化', () => {
    const d1 = mount('<input id="s" type="number">');
    const d2 = mount('<input id="s2" type="number">');
    const f1 = candidatesFingerprint(selectorCandidates(d1.querySelector('input')!));
    const f2 = candidatesFingerprint(selectorCandidates(d2.querySelector('input')!));
    expect(f1).not.toBe(f2);
  });

  it('★ 仅文案变化也会改变指纹（文案是最常被改的）', () => {
    const d1 = mount('<button>提交</button>');
    const d2 = mount('<button>提交答卷</button>');
    expect(candidatesFingerprint(selectorCandidates(d1.querySelector('button')!))).not.toBe(
      candidatesFingerprint(selectorCandidates(d2.querySelector('button')!)),
    );
  });
});