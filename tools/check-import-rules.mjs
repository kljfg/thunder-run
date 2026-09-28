/**
 * 架构禁令检查（对应 docs/02 §9 / README 约束 C2、C6、docs/10 §4；重设计文档 §2 升级适配 monorepo）
 * 规则：
 *   R1 packages/core/**   ：禁止 import 'three'；禁止 window/document/localStorage/fetch/wx.；
 *                           禁止 Math.random（随机必须走 RunRng）
 *   R2 packages/render/** ：禁止 window/document/localStorage/fetch/wx.（three 允许）
 *   R3 packages/(render|ui|game)/** ：禁止 import @tr/platform-web / @tr/platform-wx
 *                           （只有 platform-* 与 apps/* 可触平台实现）
 *   R4 所有包源文件       ：单文件不超过 300 行（docs/10 §4「一个文件一个概念」）
 *   R5 wx 全局（S3 新增） ：packages/platform-wx 是全项目唯一允许触碰 wx 全局的包，
 *                           apps/wx/*（工程入口与垫片）豁免；其余所有包与 apps 一律禁止
 * 用法：node tools/check-import-rules.mjs
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** docs/10 §4 的文件行数上限 */
const MAX_FILE_LINES = 300;

/** DOM/BOM 全局访问（重设计文档 §2：平台 API 只能经 platform-* 包进入） */
const DOM_GLOBALS = [
  [/\bwindow\./g, '禁止直接使用 window'],
  [/\bdocument\./g, '禁止直接使用 document'],
  [/\blocalStorage\b/g, '禁止直接使用 localStorage'],
  [/\bfetch\(/g, '禁止直接调用 fetch'],
  [/\bwx\./g, '禁止直接使用 wx API'],
];

/** 只允许 platform-* 包与 apps/* import 的平台实现包 */
const PLATFORM_IMPLS = [
  [/from ['"]@tr\/platform-(web|wx)(\/|['"])/g, '禁止 import 平台实现包 @tr/platform-web / @tr/platform-wx（只允许 apps/* 与 platform 装配边界使用）'],
];

/** R5：wx 全局只许出现在 packages/platform-wx（apps/wx 入口垫片除外）；core/render/ui/game 已由 DOM_GLOBALS 覆盖 */
const WX_BAN = [/\bwx\./g, 'R5：wx 全局只允许 packages/platform-wx 触碰（apps/wx 入口/垫片除外）'];

/** R5 镜像：platform-wx 反向禁令——不许混入 web 全局（宿主能力一律映射到 wx API） */
const WEB_GLOBALS = [
  [/\bwindow\./g, 'R5：platform-wx 禁止 web 全局 window（应映射 wx API）'],
  [/\bdocument\./g, 'R5：platform-wx 禁止 web 全局 document（应映射 wx API）'],
  [/\blocalStorage\b/g, 'R5：platform-wx 禁止 localStorage（用 wx.*StorageSync）'],
];

const NO_PLATFORM = ['@tr/render', '@tr/ui', '@tr/game']; // 包目录名：render / ui / game

function* walkTs(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'build') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walkTs(p);
    else if (p.endsWith('.ts')) yield p;
  }
}

/** 收集 <root> 下存在的源码目录（src/ 或包根），不存在则跳过（如 @tr/game 尚未建包） */
function sourcesUnder(base) {
  if (!existsSync(base)) return [];
  const out = [];
  for (const name of readdirSync(base)) {
    const pkgDir = join(base, name);
    if (!statSync(pkgDir).isDirectory()) continue;
    for (const cand of [join(pkgDir, 'src'), pkgDir]) {
      if (existsSync(cand) && statSync(cand).isDirectory()) {
        out.push(...walkTs(cand));
        break;
      }
    }
  }
  return out;
}

const violations = [];
const files = [
  ...sourcesUnder('packages'),
  ...sourcesUnder('apps'),
].map(p => p.split('\\').join('/')); // Windows 反斜杠统一为 / 再匹配

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  if (lines[lines.length - 1] === '') lines.pop(); // 文件末尾换行不计为一行
  if (lines.length > MAX_FILE_LINES) {
    violations.push(`${file}:1  文件 ${lines.length} 行，超过 docs/10 §4 的 ${MAX_FILE_LINES} 行上限（按概念拆模块）`);
  }
  const inCore = file.startsWith('packages/core/');
  const inRender = file.startsWith('packages/render/');
  const inPlatformFree = NO_PLATFORM.some(p => file.startsWith('packages/' + p.slice(4) + '/'));
  const inPlatformWx = file.startsWith('packages/platform-wx/');
  const inAppsWx = file.startsWith('apps/wx/');

  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // 行内注释允许出现关键词
    const hit = (re, msg) => {
      re.lastIndex = 0;
      if (re.test(line)) violations.push(`${file}:${i + 1}  ${msg}\n      > ${line.trim()}`);
    };
    if (inCore) {
      hit(/from ['"]three['"]/g, 'core 禁止依赖 three');
      hit(/\bMath\.random\b/g, 'core 禁止 Math.random（用 RunRng）');
    }
    if (inCore || inRender || inPlatformFree) for (const [re, msg] of DOM_GLOBALS) hit(re, msg);
    if (inPlatformFree) for (const [re, msg] of PLATFORM_IMPLS) hit(re, msg);
    // R5：platform-wx 之外、且 core/render/ui/game 之外（那三类已被 DOM_GLOBALS 覆盖 wx.）禁 wx.
    if (!inCore && !inRender && !inPlatformFree && !inPlatformWx && !inAppsWx) hit(WX_BAN[0], WX_BAN[1]);
    if (inPlatformWx) for (const [re, msg] of WEB_GLOBALS) hit(re, msg);
  });
}

if (violations.length) {
  console.error('架构禁令检查失败：');
  violations.forEach(v => console.error('  ✗', v));
  process.exit(1);
}
console.log(`架构禁令检查通过（${files.length} 个源文件：无平台越界引用、wx 全局仅在 platform-wx/apps-wx，全部 ≤${MAX_FILE_LINES} 行）`);
