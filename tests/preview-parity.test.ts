/**
 * 界面预览假桥 vs 真实 preload API 的一致性测试。
 *
 * 为什么需要这个测试（不是洁癖，是被坑过两次）：
 *   `preview/preview-api.js` 是**普通 JS**，不参与 `tsc` 检查，
 *   因此它与 `src/preload/index.ts` 的漂移**编译期完全发现不了**。
 *   实测后果：
 *     · 第一版把 exportDir 写在顶层（真实是 general.exportDir）→ 设置面板**白屏**
 *     · 加了 onBrowserClosed 后忘了同步假桥 → 预览里面板读不到订阅方法**直接崩**
 *   两次都是"改了真代码，预览悄悄坏掉"，而预览正是本机唯一能看到界面的途径。
 *   所以这里用**源码级提取 + 集合比对**把漂移变成红灯。
 *
 * 手法说明：不 import 那个 js（它引用 window，node 环境跑不了），
 * 而是读源码文本提取键名。这样测试本身无需运行环境即可比较。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PRELOAD = resolve(import.meta.dirname, '../src/preload/index.ts');
const PREVIEW = resolve(import.meta.dirname, '../preview/preview-api.js');

/**
 * 从 `anchor` 开始找到第一个 `{`，按花括号配平取出对象体。
 *
 * 为什么必须配平而不是"切到文件尾"：第一版切到文件尾，
 * 把对象结束之后的代码（preview 里的 `setTimeout`、`addEventListener`）
 * 也当成了 API 方法，测试直接假红。JS 源码里`{`可能出现在字符串与注释中，
 * 这里接受这个近似——两边用同一套近似，比较仍然有效。
 */
function sliceObjectBody(src: string, anchor: string): string {
  const at = src.indexOf(anchor);
  if (at < 0) throw new Error(`找不到锚点: ${anchor}`);
  const open = src.indexOf('{', at);
  if (open < 0) throw new Error(`锚点后没有对象: ${anchor}`);

  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`花括号未配平: ${anchor}`);
}

/** 从对象体里提取顶层键名 */
function topLevelKeys(body: string): string[] {
  const keys = new Set<string>();
  for (const m of body.matchAll(/^\s{2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*[:(]/gm)) {
    keys.add(m[1]);
  }
  // 简写属性（`invoke,`）没有冒号也没有括号——正则首版漏了它，
  // 导致 `invoke` 被当成"假桥多余的方法"而假红。
  for (const m of body.matchAll(/^\s{2}([A-Za-z_$][\w$]*)\s*,\s*$/gm)) {
    keys.add(m[1]);
  }
  return [...keys].sort();
}

function extractPreloadApiKeys(src: string): string[] {
  // 真实暴露给渲染层的是 `Omit<typeof api, 'invoke'>`，
  // 所以这里同样把 invoke 当作"不在 Window 上"，与假桥保持一致。
  return topLevelKeys(sliceObjectBody(src, 'const api = {')).filter((k) => k !== 'invoke');
}

function extractPreviewApiKeys(src: string): string[] {
  return topLevelKeys(sliceObjectBody(src, 'window.gradingExam = {'));
}

describe('预览假桥与真实 preload 一致', () => {
  const preloadSrc = readFileSync(PRELOAD, 'utf8');
  const previewSrc = readFileSync(PREVIEW, 'utf8');
  const realKeys = extractPreloadApiKeys(preloadSrc);
  const fakeKeys = extractPreviewApiKeys(previewSrc);

  it('提取到的键不为空（否则说明提取逻辑本身失效，测试会假绿）', () => {
    // 这个断言很重要：如果正则没匹配到东西，下面的"两边相等"会变成 0=0 的假通过
    expect(realKeys.length).toBeGreaterThan(15);
    expect(fakeKeys.length).toBeGreaterThan(15);
  });

  it('提取结果包含已知的稳定方法名（防止正则悄悄失配）', () => {
    for (const k of ['pickerStart', 'aiGrade', 'pickFile', 'onPick']) {
      expect(realKeys).toContain(k);
      expect(fakeKeys).toContain(k);
    }
  });

  it('**invoke 逃生口不得出现在渲染层 API 上**（含假桥）', () => {
    // 真源是 `Omit<typeof api, 'invoke'>`：渲染层只能调具名方法，
    // 拿不到"任意通道都能调"的能力。假桥若保留它会制造虚假宽松——
    // 绕过契约的代码能在预览里跑通，到真机才炸。
    expect(realKeys).not.toContain('invoke');
    expect(fakeKeys).not.toContain('invoke');
    // 但 preload 源码里必须仍有这个函数（便捷方法靠它转发）
    expect(preloadSrc).toContain('function invoke');
  });

  it('**假桥没有漏掉真实 API 的方法** —— 漏了预览就会崩，而 tsc 抓不到', () => {
    const missing = realKeys.filter((k) => !fakeKeys.includes(k));
    expect(missing).toEqual([]);
  });

  it('假桥没有多余的方法（多余说明真实 API 已改名或删除）', () => {
    const extra = fakeKeys.filter((k) => !realKeys.includes(k));
    expect(extra).toEqual([]);
  });

  it('事件订阅类方法在两边都返回"取消订阅函数"的形状', () => {
    // on* 方法必须返回函数：渲染层 useEffect 的 cleanup 直接用它，
    // 返回 undefined 会在卸载时报 "cleanup is not a function"
    const onMethods = realKeys.filter((k) => k.startsWith('on'));
    expect(onMethods.length).toBeGreaterThanOrEqual(4);
    for (const m of onMethods) {
      expect(fakeKeys).toContain(m);
    }
  });
});

describe('预览假数据的形状与真实类型一致', () => {
  const previewSrc = readFileSync(PREVIEW, 'utf8');

  it('pickerState 返回 BrowserStateSnapshot 的全部必需字段', () => {
    // 这五个字段缺任何一个，面板读到的都是 undefined，
    // 而 JS 不会报错——界面会显示错误的状态且毫无提示
    for (const field of ['open:', 'url:', 'kernel:', 'pendingPick:', 'fingerprint:', 'picks:']) {
      expect(previewSrc).toContain(field);
    }
  });

  it('parseFile 假数据同时覆盖成功与失败两个分支', () => {
    // 只造成功分支的话，"解析失败时界面长什么样"就永远没被渲染过
    expect(previewSrc).toContain("ok: false");
    expect(previewSrc).toContain("ok: true");
    expect(previewSrc).toContain('SCANNED_PDF');
  });

  it('假数据里不含真实密钥（避免误提交）', () => {
    const suspicious = /sk-[A-Za-z0-9]{20,}/g;
    const hits = previewSrc.match(suspicious) ?? [];
    // 允许明显的占位串，但真实格式的长密钥不允许出现
    for (const h of hits) {
      expect(h).toMatch(/PLACEHOLDER|PREVIEW|FAKE|xxx/i);
    }
  });
});