/**
 * 构建脚本：esbuild 打两条路线的小游戏包。
 *   npm run build      → minigame-a/（官方 weapp-adapter + 补丁）
 *                        minigame-b/（自写最小垫片）
 *   npm run build:min  → 同上但 minify（对照主包体积）
 *
 * 每个产物目录 = 可直接被微信开发者工具「导入项目」的完整小游戏工程：
 *   game.js / game.json / project.config.json / assets/tex.png
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const minify = process.argv.includes('--minify');

const routes = [
  {
    name: 'a',
    entry: 'src/entry-a.js',
    out: 'minigame-a',
    projectname: 'wx-three-spike-a',
    description: 'S11 spike route A: official weapp-adapter + three patch',
  },
  {
    name: 'b',
    entry: 'src/entry-b.js',
    out: 'minigame-b',
    projectname: 'wx-three-spike-b',
    description: 'S11 spike route B: minimal hand-written shim',
  },
];

const shellGameJson = readFileSync(join(root, 'shell/game.json'), 'utf8');
const shellProjectConfig = readFileSync(join(root, 'shell/project.config.json'), 'utf8');

for (const r of routes) {
  const outDir = join(root, r.out);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, 'assets'), { recursive: true });

  const result = await build({
    entryPoints: [join(root, r.entry)],
    outfile: join(outDir, 'game.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2017'],
    minify,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
    metafile: true,
  });

  writeFileSync(join(outDir, 'game.json'), shellGameJson);
  writeFileSync(
    join(outDir, 'project.config.json'),
    shellProjectConfig
      .replace('__PROJECTNAME__', r.projectname)
      .replace('__DESCRIPTION__', r.description)
  );
  copyFileSync(join(root, 'assets/tex.png'), join(outDir, 'assets/tex.png'));

  const kb = (statSync(join(outDir, 'game.js')).size / 1024).toFixed(0);
  console.log(`route ${r.name.toUpperCase()} → ${r.out}/game.js  ${kb} KB (minify=${minify})`);
  const outputs = Object.values(result.metafile.outputs);
  for (const o of outputs) {
    if (!o.entryPoint) continue;
    const deps = Object.entries(o.inputs).sort((a, b) => b[1].bytesInOutput - a[1].bytesInOutput);
    for (const [file, v] of deps.slice(0, 5)) {
      console.log(`    ${(v.bytesInOutput / 1024).toFixed(1).padStart(7)} KB  ${file}`);
    }
  }
}
console.log('done. 用微信开发者工具「导入项目」选择 minigame-a/ 或 minigame-b/（appid: touristappid 游客模式）');
