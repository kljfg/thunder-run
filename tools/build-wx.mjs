/**
 * 微信小游戏构建脚本（S3 最小版；S6 专项任务在此基础上做分包/minify 策略/热更/CLI 上传）。
 * 流程：esbuild 打包 apps/wx/src/main.ts → apps/wx/dist/game.js（iife，含 three），
 *       拷 game.json / project.config.json 与 config/*.json（当前全进主包，分包策略 S6 定）。
 * 用法：node tools/build-wx.mjs [--minify]；或 npm run build:wx（先 tsc -b）。
 * 产物 apps/wx/dist/ 即开发者工具「导入项目」目录（appid: touristappid 游客模式）。
 */
import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const minify = process.argv.includes('--minify');
const src = join(root, 'apps/wx');
const out = join(src, 'dist');

if (!existsSync(join(root, 'packages/platform-wx/dist/wxPlatform.js'))) {
  console.error('未找到 @tr/platform-wx 编译产物：请先 npm run build（tsc -b）或直接用 npm run build:wx');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const result = await build({
  entryPoints: [join(src, 'src/main.ts')],
  outfile: join(out, 'game.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2017'], // 小游戏 v8 运行时原生支持；不开 devtools es6→es5（S11 K10：只会拖慢编译）
  minify,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
  metafile: true,
});

for (const f of ['game.json', 'project.config.json']) {
  copyFileSync(join(src, f), join(out, f));
}
// config 随包走（redesign §2：仓库根单一来源）；主包/分包划分与 CDN 降级链在 S6/S8 落
const cfgOut = join(out, 'config');
mkdirSync(cfgOut, { recursive: true });
for (const f of readdirSync(join(root, 'config')).filter(n => n.endsWith('.json'))) {
  copyFileSync(join(root, 'config', f), join(cfgOut, f));
}

const kb = n => (n / 1024).toFixed(0) + ' KB';
const gameJs = statSync(join(out, 'game.js')).size;
console.log(`apps/wx/dist 就绪（minify=${minify}）：game.js ${kb(gameJs)} + config/ ${readdirSync(cfgOut).length} 个`);
const firstOutput = Object.values(result.metafile.outputs).find(o => o.entryPoint);
if (firstOutput) {
  const top = Object.entries(firstOutput.inputs).sort((a, b) => b[1].bytesInOutput - a[1].bytesInOutput).slice(0, 5);
  for (const [file, v] of top) console.log(`  ${kb(v.bytesInOutput).padStart(9)}  ${file}`);
}
