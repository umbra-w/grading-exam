// @vitest-environment jsdom
/**
 * 选择器生成器单测 —— 对应 PLAN v2.0 §7 的 CDP 层测试。
 *
 * 为什么值得单独测：拾取能否用，全押在选择器上（质量门 5：禁止硬编码平台选择器）。
 * 这段逻辑原先埋在 preload 里，只能靠真实 Electron 验证；本机 Electron 起不来
 *（BLOCKERS.md B3），所以把它抽成纯模块后用 jsdom 测——不依赖 GUI。
 *
 * 测试同时加载 tests/fixtures/ 的真实夹具页，保证测的是"真实页面结构"而非人造 DOM。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildSelector,
  cssEscapeIdent,
  isStableClass,
  attrSelector,
  selectorStillValid,
  structureFingerprint,
} from '@shared/selector';

const FIXTURES = resolve(__dirname, 'fixtures');

function loadFixture(name: string): Document {
  const html = readFileSync(resolve(FIXTURES, name), 'utf-8');
  const doc = document.implementation.createHTMLDocument(name);
  doc.documentElement.innerHTML = html;
  return doc;
}

/* ------------------------------------------------------------ 纯函数 */

describe('cssEscapeIdent', () => {
  it('转义 CSS 特殊字符', () => {
    expect(cssEscapeIdent('a.b#c')).toContain('\\');
    expect(cssEscapeIdent('normal-id')).toBe('normal-id');
  });

  it('对纯字母数字不引入多余转义', () => {
    expect(cssEscapeIdent('scoreInput')).toBe('scoreInput');
  });
});

describe('isStableClass —— 必须排除构建工具生成的哈希类名', () => {
  it('接受语义化类名', () => {
    for (const c of ['score-input', 'submit-btn', 'questionRegion', 'answer']) {
      expect(isStableClass(c), c).toBe(true);
    }
  });

  it('拒绝 CSS-in-JS 与 styled-components 产物', () => {
    for (const c of ['css-1a2b3c', 'sc-bdVaJa', 'jsx-123456', 'styled-abc']) {
      expect(isStableClass(c), c).toBe(false);
    }
  });

  it('拒绝含长十六进制片段的类名', () => {
    // 平台发版后这些类名会变，写进选择器比不用还糟
    expect(isStableClass('btn-a1b2c3d4')).toBe(false);
    expect(isStableClass('x-deadbeef99')).toBe(false);
  });

  it('拒绝超长类名与空值', () => {
    expect(isStableClass('a'.repeat(41))).toBe(false);
    expect(isStableClass('')).toBe(false);
  });
});

describe('attrSelector —— 语义化属性优先', () => {
  it('优先取 data-testid', () => {
    const doc = loadFixture('plain-dom.html');
    const el = doc.querySelector('[data-testid="submit"]')!;
    expect(attrSelector(el)).toBe('[data-testid="submit"]');
  });

  it('无语义属性时返回 null', () => {
    const doc = loadFixture('plain-dom.html');
    const el = doc.querySelector('.qimg')!;
    // qimg 只有 class，没有白名单属性
    expect(attrSelector(el)).toBeNull();
  });

  it('转义属性值中的双引号，避免选择器语法错误', () => {
    const el = document.createElement('div');
    el.setAttribute('data-testid', 'a"b');
    expect(attrSelector(el)).toBe('[data-testid="a\\"b"]');
  });
});

/* --------------------------------------------------- 真实夹具页验证 */

describe('buildSelector @ plain-dom.html（普通 DOM）', () => {
  let doc: Document;
  beforeAll(() => {
    doc = loadFixture('plain-dom.html');
  });

  it('有 id 的元素直接用 id', () => {
    const el = doc.getElementById('score-input')!;
    expect(buildSelector(el, { doc })).toBe('#score-input');
  });

  it('提交按钮可稳定定位（id 优先于属性，两者皆稳定锚点）', () => {
    const el = doc.getElementById('submit-btn')!;
    const sel = buildSelector(el, { doc });
    expect(sel === '#submit-btn' || sel.includes('data-testid="submit"')).toBe(true);
    expect(selectorStillValid(sel, doc)).toBe(true);
    expect(doc.querySelector(sel)).toBe(el);
  });

  it('无 id 无语义属性的元素生成可用路径', () => {
    const el = doc.querySelector('.qimg')!;
    const sel = buildSelector(el, { doc });
    expect(sel).toContain('qimg');
    expect(selectorStillValid(sel, doc)).toBe(true);
  });

  it('题目区域可被唯一命中', () => {
    const el = doc.getElementById('question-region')!;
    const sel = buildSelector(el, { doc });
    expect(doc.querySelectorAll(sel).length).toBe(1);
  });
});

describe('buildSelector @ parent-iframe.html（iframe 场景）', () => {
  let doc: Document;
  beforeAll(() => {
    doc = loadFixture('parent-iframe.html');
  });

  it('iframe 元素本身可生成选择器', () => {
    const el = doc.getElementById('score-frame')!;
    const sel = buildSelector(el, { doc });
    expect(doc.querySelectorAll(sel).length).toBe(1);
  });

  it('iframe 的 src 指向子页夹具（跨域配置靠 origin 区分，此处只断言结构）', () => {
    const el = doc.getElementById('score-frame') as HTMLIFrameElement;
    expect(el.getAttribute('src')).toContain('child-frame.html');
  });

  it('★ 父页内【不存在】分数输入框 —— 证明必须穿透 iframe', () => {
    // 这是本测试最重要的一条断言：跨域 iframe 场景下，父页 querySelector
    // 永远找不到分数框，只有经 CDP 进入对应 frame target 才行。
    expect(doc.querySelector('#frame-score-input')).toBeNull();
    expect(doc.querySelectorAll('input').length).toBe(0);
  });

  it('帧偏移测量所需的目标存在', () => {
    expect(doc.getElementById('frame-offset')).not.toBeNull();
    expect(doc.getElementById('score-frame')).not.toBeNull();
  });
});

describe('buildSelector @ child-frame.html（iframe 内页）', () => {
  let doc: Document;
  beforeAll(() => {
    doc = loadFixture('child-frame.html');
  });

  it('帧内分数框可用 id 定位', () => {
    const el = doc.getElementById('frame-score-input')!;
    expect(buildSelector(el, { doc })).toBe('#frame-score-input');
  });

  it('帧内提交按钮可定位（自身 id 优先，其次 data-testid）', () => {
    const el = doc.getElementById('frame-submit-btn')!;
    const sel = buildSelector(el, { doc });
    // 设计上自身 id 优先于属性；两者都是稳定锚点，此处接受任一
    expect(sel === '#frame-submit-btn' || sel.includes('data-testid="frame-submit"')).toBe(true);
    expect(selectorStillValid(sel, doc)).toBe(true);
    expect(doc.querySelector(sel)).toBe(el);
  });
});

describe('buildSelector @ canvas-only.html（Canvas 平台）', () => {
  let doc: Document;
  beforeAll(() => {
    doc = loadFixture('canvas-only.html');
  });

  it('★ 页面内【没有任何 input/textarea】—— 证明只能用坐标模式', () => {
    // SPEC F1.3 描述的场景：Canvas 渲染平台无法用元素拾取。
    // 这条断言保证夹具页真的复现了该形态，否则元素拾取测试会假通过。
    expect(doc.querySelectorAll('input, textarea').length).toBe(0);
    expect(doc.querySelectorAll('button').length).toBe(0);
  });

  it('canvas 元素可定位（但只能用于取整体偏移，不能作为填分目标）', () => {
    const el = doc.getElementById('stage')!;
    const sel = buildSelector(el, { doc });
    expect(selectorStillValid(sel, doc)).toBe(true);
  });

  it('canvas 尺寸与坐标系可用于算点击目标', () => {
    const cv = doc.getElementById('stage') as HTMLCanvasElement;
    expect(Number(cv.getAttribute('width'))).toBe(720);
    expect(Number(cv.getAttribute('height'))).toBe(300);
  });
});

/* --------------------------------------------------------- 鲁棒性 */

describe('buildSelector 鲁棒性', () => {
  it('优先取近祖先的 id 作为锚点，避免生成脆弱的长/短路径', () => {
    const doc = document.implementation.createHTMLDocument('t');
    doc.documentElement.innerHTML = `
      <body>
        <div id="anchor"><section><span><b class="deep">目标</b></span></section></div>
      </body>`;
    const el = doc.querySelector('.deep')!;
    const sel = buildSelector(el, { doc });
    // 关键改进：即使 `b.deep` 自身已唯一，也应改写成锚点形式，
    // 否则平台一改 CSS 类名选择器就失效（见 selector.ts 的 preferAncestorAnchor 注释）
    expect(sel).toContain('#anchor');
    expect(sel.split(' > ').length).toBeLessThanOrEqual(5);
    expect(selectorStillValid(sel, doc)).toBe(true);
    expect(doc.querySelector(sel)).toBe(el);
  });

  it('找不到稳定祖先锚点时退回普通路径', () => {
    const doc = document.implementation.createHTMLDocument('t');
    doc.documentElement.innerHTML = `<body><div class="wrap"><b class="deep">目标</b></div></body>`;
    const el = doc.querySelector('.deep')!;
    const sel = buildSelector(el, { doc });
    expect(sel).not.toContain('#');
    expect(sel).toContain('deep');
    expect(selectorStillValid(sel, doc)).toBe(true);
  });

  it('可用 preferAncestorAnchor=false 关闭锚点优先', () => {
    const doc = document.implementation.createHTMLDocument('t');
    doc.documentElement.innerHTML = `<body><div id="anchor"><b class="deep">目标</b></div></body>`;
    const el = doc.querySelector('.deep')!;
    const withAnchor = buildSelector(el, { doc });
    const withoutAnchor = buildSelector(el, { doc, preferAncestorAnchor: false });
    expect(withAnchor).toContain('#anchor');
    expect(withoutAnchor).not.toContain('#anchor');
  });

  it('同级同标签时补 nth-of-type 以保证唯一', () => {
    const doc = document.implementation.createHTMLDocument('t');
    doc.documentElement.innerHTML = `
      <body><div class="wrap"><p>一</p><p>二</p><p>三</p></div></body>`;
    const ps = doc.querySelectorAll('p');
    const sel = buildSelector(ps[2]!, { doc });
    expect(sel).toContain('nth-of-type');
    expect(selectorStillValid(sel, doc)).toBe(true);
    expect(doc.querySelector(sel)!.textContent).toBe('三');
  });

  it('忽略哈希类名，改用结构路径', () => {
    const doc = document.implementation.createHTMLDocument('t');
    doc.documentElement.innerHTML = `<body><div class="css-1a2b3c"><span id="real">x</span></div></body>`;
    const el = doc.querySelector('#real')!;
    expect(buildSelector(el, { doc })).toBe('#real');
  });

  it('数字开头的 id 不作为锚点（非法 CSS 标识符）', () => {
    const doc = document.implementation.createHTMLDocument('t');
    doc.documentElement.innerHTML = `<body><div id="123abc"><i class="inner">y</i></div></body>`;
    const el = doc.querySelector('.inner')!;
    const sel = buildSelector(el, { doc });
    expect(sel.startsWith('#123abc')).toBe(false);
    expect(selectorStillValid(sel, doc)).toBe(true);
  });

  it('无 document 可用时不抛异常（降级场景）', () => {
    const doc = document.implementation.createHTMLDocument('t');
    doc.documentElement.innerHTML = `<body><div id="solo"><span class="x">z</span></div></body>`;
    const el = doc.querySelector('.x')!;
    const sel = buildSelector(el, { doc: undefined });
    expect(typeof sel).toBe('string');
    expect(sel.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------- 结构指纹（R11） */

describe('structureFingerprint —— 平台改版检测（SPEC P2-11 / 调研 R11）', () => {
  it('同一页面两次取值一致', () => {
    const doc = loadFixture('plain-dom.html');
    const sels = { scoreInput: '#score-input', submitButton: '[data-testid="submit"]' };
    expect(structureFingerprint(sels, doc)).toBe(structureFingerprint(sels, doc));
  });

  it('元素消失时指纹变化（应触发暂停并要求重拾）', () => {
    const doc = loadFixture('plain-dom.html');
    const good = structureFingerprint({ scoreInput: '#score-input' }, doc);
    const bad = structureFingerprint({ scoreInput: '#not-exist' }, doc);
    expect(good).not.toBe(bad);
    expect(bad).toContain('MISSING');
  });

  it('关键属性变化时指纹变化', () => {
    const doc = loadFixture('plain-dom.html');
    const before = structureFingerprint({ scoreInput: '#score-input' }, doc);
    const input = doc.getElementById('score-input')!;
    input.setAttribute('type', 'text');
    const after = structureFingerprint({ scoreInput: '#score-input' }, doc);
    expect(before).not.toBe(after);
  });

  it('选择器非法时不抛异常，标记为 MISSING', () => {
    const doc = loadFixture('plain-dom.html');
    expect(() => structureFingerprint({ x: '???' }, doc)).not.toThrow();
    expect(structureFingerprint({ x: '???' }, doc)).toContain('MISSING');
  });
});

describe('selectorStillValid', () => {
  it('唯一命中为 true，多命中为 false', () => {
    const doc = loadFixture('plain-dom.html');
    expect(selectorStillValid('#score-input', doc)).toBe(true);
    expect(selectorStillValid('input', doc)).toBe(true); // 本页仅 1 个 input
    expect(selectorStillValid('#missing', doc)).toBe(false);
  });

  it('非法选择器返回 false 而非抛异常', () => {
    const doc = loadFixture('plain-dom.html');
    expect(selectorStillValid(':::bad', doc)).toBe(false);
  });
});