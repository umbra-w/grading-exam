import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    // 默认 node 环境：AI 层的 I/O 与清洗逻辑不需要 DOM，跑得更快。
    // 需要 DOM 的测试文件在顶部加 `// @vitest-environment jsdom` 自行声明
    //（见 tests/selector.test.ts）——那批测试用 jsdom 而不是浏览器，
    // 是为了在没有 GUI 的环境里也能跑（本机 Electron 起不来，见 BLOCKERS.md B3）。
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    reporters: ['default'],
  },
  resolve: {
    alias: {
      // 用 import.meta.dirname 而非 __dirname：Vite 的 native config loader 不支持后者
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@': resolve(import.meta.dirname, 'src/renderer'),
    },
  },
});