import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/main.ts') },
      },
    },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // 两个 preload：主界面 API，以及注入阅卷页的拾取器
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          viewer: resolve(__dirname, 'src/preload/viewer.ts'),
        },
        output: {
          // 阅卷页 preload 需要传统脚本格式注入，不能是 ESM
          format: 'cjs',
          // ★ 必须是 .cjs，不能是 .js。
          //   打包后的 package.json 带 "type": "module"，所以名为 .js 的文件会被
          //   Node 按 ESM 解析，而这里产出的内容是 CJS（`require("electron")`），
          //   于是 Electron 加载 preload 时直接抛
          //   「ReferenceError: require is not defined in ES module scope」。
          //   后果不是报错退出，而是 window.gradingExam 不存在 → 渲染层白屏
          //   → 窗口随即消失，正是"窗口一闪而过"的真因（2026-10-26 实测定位）。
          entryFileNames: '[name].cjs',
        },
      },
    },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@': resolve(__dirname, 'src/renderer'),
      },
    },
  },
});