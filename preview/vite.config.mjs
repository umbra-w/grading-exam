/**
 * 界面预览的 Vite 配置。
 *
 * 为什么需要一个单独配置而不是命令行传参：
 *   `--outDir` 是相对 **root** 解析的，不是相对当前工作目录。
 *   实测 `vite build preview --outDir preview/dist` 会把产物写到
 *   `preview/preview/dist/`，而静态服务在 `preview/dist/` 找不到文件，
 *   于是报 404 —— 而且构建日志显示"成功"，极易误判。
 *   这里用绝对路径彻底消掉这个歧义。
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';

const here = dirname(fileURLToPath(import.meta.url));

export default {
  root: here,
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(here, '..', 'src', 'shared'),
    },
  },
  build: {
    // 绝对路径：不依赖 cwd，也不受 root 影响
    outDir: resolve(here, 'dist'),
    emptyOutDir: true,
    target: 'chrome120',
  },
};