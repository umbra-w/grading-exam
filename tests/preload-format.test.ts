/**
 * 打包契约：preload 产物必须是 .cjs。
 *
 * 为什么需要这个测试（这是一次真实事故，不是假想）：
 *   2026-10-26 打包后的 exe 在真机上"窗口一闪而过"。拿诊断日志才看到：
 *
 *     ReferenceError: require is not defined in ES module scope
 *     at .../app.asar/out/preload/index.js:1:16
 *     This file is being treated as an ES module because it has a '.js' file
 *     extension and '.../app.asar/package.json' contains "type": "module".
 *
 *   成因是三方冲突：
 *     · electron.vite.config.ts 的 preload 设了 `format: 'cjs'`（内容确实是 CJS）
 *     · 但 `entryFileNames: '[name].js'`（扩展名却是 .js）
 *     · 而打包后的 package.json 带 `"type": "module"`
 *   → Node 按 ESM 解析一份 CJS 文件 → require 未定义 → preload 加载失败
 *   → window.gradingExam 不存在 → 渲染层白屏 → 窗口随即消失。
 *
 * 为什么必须用测试钉住、而不是靠人记住：
 *   这个缺陷**在任何本地检查里都看不见** —— tsc 过、vitest 过、build 过、
 *   界面预览（Edge + 假 IPC 桥）也过，因为假桥替代了真 preload，根本不加载它。
 *   只有把 exe 拿到真机上双击才会暴露。这类"本地全绿、真机必炸"的配置错误
 *   必须有一条随代码走的断言，否则同样的坑会以同样的方式再踩一次。
 *
 * 注意：这是**源码级契约检查**，证明的是"配置说对了"，
 * 不是"真机能跑"。真正的端到端验证仍需一台能启动 Electron 的机器。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf-8');

describe('preload 产物扩展名契约（.cjs）', () => {
  it('electron.vite.config.ts 的 preload 输出名必须是 .cjs', () => {
    const cfg = read('electron.vite.config.ts');
    // 定位 preload 段：从 `preload: {` 到 `renderer: {`
    const start = cfg.indexOf('preload: {');
    const end = cfg.indexOf('renderer: {');
    expect(start, 'electron.vite.config.ts 里找不到 preload 段').toBeGreaterThan(-1);
    expect(end, 'electron.vite.config.ts 里找不到 renderer 段').toBeGreaterThan(start);
    const preloadSection = cfg.slice(start, end);

    // 内容格式必须是 cjs
    expect(preloadSection).toMatch(/format:\s*'cjs'/);
    // 扩展名必须是 .cjs —— 这正是当初写错的那一处
    expect(preloadSection).toMatch(/entryFileNames:\s*'\[name\]\.cjs'/);
    // 反向断言：不允许再出现 [name].js（.cjs 里本就含 .js 子串，故要精确匹配）
    expect(preloadSection).not.toMatch(/entryFileNames:\s*'\[name\]\.js'/);
  });

  it('主进程加载 preload 的路径必须是 .cjs', () => {
    const main = read('src/main/main.ts');
    expect(main).toMatch(/preload:\s*join\(__dirname_,\s*'\.\.\/preload\/index\.cjs'\)/);
    expect(main).not.toMatch(/preload:\s*join\(__dirname_,\s*'\.\.\/preload\/index\.js'\)/);
  });

  it('阅卷页 preload（viewer）路径必须是 .cjs', () => {
    const browser = read('src/main/page/browser.ts');
    expect(browser).toMatch(/\.\.\/preload\/viewer\.cjs/);
    expect(browser).not.toMatch(/\.\.\/preload\/viewer\.js/);
  });

  it('check_package.py 必须按 .cjs 校验应用文件存在性', () => {
    const checker = read('scripts/check_package.py');
    expect(checker).toMatch(/out\/preload\/index\.cjs/);
    expect(checker).toMatch(/out\/preload\/viewer\.cjs/);
    expect(checker).not.toMatch(/out\/preload\/index\.js/);
  });

  it('package.json 仍是 type: module（这是要求 .cjs 的前提，不能悄悄改掉）', () => {
    const pkg = JSON.parse(read('package.json')) as { type?: string };
    // 若哪天有人把 type 改成 commonjs，那 .cjs 就不再是必需 ——
    // 但主进程产物是 ESM（含 import 语句），改 type 会让主进程炸。
    // 所以这个前提必须保持，这里显式钉住。
    expect(pkg.type).toBe('module');
  });

  it('构建产物若存在，preload 必须是 .cjs 且内容为 CJS', () => {
    const cjsIndex = resolve(ROOT, 'out/preload/index.cjs');
    const cjsViewer = resolve(ROOT, 'out/preload/viewer.cjs');
    // 未构建时跳过产物断言，但配置断言（上面几条）始终生效
    if (!existsSync(cjsIndex)) return;

    expect(existsSync(cjsViewer), 'viewer.cjs 缺失').toBe(true);
    // 反向断言：旧的 .js 绝不能再产出，否则又会被当成 ESM
    expect(existsSync(resolve(ROOT, 'out/preload/index.js')), 'out/preload/index.js 不该存在').toBe(false);
    expect(existsSync(resolve(ROOT, 'out/preload/viewer.js')), 'out/preload/viewer.js 不该存在').toBe(false);

    for (const f of ['out/preload/index.cjs', 'out/preload/viewer.cjs']) {
      const raw = read(f);
      expect(raw, `${f} 内容是 CJS 才对`).toMatch(/require\(/);
      expect(raw, `${f} 不能有顶层 ESM import`).not.toMatch(/^import /m);
    }
  });
});