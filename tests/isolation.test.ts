/**
 * 路径隔离：本地确定性判定不得依赖 AI / 网络。
 *
 * ── 为什么需要这个测试，而不是"注意一点就好" ──────────────────────────────
 *
 * 项目有一条硬承诺（SPEC §3.6 / AGENTS.md §1.1）：
 *   **客观题是确定性比对，零网络、零 token、结果可复现。**
 *
 * 这条承诺会被**最善意的方式**破坏。想象一个真实场景：
 * 有人觉得"6 和 6.0 应该都算对，但 6 和 6.00 也可能不对"，于是加一句
 * "拿不准时交给模型判一下"。改动很小、动机合理、评审也容易放过。
 * 后果却是：
 *   · 同一份答卷两次跑可能不一样（非确定性），可复现性没了
 *   · 每道客观题都烧 token，而客观题通常是卷子里最多的一类
 *   · **因果被污染**：模型判错时，你分不清是学生错了还是比对错了
 *   · 老师看不到任何异常——成绩单看起来完全正常
 *
 * 所以这里用**源码级依赖断言**把它钉死：本地路径的文件里
 * 不允许出现网络 API、AI 客户端、爬虫依赖的引用。
 *
 * ── 为什么是源码级而不是运行时 spy ──────────────────────────────────────
 *
 * 运行时 spy 只能证明"这一次没联网"，不能阻止下一个人引入依赖。
 * 源码级断言在**编译之前**就拦住，而且失败信息直接指向那行 import。
 * 两者互补：运行时 spy 也在（见 objective.test.ts 的零网络用例）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

/**
 * 必须保持"无网络、无 AI"的模块 —— **本地确定性路径**。
 *
 * 这些模块的共同点：输入确定则输出确定，不能有外部状态。
 * 一旦其中一个引入了网络或 AI，那条路径的可复现性就没了。
 */
const LOCAL_PATH_MODULES = [
  { file: 'src/shared/objective.ts', why: '客观题比对：零网络零 token 的核心承诺' },
  { file: 'src/shared/selector.ts', why: '选择器生成：结构与文本的纯变换' },
  { file: 'src/shared/locator.ts', why: '候选排序：纯打分逻辑' },
  { file: 'src/main/page/geometry.ts', why: '坐标换算：纯数学' },
  { file: 'src/main/page/picker.ts', why: '拾取组装与漂移检测：纯逻辑' },
  { file: 'src/main/ai/ensemble.ts', why: '分歧度汇总：聚合已拿到的结果，自身不联网' },
  { file: 'src/main/io/export.ts', why: '导出：把已有数据写盘，不联网' },
];

/**
 * 禁止出现在上述模块里的依赖/API。
 *
 * 用带词边界的正则而不是简单 includes：`fetchTokenCount` 这种命名
 * 不该被误判，而 `await fetch(` 必须被抓到。
 */
const FORBIDDEN: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bfetch\s*\(/, label: 'fetch()' },
  { pattern: /\bXMLHttpRequest\b/, label: 'XMLHttpRequest' },
  { pattern: /\baxios\b/, label: 'axios' },
  { pattern: /\bundici\b/, label: 'undici' },
  { pattern: /\bnode:https?\b/, label: "node:http(s) 模块" },
  { pattern: /\bfrom\s+['"]node:(net|dns|tls)['"]/, label: 'node 网络模块' },
  { pattern: /['"]\.\.?\/ai\//, label: 'AI 层相对引用' },
  { pattern: /\b(gradeQuestion|callAI|testConnection|visionAnswers)\b/, label: 'AI 客户端函数' },
  { pattern: /\bnew\s+WebSocket\b/, label: 'WebSocket' },
  { pattern: /\bEventSource\b/, label: 'EventSource' },
  { pattern: /\bnavigator\.sendBeacon\b/, label: 'sendBeacon' },
];

/** 去掉注释与字符串字面量，避免"注释里提到 fetch"被误判为真引用 */
function stripNoise(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1') // 行注释（避免误伤 https://）
    .replace(/`[^`]*`/g, '``') // 模板串
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

describe('P5-2/P5-3 本地确定性路径与 AI/网络隔离', () => {
  it('测试清单本身不为空（防止清单被清空后假绿）', () => {
    expect(LOCAL_PATH_MODULES.length).toBeGreaterThanOrEqual(5);
    expect(FORBIDDEN.length).toBeGreaterThanOrEqual(8);
  });

  it('清单里的文件都真实存在（防止改名后检查静默失效）', () => {
    const missing = LOCAL_PATH_MODULES.filter((m) => !existsSync(resolve(ROOT, m.file)));
    expect(missing.map((m) => m.file)).toEqual([]);
  });

  for (const mod of LOCAL_PATH_MODULES) {
    it(`${mod.file} 不引用网络 / AI（${mod.why}）`, () => {
      const src = stripNoise(readFileSync(resolve(ROOT, mod.file), 'utf8'));
      const hits = FORBIDDEN.filter((f) => f.pattern.test(src));
      // 失败时把命中的依赖名列出来，直接指向要改的那行
      expect(hits.map((h) => h.label)).toEqual([]);
    });
  }

  it('客观题比对模块**不 import 任何 AI 客户端**', () => {
    const src = readFileSync(resolve(ROOT, 'src/shared/objective.ts'), 'utf8');
    // 这条比上面的通用检查更具体：明确禁止 ai/client 的引用路径
    expect(src).not.toMatch(/from\s+['"][^'"]*ai\/(client|compat|prompts)['"]/);
    expect(src).not.toMatch(/from\s+['"][^'"]*main\//);
  });

  it('parse.ts 不联网（它只读本地文件）', () => {
    const src = stripNoise(readFileSync(resolve(ROOT, 'src/main/io/parse.ts'), 'utf8'));
    expect(FORBIDDEN.filter((f) => f.pattern.test(src)).map((f) => f.label)).toEqual([]);
  });

  it('主进程的 objective:compare handler 体内不含网络/AI 调用', () => {
    // 通道实现最容易在"顺手多做一点"时被污染：比如顺手记个远程埋点
    const src = readFileSync(resolve(ROOT, 'src/main/main.ts'), 'utf8');
    const at = src.indexOf("ipcMain.handle(\n    'objective:compare'");
    expect(at).toBeGreaterThan(-1);
    // 取该 handler 起的一段（到下一个 ipcMain.handle 之前）
    const rest = src.slice(at);
    const next = rest.indexOf('ipcMain.handle', 10);
    const body = stripNoise(next > 0 ? rest.slice(0, next) : rest);
    expect(FORBIDDEN.filter((f) => f.pattern.test(body)).map((f) => f.label)).toEqual([]);
  });

  it('反向验证 stripNoise 真的会去掉注释（否则本测试可能假绿）', () => {
    // 若 stripNoise 失效，注释里的 fetch 会让上面的用例假红——
    // 假红还算安全。真正危险的是它"过度删除"导致真引用漏检，
    // 所以这里验证它保留了代码、只去掉了注释。
    const sample = `
      // 这里提到 fetch 只是注释
      /* fetch( 也是注释 */
      const a = 'fetch("字符串里的不算")';
      const real = fetch(x);
    `;
    const out = stripNoise(sample);
    expect(out).not.toContain('注释');
    expect(out).toMatch(/\bfetch\s*\(/); // 真实调用必须留下
  });

  it('FORBIDDEN 的每条规则都能命中它该命中的样本（防止规则写成永远不匹配）', () => {
    // 一条写错的正则会让检查静默失效：永远不命中，于是"通过"毫无意义
    const samples: Array<[string, string]> = [
      ['fetch()', 'await fetch(url)'],
      ['XMLHttpRequest', 'new XMLHttpRequest()'],
      ['axios', "import axios from 'axios'"],
      ['undici', "import { request } from 'undici'"],
      ['node:http(s) 模块', "import http from 'node:http'"],
      ['AI 客户端函数', 'gradeQuestion(payload)'],
      ['WebSocket', 'new WebSocket(url)'],
      ['EventSource', 'new EventSource(url)'],
    ];
    for (const [label, sample] of samples) {
      const rule = FORBIDDEN.find((f) => f.label === label);
      expect(rule, `缺少规则 ${label}`).toBeDefined();
      expect(rule!.pattern.test(sample), `规则「${label}」没有命中样本：${sample}`).toBe(true);
    }
  });
});