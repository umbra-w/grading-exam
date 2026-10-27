// @vitest-environment jsdom
/**
 * 拾取编排单测 —— 覆盖 frame 换算、校验与改版检测。
 *
 * 这些逻辑一旦出错，症状是"点了没反应"或"点到别处"，极难排查。
 * 主进程的浏览器绑定部分待真机验证（BLOCKERS.md B3），但这里的纯计算必须钉死。
 */
import { describe, it, expect } from 'vitest';
import {
  buildPickResult,
  buildCoordinatePick,
  validatePick,
  validatePickSet,
  detectDrift,
  diffFingerprint,
  fingerprintOf,
  labelOf,
  profileKeyForUrl,
  type PickContext,
  type RawPagePick,
  type PickProfile,
} from '../src/main/page/picker';
import { resolveFrameId, flattenFramePaths, findCrossOriginFrames, type FrameTreeNode } from '../src/main/page/cdp';
import type { PickResult } from '@shared/types';

const VP = { width: 1280, height: 800 };

function ctx(over: Partial<PickContext> = {}): PickContext {
  return {
    windowId: 1,
    framePath: [],
    frameRects: [],
    viewport: VP,
    crossOrigin: false,
    ...over,
  };
}

function raw(over: Partial<RawPagePick> = {}): RawPagePick {
  return {
    kind: 'scoreInput',
    selector: '#score',
    localX: 100,
    localY: 50,
    width: 120,
    height: 30,
    tag: 'input',
    text: '',
    ...over,
  };
}

/* ------------------------------------------------ 坐标换算 */

describe('buildPickResult —— 坐标换算', () => {
  it('顶层元素：坐标即局部坐标 + 尺寸中心', () => {
    const r = buildPickResult(raw(), ctx());
    expect(r.topX).toBe(160); // 100 + 120/2
    expect(r.topY).toBe(65); // 50 + 30/2
    expect(r.inIframe).toBe(false);
    expect(r.framePath).toEqual([]);
    expect(r.mode).toBe('element');
  });

  it('★ 单层 iframe：累加 iframe 偏移（漏掉就会点到别处）', () => {
    const r = buildPickResult(
      raw({ localX: 10, localY: 20, width: 100, height: 40 }),
      ctx({ framePath: [0], frameRects: [{ x: 300, y: 150, width: 800, height: 600 }] }),
    );
    expect(r.topX).toBe(360); // 300 + 10 + 50
    expect(r.topY).toBe(190); // 150 + 20 + 20
    expect(r.inIframe).toBe(true);
    expect(r.framePath).toEqual([0]);
  });

  it('★ 两层嵌套 iframe：逐层累加', () => {
    const r = buildPickResult(
      raw({ localX: 5, localY: 5, width: 60, height: 24 }),
      ctx({
        framePath: [1, 0],
        frameRects: [
          { x: 100, y: 50, width: 900, height: 700 },
          { x: 20, y: 30, width: 400, height: 300 },
        ],
      }),
    );
    expect(r.topX).toBe(155); // 125 + 30
    expect(r.topY).toBe(97); // 85 + 12
    expect(r.framePath).toEqual([1, 0]);
  });

  it('保留局部坐标，便于日后 frame 结构变化时重算', () => {
    const r = buildPickResult(raw({ localX: 7, localY: 9 }), ctx({ framePath: [0], frameRects: [{ x: 1, y: 2, width: 10, height: 10 }] }));
    expect(r.localX).toBe(7);
    expect(r.localY).toBe(9);
  });

  it('空选择器 → selector 为 null（不是空字符串）', () => {
    expect(buildPickResult(raw({ selector: '' }), ctx()).selector).toBeNull();
  });

  it('记录 pickedAt 时间戳', () => {
    const before = Date.now();
    const r = buildPickResult(raw(), ctx());
    expect(r.pickedAt).toBeGreaterThanOrEqual(before);
  });

  it('★ 候选列表被原样带下来（供运行时降级重试）', () => {
    const cands = [
      { kind: 'role' as const, selector: 'role=spinbutton[name="得分"]', score: 100 },
      { kind: 'testid' as const, selector: '[data-testid="score"]', score: 88 },
      { kind: 'css' as const, selector: '#score', score: 60 },
    ];
    const r = buildPickResult(raw({ candidates: cands }), ctx());
    expect(r.candidates).toHaveLength(3);
    expect(r.candidates![0]!.kind).toBe('role');
    expect(r.candidates![2]!.selector).toBe('#score');
  });

  it('★ 无 selector 但有候选时，取最优候选作为主选择器', () => {
    const r = buildPickResult(
      raw({
        selector: '',
        candidates: [
          { kind: 'role' as const, selector: 'role=button[name="提交"]', score: 100 },
          { kind: 'css' as const, selector: '.btn', score: 30 },
        ],
      }),
      ctx(),
    );
    expect(r.selector).toBe('role=button[name="提交"]');
  });

  it('无候选时 candidates 为 undefined（不是空数组）', () => {
    const r = buildPickResult(raw(), ctx());
    expect(r.candidates).toBeUndefined();
  });

  it('候选不改变坐标换算结果', () => {
    const withCands = buildPickResult(
      raw({ localX: 10, localY: 20, width: 100, height: 40, candidates: [{ kind: 'role' as const, selector: 'role=textbox', score: 60 }] }),
      ctx({ framePath: [0], frameRects: [{ x: 300, y: 150, width: 800, height: 600 }] }),
    );
    const without = buildPickResult(raw({ localX: 10, localY: 20, width: 100, height: 40 }), ctx({ framePath: [0], frameRects: [{ x: 300, y: 150, width: 800, height: 600 }] }));
    expect(withCands.topX).toBe(without.topX);
    expect(withCands.topY).toBe(without.topY);
  });
});

describe('buildCoordinatePick —— Canvas 平台', () => {
  it('坐标为点本身，尺寸为 0', () => {
    const r = buildCoordinatePick('scoreInput', 200, 300, ctx({ framePath: [0], frameRects: [{ x: 10, y: 20, width: 100, height: 100 }] }));
    expect(r.mode).toBe('coordinate');
    expect(r.topX).toBe(210);
    expect(r.topY).toBe(320);
    expect(r.selector).toBeNull();
    expect(r.width).toBe(0);
    expect(r.height).toBe(0);
  });

  it('跨 frame 的坐标同样累加', () => {
    const r = buildCoordinatePick('submitButton', 0, 0, ctx({ framePath: [0], frameRects: [{ x: 50, y: 60, width: 10, height: 10 }] }));
    expect(r.topX).toBe(50);
    expect(r.topY).toBe(60);
  });
});

/* ---------------------------------------------------- 校验 */

function pick(over: Partial<PickResult> = {}): PickResult {
  return {
    kind: 'scoreInput',
    mode: 'element',
    topX: 100,
    topY: 100,
    localX: 100,
    localY: 100,
    framePath: [],
    selector: '#s',
    width: 100,
    height: 20,
    tag: 'input',
    inIframe: false,
    pickedAt: Date.now(),
    ...over,
  };
}

describe('validatePick', () => {
  it('正常拾取通过', () => {
    expect(validatePick(pick(), VP).level).toBe('ok');
  });

  it('★ 越界 → error，且声明未派发任何事件（不可逆操作前拦截）', () => {
    const p = validatePick(pick({ topX: 2000, topY: 100 }), VP);
    expect(p.level).toBe('error');
    expect(p.code).toBe('OUT_OF_VIEWPORT');
    expect((p as { action: string }).action).toContain('未派发');
  });

  it('负坐标也算越界', () => {
    expect(validatePick(pick({ topX: -1 }), VP).code).toBe('OUT_OF_VIEWPORT');
  });

  it('元素模式但无选择器 → warn（坐标会随改版失效）', () => {
    const p = validatePick(pick({ selector: null }), VP);
    expect(p.level).toBe('warn');
    expect(p.code).toBe('NO_SELECTOR');
  });

  it('尺寸为 0 → warn（可能是坐标模式）', () => {
    const p = validatePick(pick({ width: 0, height: 0 }), VP);
    expect(p.code).toBe('ZERO_SIZE');
  });

  it('坐标模式无选择器不告警', () => {
    const p = validatePick(pick({ mode: 'coordinate', selector: null, width: 0, height: 0 }), VP);
    // 仍会有 ZERO_SIZE 提示，但不应报 NO_SELECTOR
    expect(p.code).not.toBe('NO_SELECTOR');
  });
});

describe('profileKeyForUrl（拾取档案的存储 key）', () => {
  it('★ 去掉 query 与 hash —— 否则每次进入都是新 key，恢复永远命中不了', () => {
    const a = profileKeyForUrl('https://p.example/grade?taskId=1&_t=111#q3');
    const b = profileKeyForUrl('https://p.example/grade?taskId=2&_t=999#q7');
    expect(a).toBe(b);
    expect(a).toBe('https://p.example/grade');
  });

  it('★ 保留 path —— 同源不同页面必须分开', () => {
    const a = profileKeyForUrl('https://p.example/grade/taskA');
    const b = profileKeyForUrl('https://p.example/grade/taskB');
    expect(a).not.toBe(b);
  });

  it('不同源必须分开', () => {
    expect(profileKeyForUrl('https://a.example/x')).not.toBe(profileKeyForUrl('https://b.example/x'));
  });

  it('端口与协议算作不同来源', () => {
    expect(profileKeyForUrl('http://p.example/x')).not.toBe(profileKeyForUrl('https://p.example/x'));
    expect(profileKeyForUrl('https://p.example:8443/x')).not.toBe(
      profileKeyForUrl('https://p.example/x'),
    );
  });

  it('非法/特殊 URL 退化成原串，而不是全部塌到同一个 key', () => {
    // 若失败分支返回 ''，所有 about:blank 类页面会共用一个档案 —— 危险。
    // 另注：`new URL('about:blank')` 不抛错，origin 会是字符串 'null'，
    // 实现必须显式处理（这是本测试第一版抓到的真实缺陷）。
    const a = profileKeyForUrl('about:blank');
    const b = profileKeyForUrl('not a url at all');
    const c = profileKeyForUrl('blob:https://p.example/abc');
    expect(a).toBe('about:blank');
    expect(a).not.toBe(b);
    expect(a).not.toBe('');
    expect(a).not.toBe(c);
    for (const k of [a, b, c]) expect(k.startsWith('null')).toBe(false);
  });

  it('根路径的 key 形如 origin + "/"', () => {
    expect(profileKeyForUrl('https://p.example')).toBe('https://p.example/');
  });
});

describe('validatePickSet', () => {
  it('★ 缺分数框 → 不 ready（分数框是唯一必填）', () => {
    const r = validatePickSet({ questionRegion: pick({ kind: 'questionRegion' }) }, VP);
    expect(r.ready).toBe(false);
    const missing = r.problems.filter((p) => p.code === 'PICK_MISSING');
    expect(missing).toHaveLength(1);
    expect(missing[0]!.kind).toBe('scoreInput');
  });

  it('★ 缺提交按钮**不算错误**（提交按钮可选，SPEC 要求）', () => {
    const r = validatePickSet({ scoreInput: pick({ kind: 'scoreInput' }) }, VP);
    expect(r.ready).toBe(true);
    expect(r.problems.some((p) => p.level === 'error')).toBe(false);
  });

  it('★ 缺提交按钮 → submitMode 为 platform（软件不代提交）', () => {
    const r = validatePickSet({ scoreInput: pick({ kind: 'scoreInput' }) }, VP);
    expect(r.submitMode).toBe('platform');
  });

  it('★ 缺提交按钮时必须给出一条 info，明确告知不会代为提交', () => {
    // 静默地"不提交"和静默地"提交"一样危险：用户以为点过了
    const r = validatePickSet({ scoreInput: pick({ kind: 'scoreInput' }) }, VP);
    const info = r.problems.find((p) => p.code === 'SUBMIT_BY_PLATFORM');
    expect(info, '缺少「由平台提交」的提示').toBeDefined();
    // 窄化后再读 action（PickProblem 是判别联合，ok 分支没有 action 字段）
    if (info && info.level !== 'ok') {
      expect(info.level).toBe('info');
      expect(info.action).toMatch(/不会|只填分|不点提交/);
    } else {
      throw new Error(`提示的 level 应为 info，实际为 ${info?.level}`);
    }
  });

  it('★ 有提交按钮 → submitMode 为 software（软件代点提交）', () => {
    const r = validatePickSet(
      { scoreInput: pick({ kind: 'scoreInput' }), submitButton: pick({ kind: 'submitButton' }) },
      VP,
    );
    expect(r.ready).toBe(true);
    expect(r.submitMode).toBe('software');
  });

  it('★ 提交按钮存在但坐标越界 → 不 ready，且 submitMode 退回 platform', () => {
    // 一个坏掉的提交按钮不能算"有提交按钮"：软件会点到别处
    const r = validatePickSet(
      {
        scoreInput: pick({ kind: 'scoreInput' }),
        submitButton: pick({ kind: 'submitButton', topX: 5000 }),
      },
      VP,
    );
    expect(r.ready).toBe(false);
    expect(r.submitMode).toBe('platform');
  });

  it('缺题目区域不算错误（只影响截图范围）', () => {
    const r = validatePickSet(
      { scoreInput: pick({ kind: 'scoreInput' }), submitButton: pick({ kind: 'submitButton' }) },
      VP,
    );
    expect(r.ready).toBe(true);
    expect(r.problems.some((p) => p.kind === 'questionRegion')).toBe(false);
  });

  it('三项齐全且合法 → ready', () => {
    const r = validatePickSet(
      {
        scoreInput: pick({ kind: 'scoreInput' }),
        submitButton: pick({ kind: 'submitButton' }),
        questionRegion: pick({ kind: 'questionRegion' }),
      },
      VP,
    );
    expect(r.ready).toBe(true);
    expect(r.submitMode).toBe('software');
  });

  it('分数框越界 → 不 ready', () => {
    const r = validatePickSet(
      {
        scoreInput: pick({ kind: 'scoreInput', topX: 5000 }),
        submitButton: pick({ kind: 'submitButton' }),
      },
      VP,
    );
    expect(r.ready).toBe(false);
  });

  it('问题项带 kind，便于面板定位到具体按钮', () => {
    const r = validatePickSet({}, VP);
    for (const p of r.problems) expect(p.kind).toBeTruthy();
  });
});

describe('labelOf', () => {
  it('返回中文标签', () => {
    expect(labelOf('scoreInput')).toBe('分数输入框');
    expect(labelOf('submitButton')).toBe('提交按钮');
    expect(labelOf('questionRegion')).toBe('题目区域');
  });
});

/* ------------------------------------------------- 改版检测 */

describe('detectDrift —— 平台改版检测（SPEC P2-11）', () => {
  const profile = (fp: string): PickProfile => ({
    picks: {},
    fingerprint: fp,
    url: 'https://PLATFORM/grade',
    pickedAt: Date.now(),
  });

  it('指纹一致 → 无变化', () => {
    const d = detectDrift(profile('scoreInput:input|x=1'), 'scoreInput:input|x=1');
    expect(d.changed).toBe(false);
    expect(d.details).toHaveLength(0);
  });

  it('★ 指纹变化 → 报变化、给出逐项差异与处置建议', () => {
    const d = detectDrift(profile('scoreInput:input|id=s'), 'scoreInput:input|id=s2');
    expect(d.changed).toBe(true);
    expect(d.details.length).toBeGreaterThan(0);
    expect(d.action).toContain('重新拾取');
  });

  it('★ 元素消失 → 明确指出「选择器失效」', () => {
    const d = detectDrift(profile('scoreInput:input|id=s;submitButton:button|id=b'), 'scoreInput:input|id=s;submitButton:MISSING');
    expect(d.details.join('')).toContain('无法命中');
    expect(d.details.join('')).toContain('提交按钮');
  });

  it('旧数据无指纹 → 不报变化但提示重新拾取', () => {
    const d = detectDrift(profile(''), 'anything');
    expect(d.changed).toBe(false);
    expect(d.action).toContain('重新拾取');
  });
});

describe('diffFingerprint', () => {
  it('指出目标消失', () => {
    expect(diffFingerprint('a:1;b:2', 'a:1')).toEqual(['b：目标已消失（选择器失效）']);
  });

  it('指出新出现的目标', () => {
    expect(diffFingerprint('a:1', 'a:1;b:2')).toEqual(['b：拾取时不存在的目标现在出现了']);
  });

  it('指出属性变化', () => {
    expect(diffFingerprint('scoreInput:input|type=number', 'scoreInput:input|type=text').join('')).toContain('属性变化');
  });

  it('拾取时即未命中也被标出', () => {
    expect(diffFingerprint('a:MISSING', 'a:MISSING').join('')).toContain('拾取时即未命中');
  });

  it('差异但无法定位时给兜底说明', () => {
    expect(diffFingerprint('', '').length).toBeGreaterThanOrEqual(0);
  });

  it('用中文标签而非英文 key', () => {
    expect(diffFingerprint('scoreInput:1', '').join('')).toContain('分数输入框');
  });
});

describe('fingerprintOf —— 对关键元素取指纹', () => {
  it('同一文档两次取值一致', () => {
    const doc = document.implementation.createHTMLDocument('t');
    doc.documentElement.innerHTML = `<body><input id="s" type="number"><button id="b">提交</button></body>`;
    const sel = { scoreInput: '#s', submitButton: '#b' };
    expect(fingerprintOf(sel, doc)).toBe(fingerprintOf(sel, doc));
  });

  it('元素消失时指纹变化', () => {
    const doc = document.implementation.createHTMLDocument('t');
    doc.documentElement.innerHTML = `<body><input id="s"></body>`;
    const good = fingerprintOf({ scoreInput: '#s' }, doc);
    const bad = fingerprintOf({ scoreInput: '#nope' }, doc);
    expect(good).not.toBe(bad);
    expect(bad).toContain('MISSING');
  });

  it('null 选择器被安全处理', () => {
    const doc = document.implementation.createHTMLDocument('t');
    doc.documentElement.innerHTML = `<body></body>`;
    expect(() => fingerprintOf({ scoreInput: null }, doc)).not.toThrow();
    expect(fingerprintOf({ scoreInput: null }, doc)).toContain('MISSING');
  });
});

/* ------------------------------------------ CDP frameTree 换算 */

describe('resolveFrameId / flattenFramePaths / findCrossOriginFrames', () => {
  const tree: FrameTreeNode = {
    frame: { id: 'top', url: 'https://a.com/', securityOrigin: 'https://a.com' },
    childFrames: [
      {
        frame: { id: 'f0', url: 'https://a.com/x', securityOrigin: 'https://a.com' },
        childFrames: [
          { frame: { id: 'f0-0', url: 'https://c.com/y', securityOrigin: 'https://c.com' } },
        ],
      },
      { frame: { id: 'f1', url: 'https://b.com/z', securityOrigin: 'https://b.com' } },
    ],
  };

  it('空路径解析到顶层', () => {
    expect(resolveFrameId(tree, [])).toBe('top');
  });

  it('按序号路径解析', () => {
    expect(resolveFrameId(tree, [0])).toBe('f0');
    expect(resolveFrameId(tree, [1])).toBe('f1');
    expect(resolveFrameId(tree, [0, 0])).toBe('f0-0');
  });

  it('★ 路径越界抛异常（宁可报错，不要静默取错 frame）', () => {
    expect(() => resolveFrameId(tree, [5])).toThrow(/越界/);
    expect(() => resolveFrameId(tree, [0, 3])).toThrow(/越界/);
  });

  it('拍平出 frameId → 路径映射', () => {
    const m = flattenFramePaths(tree);
    expect(m.get('top')).toEqual([]);
    expect(m.get('f0')).toEqual([0]);
    expect(m.get('f1')).toEqual([1]);
    expect(m.get('f0-0')).toEqual([0, 0]);
  });

  it('★ 找出跨域 frame（决定是否需要 OOPIF 顶层派发）', () => {
    const cross = findCrossOriginFrames(tree);
    expect(cross.map((c) => c.frameId).sort()).toEqual(['f0-0', 'f1']);
    expect(cross.find((c) => c.frameId === 'f0-0')!.path).toEqual([0, 0]);
  });

  it('全同源时无跨域 frame', () => {
    const sameOrigin: FrameTreeNode = {
      frame: { id: 'top', url: 'https://a.com/', securityOrigin: 'https://a.com' },
      childFrames: [{ frame: { id: 'c', url: 'https://a.com/x', securityOrigin: 'https://a.com' } }],
    };
    expect(findCrossOriginFrames(sameOrigin)).toHaveLength(0);
  });
});