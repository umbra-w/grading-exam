/**
 * 拾取上报协议的一致性。
 *
 * ── 这个测试防的是一次真实的、彻底的静默失败 ─────────────────────────────
 *
 * 曾经的代码：
 *   · 页面侧 `viewer.ts` 发的是**裸的** `RawPagePick`
 *   · 主进程 `browser.ts` 按 `{ raw, framePath }` 去读
 *
 * 后果不是"某个平台不行"，而是 **`payload.raw` 恒为 undefined，
 * 每一次拾取都被丢弃**——普通页面也一样。用户看到"点了没反应"，
 * 日志只有一行轻描淡写的"格式异常已忽略"。
 *
 * 两边的类型分别定义在 preload（无法被主进程 import，因为运行在隔离世界）
 * 和 main/page 里，所以这是一个**必然存在两份声明**的边界。
 * 既然消不掉重复，就得把它钉死：逐字段比对，不一致就红。
 *
 * 同样的手法已在 `tests/preview-parity.test.ts` 上验证有效
 * （假桥与真实 API 的漂移也是同类问题）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parsePickReport, framePathFromFrameId } from '../src/main/page/picker';
import { flattenFramePaths } from '../src/main/page/cdp';

const ROOT = resolve(import.meta.dirname, '..');

/** 取 `interface NAME { ... }` 的字段名集合（花括号配对，避免切到下一个 interface） */
function interfaceFields(src: string, name: string): string[] {
  return fieldsOfBody(interfaceBody(src, name));
}

/** 取出 interface 的**正文**（不含花括号本身）。用于把注释排除在检查之外。 */
function interfaceBody(src: string, name: string): string {
  const re = new RegExp(`(?:export\\s+)?interface\\s+${name}\\s*\\{`, 'g');
  const m = re.exec(src);
  if (!m) throw new Error(`找不到 interface ${name}`);
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(start, i - 1);
}

function fieldsOfBody(body: string): string[] {
  let clean = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  // 先抹掉数组/泛型/对象字面量的内部，否则 `candidates?: Array<{kind: string; score: number}>`
  // 里的 `score` 会被当成顶层字段解析出来（这是本测试第一版真实踩到的坑）。
  clean = clean.replace(/Array<[^>]*>/g, 'Array');
  clean = clean.replace(/\{[^{}]*\}/g, '{}');
  const fields: string[] = [];
  for (const line of clean.split(/[;\n]/)) {
    const f = /^\s*([A-Za-z_$][\w$]*)\s*\??\s*:/.exec(line);
    if (f) fields.push(f[1]!);
  }
  return [...new Set(fields)].sort();
}

describe('拾取上报协议（跨进程边界的形状约定）', () => {
  const viewerSrc = readFileSync(resolve(ROOT, 'src/preload/viewer.ts'), 'utf8');
  const pickerSrc = readFileSync(resolve(ROOT, 'src/main/page/picker.ts'), 'utf8');

  it('两侧的拾取结构字段集合完全一致', () => {
    const pageFields = interfaceFields(viewerSrc, 'PagePick');
    const mainFields = interfaceFields(pickerSrc, 'RawPagePick');
    // 逐字段比对：多一个少一个都说明协议漂移
    expect(pageFields).toEqual(mainFields);
  });

  it('提取到的字段不是空集（防止正则失效后两边都为空而"相等"）', () => {
    const pageFields = interfaceFields(viewerSrc, 'PagePick');
    expect(pageFields.length).toBeGreaterThanOrEqual(8);
    for (const f of ['kind', 'selector', 'localX', 'localY', 'width', 'height', 'tag', 'text']) {
      expect(pageFields).toContain(f);
    }
  });

  it('内联对象类型里的字段不被误认为顶层字段（本测试第一版真实踩到的坑）', () => {
    // `candidates?: Array<{ kind: string; score: number }>` 中的 score/kind
    // 属于内层对象，不是 PagePick 的字段
    const pageFields = interfaceFields(viewerSrc, 'PagePick');
    expect(pageFields).toContain('candidates');
    expect(pageFields.filter((f) => f === 'score')).toEqual([]);
  });

  it('页面侧发送的就是裸对象，没有多包一层', () => {
    // 这正是当初翻车的地方：包了一层 { raw } 却没人按那层读。
    // 断言 send 的第二参直接是 payload 变量，而不是 { raw: payload } 之类。
    const m = /ipcRenderer\.send\(\s*['"]page:picked['"]\s*,\s*([^)]+)\)/.exec(viewerSrc);
    expect(m, '找不到 page:picked 的发送语句').not.toBeNull();
    const arg = m![1]!.trim();
    expect(arg).toBe('payload');
    expect(arg).not.toMatch(/\braw\b/);
  });

  it('主进程的拾取处理里没有再读 .raw 包裹层', () => {
    // 只检查**代码**，不检查注释——注释里刻意保留了这次事故的说明
    //（"于是 payload.raw 永远是 undefined"），那是有价值的记录不是缺陷。
    // 所以这里排除注释后再断言。
    const src = readFileSync(resolve(ROOT, 'src/main/page/browser.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/\.raw\b/);
  });

  it('parsePickReport 接受真实形状的上报', () => {
    const sample = {
      kind: 'scoreInput',
      selector: '#score',
      localX: 10,
      localY: 20,
      width: 100,
      height: 24,
      tag: 'input',
      text: '',
      candidates: [{ kind: 'css', selector: '#score', score: 50 }],
      frameId: 3,
    };
    const r = parsePickReport(sample);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.report.kind).toBe('scoreInput');
      expect(r.report.localX).toBe(10);
      expect(r.report.frameId).toBe(3);
      expect(r.report.candidates).toHaveLength(1);
    }
  });

  it('parsePickReport 接受被包了一层的旧形状吗？—— 不接受，并说明原因', () => {
    // 这不是"向后兼容"该做的事：如果接受旧形状，就永远发现不了
    // 页面侧还在多发一层。宁可显式拒绝并报出具体原因。
    const r = parsePickReport({ raw: { kind: 'scoreInput', localX: 1 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/kind/);
  });

  it('各种坏上报都被拒绝，且原因里有字段名', () => {
    const cases: Array<[unknown, RegExp]> = [
      [null, /不是对象/],
      ['str', /不是对象/],
      [{}, /kind/],
      [{ kind: 'nope' }, /kind/],
      [{ kind: 'scoreInput' }, /localX/],
      [{ kind: 'scoreInput', localX: 1, localY: 2, width: 3, height: 4 }, /tag/],
      [{ kind: 'scoreInput', localX: 1, localY: 2, width: NaN, height: 4, tag: 'i' }, /width/],
      [{ kind: 'scoreInput', localX: 1, localY: 2, width: 3, height: 4, tag: 'i' }, /selector/],
    ];
    for (const [input, re] of cases) {
      const r = parsePickReport(input);
      expect(r.ok, `应拒绝：${JSON.stringify(input)}`).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(re);
    }
  });

  it('selector 允许空串（坐标模式），但不允许非字符串', () => {
    const base = { kind: 'scoreInput', localX: 1, localY: 2, width: 3, height: 4, tag: 'i' };
    expect(parsePickReport({ ...base, selector: '' }).ok).toBe(true);
    expect(parsePickReport({ ...base, selector: 123 }).ok).toBe(false);
  });

  it('text 缺失时补空串而不是失败（剪贴板/隐藏元素可能没有文本）', () => {
    const r = parsePickReport({
      kind: 'submitButton', selector: '#b', localX: 0, localY: 0, width: 1, height: 1, tag: 'button',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.report.text).toBe('');
  });
});

describe('framePath 反查', () => {
  /** 造一棵两层树：顶层 + 两个子 frame，其中一个还有子 frame */
  const tree = {
    frame: { id: '10', url: 'https://p.example/', securityOrigin: 'https://p.example' },
    childFrames: [
      { frame: { id: '11', url: 'https://a.example/', securityOrigin: 'https://a.example' }, childFrames: [] },
      {
        frame: { id: '12', url: 'https://b.example/', securityOrigin: 'https://b.example' },
        childFrames: [
          { frame: { id: '13', url: 'https://c.example/', securityOrigin: 'https://c.example' }, childFrames: [] },
        ],
      },
    ],
  };

  it('flattenFramePaths 给出正确的序号路径', () => {
    const m = flattenFramePaths(tree);
    expect(m.get('10')).toEqual([]);
    expect(m.get('11')).toEqual([0]);
    expect(m.get('12')).toEqual([1]);
    expect(m.get('13')).toEqual([1, 0]);
  });

  it('framePathFromFrameId 按 frameId 查到路径', () => {
    const m = flattenFramePaths(tree);
    expect(framePathFromFrameId(10, m)).toEqual([]);
    expect(framePathFromFrameId(13, m)).toEqual([1, 0]);
  });

  it('顶层 frame 返回空数组（合法的空路径，不是失败）', () => {
    const m = flattenFramePaths(tree);
    const p = framePathFromFrameId(10, m);
    expect(p).toEqual([]);
    expect(Array.isArray(p)).toBe(true);
  });

  it('查不到时**抛错**，绝不兜底成顶层路径', () => {
    const m = flattenFramePaths(tree);
    // 兜底成 [] 会把 iframe 内坐标当顶层坐标用 —— 分数会填到无关位置
    expect(() => framePathFromFrameId(999, m)).toThrow(/找不到 frameId=999/);
    // 错误信息要能让真机上的第一次运行直接给出答案
    expect(() => framePathFromFrameId(999, m)).toThrow(/不是同一编号体系/);
  });

  it('frameId 缺失时抛错', () => {
    const m = flattenFramePaths(tree);
    expect(() => framePathFromFrameId(undefined, m)).toThrow(/没有可用的 frameId/);
  });

  it('返回的路径是副本，调用方改动不会污染映射表', () => {
    const m = flattenFramePaths(tree);
    const p = framePathFromFrameId(13, m);
    p.push(99);
    expect(m.get('13')).toEqual([1, 0]);
  });
});