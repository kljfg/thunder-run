/**
 * 一键质量检查：编译 + 单元测试 + 配置校验 + 架构禁令（等价 运行测试.bat）
 * 用法：node tools/check.mjs（或 npm run check）
 * 全部通过输出 ALL PASS；任何一步失败立即以该步退出码退出。
 * M5 起：编译走 node_modules 的 typescript + `tsc -b`（根 tsconfig.json 是 solution 引用链，
 * 产物在各包 dist/；旧 tools/vendor 的 tsc -p 单项目方式已随之退役）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
if (!existsSync(join(root, 'node_modules/typescript/bin/tsc'))) {
  console.error('缺少 node_modules（npm workspaces 依赖）：请先在仓库根执行 npm install');
  process.exit(1);
}

const STEPS = [
  ['编译 TypeScript（tsc -b）', ['node_modules/typescript/bin/tsc', '-b']],
  ['运行单元测试', ['--test', 'tests/*.test.mjs']],
  ['配置校验', ['tools/validate-config.mjs']],
  ['架构禁令检查', ['tools/check-import-rules.mjs']],
];

STEPS.forEach(([name, args], i) => {
  console.log(`[${i + 1}/${STEPS.length}] ${name}...`);
  const r = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\n############ 第 ${i + 1} 步「${name}」失败，请先修复 ############`);
    process.exit(r.status ?? 1);
  }
});
console.log('\n============ ALL PASS ============');
