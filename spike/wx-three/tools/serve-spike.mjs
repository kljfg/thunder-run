/**
 * spike 静态服务器（预览/验证用）。根 = spike/wx-three/。
 * 特殊路由：/preview/assets/* → minigame-b/assets/*（两路线纹理同一文件）。
 * 用法：node tools/serve-spike.mjs [port]，默认 8790。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const port = Number(process.argv[2] || 8790);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.css': 'text/css; charset=utf-8',
};

export function startSpikeServer(listenPort = port) {
  const server = createServer(async (req, res) => {
    try {
      let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (urlPath === '/') urlPath = '/preview/index.html';
      if (urlPath.startsWith('/preview/assets/')) {
        urlPath = urlPath.replace('/preview/assets/', '/minigame-b/assets/');
      }
      const filePath = normalize(join(root, urlPath));
      if (!filePath.startsWith(normalize(root))) {
        res.writeHead(403); res.end('forbidden'); return;
      }
      const data = await readFile(filePath);
      res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(listenPort, '127.0.0.1', () => resolve(server));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  startSpikeServer().then(() => {
    console.log(`spike preview: http://127.0.0.1:${port}/preview/index.html?route=b`);
  });
}
