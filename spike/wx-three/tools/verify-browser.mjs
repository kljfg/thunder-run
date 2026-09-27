/**
 * 浏览器自动冒烟（无微信开发者工具时的替代验证，仅路线 B 保真）。
 * 用 playwright-core 驱动本机 Edge headless：
 *   1. 加载 preview（wxmock + minigame-b/game.js bundle，真 WebGL2 上下文）
 *   2. 断言：three 启动、纹理上传（info.memory.textures>=1）、帧循环推进、
 *      固定步长与渲染帧同量级、触摸日志、无页面错误
 *   3. 截图 preview/shot-b.png，输出 stats 基线
 * 用法：node tools/verify-browser.mjs
 */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startSpikeServer } from './serve-spike.mjs';

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const exePath = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!exePath) {
  console.error('找不到 Edge，可改 verify-browser.mjs 的 EDGE_CANDIDATES');
  process.exit(2);
}

const PORT = 8791;
const server = await startSpikeServer(PORT);
const browser = await chromium.launch({ executablePath: exePath, headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); // iPhone 尺寸感

const logs = [];
const errors = [];
page.on('console', (m) => logs.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

let exitCode = 0;
try {
  await page.goto(`http://127.0.0.1:${PORT}/preview/index.html?route=b`, { waitUntil: 'load' });

  // 等 three 启动并跑满 ~90 帧
  await page.waitForFunction(() => window.__spike && window.__spike.stats().frames > 90, null, {
    timeout: 15000,
  });

  // 合成触摸
  await page.evaluate(() => {
    window.__mockFireTouch('start', 100, 200);
    window.__mockFireTouch('move', 130, 260);
    window.__mockFireTouch('end', 130, 260);
  });
  await page.waitForTimeout(300);

  const result = await page.evaluate(() => {
    const s = window.__spike;
    return {
      stats: s.stats(),
      info: s.info(),
      textures: s.renderer.info.memory.textures,
      geometries: s.renderer.info.memory.geometries,
      simTime: s.simTime(),
      touchHandlers: window.__mockTouchCount(),
      isWebGL2: typeof WebGL2RenderingContext !== 'undefined'
        && s.renderer.getContext() instanceof WebGL2RenderingContext,
      dpr: s.renderer.getPixelRatio(),
    };
  });

  const touchLogged = logs.some((l) => l.includes('[spike:B] touch start'));
  const bootLogged = logs.some((l) => l.includes('[spike:B] boot'));
  const texLogged = logs.some((l) => l.includes('[spike:tex] loaded'));

  const checks = [
    ['无页面错误', errors.length === 0, errors.join(' | ')],
    ['boot 日志', bootLogged],
    ['纹理加载日志', texLogged],
    ['纹理已上传 (memory.textures>=1)', result.textures >= 1, 'textures=' + result.textures],
    ['帧循环推进 (frames>90)', result.stats.frames > 90, 'frames=' + result.stats.frames],
    ['固定步长推进 (steps≈frames±20%)',
      Math.abs(result.stats.steps - result.stats.frames) / result.stats.frames < 0.2,
      `steps=${result.stats.steps} frames=${result.stats.frames}`],
    ['模拟时间前进 (simTime>1s)', result.simTime > 1, 'simTime=' + result.simTime.toFixed(2)],
    ['触摸处理器已注册 (>=4)', result.touchHandlers >= 4, 'n=' + result.touchHandlers],
    ['触摸日志', touchLogged],
    ['WebGL2 上下文', result.isWebGL2],
  ];

  console.log('--- verify-browser (route B, Edge headless) ---');
  for (const [name, ok, extra] of checks) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  [' + extra + ']' : ''));
    if (!ok) exitCode = 1;
  }
  console.log('stats:', JSON.stringify(result.stats));
  console.log('renderer.info.render:', JSON.stringify(result.info), 'dpr=', result.dpr);

  await page.screenshot({ path: fileURLToPath(new URL('../preview/shot-b.png', import.meta.url)) });
  console.log('screenshot → preview/shot-b.png');

  const interesting = logs.filter((l) => l.includes('[spike'));
  console.log('--- console ([spike*] 摘录，前 25 条) ---');
  interesting.slice(0, 25).forEach((l) => console.log('  ' + l));
} catch (err) {
  console.error('VERIFY FAILED:', err.message);
  console.error('errors:', errors.join(' | '));
  console.error('last logs:', logs.slice(-10).join(' | '));
  exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
process.exit(exitCode);
