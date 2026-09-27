import { defineConfig } from 'vite';

/**
 * 调试壳构建配置（重设计文档 §3.4）。
 * - root = apps/web；内容配置 config/*.json 经 publicDir 以根路径提供（dev 直接读，build 拷入 dist）。
 * - three 由 @tr/render 的 npm 依赖提供（vendor/three 仅作回滚保险，不再被引用）。
 * - 端口沿用旧 tools/serve.py 的 8767，README/自动化路径不变。
 */
export default defineConfig({
  publicDir: '../../config',
  server: {
    host: '127.0.0.1',
    port: 8767,
    strictPort: true,
    // TR_NO_OPEN=1：CI/自动化冒烟时不弹浏览器（人双击 .bat 时照旧自动打开）
    open: !process.env.TR_NO_OPEN,
  },
  optimizeDeps: {
    include: ['three'],
  },
  build: {
    target: 'es2021',
    sourcemap: true,
  },
});
