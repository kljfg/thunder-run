/**
 * 架构禁令检查（M0 用轻量脚本代替 ESLint 自定义规则，对应 docs/02 §9 / README 约束 C2、C6、docs/10 §4）
 * 规则：
 *   R1 src/core/**  ：禁止 import 'three'、禁止 window/document/localStorage/fetch/wx.、禁止 Math.random（随机必须走 RunRng）
 *   R2 src/render/**：禁止 window/document/localStorage/wx.（three 允许）
 *   R3 src/**       ：单文件不超过 300 行（docs/10 §4「一个文件一个概念」）
 * 用法：node tools/check-import-rules.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** docs/10 §4 的文件行数上限 */
const MAX_FILE_LINES = 300;

const RULES = [
  { glob: 'src/core',   forbid: [[/from ['"]three['"]/g, 'core 禁止依赖 three'], [/\bwindow\./g, 'core 禁止 window'], [/\bdocument\./g, 'core 禁止 document'], [/\blocalStorage\b/g, 'core 禁止 localStorage'], [/\bfetch\(/g, 'core 禁止直接 fetch'], [/\bwx\./g, 'core 禁止 wx API'], [/\bMath\.random\b/g, 'core 禁止 Math.random（用 RunRng）']] },
  { glob: 'src/render', forbid: [[/\bwindow\./g, 'render 禁止 window'], [/\bdocument\./g, 'render 禁止 document'], [/\blocalStorage\b/g, 'render 禁止 localStorage'], [/\bwx\./g, 'render 禁止 wx API']] },
];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith('.ts')) yield p;
  }
}

const violations = [];
for (const rawPath of walk('src')) {
  const file = rawPath.split('\\').join('/'); // Windows 下 join 产生反斜杠，统一后再匹配规则前缀
  const lines = readFileSync(file, 'utf8').split('\n');
  if (lines[lines.length - 1] === '') lines.pop(); // 文件末尾换行不计为一行
  if (lines.length > MAX_FILE_LINES) {
    violations.push(`${file}:1  文件 ${lines.length} 行，超过 docs/10 §4 的 ${MAX_FILE_LINES} 行上限（按概念拆模块）`);
  }
  const rule = RULES.find(r => file.startsWith(r.glob));
  if (!rule) continue;
  lines.forEach((line, i) => {
    // 跳过注释行（行内说明允许出现关键词）
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    for (const [re, msg] of rule.forbid) {
      re.lastIndex = 0;
      if (re.test(line)) violations.push(`${file}:${i + 1}  ${msg}\n      > ${line.trim()}`);
    }
  });
}

if (violations.length) {
  console.error('架构禁令检查失败：');
  violations.forEach(v => console.error('  ✗', v));
  process.exit(1);
}
console.log(`架构禁令检查通过（core/render 无越界引用，所有源文件 ≤${MAX_FILE_LINES} 行）`);
