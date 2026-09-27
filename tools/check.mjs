/**
 * 一键质量检查：编译 + 单元测试 + 配置校验 + 架构禁令（本机版「运行测试.bat」，.bat 里写死的旧 Node 路径本机不可用）
 * 用法：node tools/check.mjs（或 npm run check）
 * 全部通过输出 ALL PASS；任何一步失败立即以该步退出码退出。
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

const STEPS = [
  ['编译 TypeScript', ['tools/vendor/typescript/lib/tsc.js', '-p', 'tsconfig.json']],
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
