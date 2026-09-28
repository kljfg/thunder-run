import { defineConfig, type Plugin } from 'vite';
import { readFile, cp, mkdir } from 'node:fs/promises';
import { join, normalize, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 调试壳构建配置（重设计文档 §3.4）。
 * - root = apps/web；内容配置 config/*.json 经 publicDir 以根路径提供（dev 直接读，build 拷入 dist）。
 * - three 由 npm 依赖提供（vendor/three 仅作回滚保险，不再被引用）。
 * - 端口沿用旧 tools/serve.py 的 8767，README/自动化路径不变。
 * - tr-assets 插件（S4）：仓库根 assets/（字体图集等）以 /assets/* 提供——
 *   dev 走中间件直读磁盘，build 时 closeBundle 拷入 dist/assets（wx 侧 S6 走分包，不经这里）。
 */
const assetsDir = fileURLToPath(new URL('../../assets', import.meta.url));
const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function trAssets(): Plugin {
  let outDir = '';
  let isBuild = false;
  return {
    name: 'tr-assets',
    configResolved(cfg) {
      outDir = resolve(cfg.root, cfg.build.outDir);
      isBuild = cfg.command === 'build';
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0] ?? '';
        if (!url.startsWith('/assets/')) return next();
        const p = normalize(join(assetsDir, decodeURIComponent(url.slice('/assets/'.length))));
        if (!p.startsWith(assetsDir)) { res.statusCode = 403; res.end('forbidden'); return; }
        readFile(p)
          .then(buf => {
            res.setHeader('Content-Type', MIME[extname(p).toLowerCase()] ?? 'application/octet-stream');
            res.setHeader('Cache-Control', 'no-store');
            res.end(buf);
          })
          .catch(() => { res.statusCode = 404; res.end('not found'); });
      });
    },
    async closeBundle() {
      if (!isBuild) return;
      await mkdir(join(outDir, 'assets'), { recursive: true });
      await cp(assetsDir, join(outDir, 'assets'), { recursive: true });
    },
  };
}

export default defineConfig({
  publicDir: '../../config',
  plugins: [trAssets()],
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
