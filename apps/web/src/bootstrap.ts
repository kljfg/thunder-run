/**
 * 网页调试壳入口（apps/web，重设计文档 §3.4）——只做「装配」：
 * 创建 web 平台适配（挂载点在此查 DOM 后注入）→ 自绘 UI 壳（uiShell：透明 UI canvas +
 * 原始 pointer 流）→ overlay 版 GameViews（packages/game/src/ui，两端同源）→ 共用主流程驱动。
 * 键盘：adapter key-down 全量转发 views.onKey（页面级 keymap：Enter 提交登录在页面内消费；
 * Esc 退出 run 在 mainFlow），web 壳不再有 .btn-primary DOM 查询 hack。
 */
import { createWebPlatform } from '@tr/platform-web/webPlatform.js';
import { createGameFlow } from '@tr/game/mainFlow.js';
import { createOverlayViews } from '@tr/game/ui/overlayViews.js';
import { createUiShell } from './uiShell.js';

const mount = document.getElementById('screen')!;
const debug = location.search.includes('debug');

async function main(): Promise<void> {
  const adapter = createWebPlatform({ mount });
  const shell = await createUiShell(adapter);
  const views = createOverlayViews({ host: shell.host });
  shell.host.start();
  // UI 就绪：撤掉 index.html 的静态占位文案（此后画布之上不再需要 DOM）
  mount.textContent = '';

  const flow = createGameFlow({
    adapter,
    views,
    // config/*.json 由 Vite publicDir 挂载到站点根路径（重设计 §2：config 留仓库根，两端共用）
    configResolve: name => `./${name}.json`,
    debug,
  });

  // 键盘注入（仅 web 壳有物理键盘；wx 不发 key 事件，天然空转）
  adapter.onInput(e => {
    if (e.type === 'key' && e.phase === 'down') views.onKey(e.code);
  });

  // 调试钩子：暴露场景机与最近 seed（?debug 时；局内探针 __trRun.* 由 packages/render 挂载）
  if (debug) {
    (globalThis as Record<string, unknown>).__trMachine = flow.machine;
    (globalThis as Record<string, unknown>).__trSeed = () => flow.currentSeed(); // 同种子复现赛道用
    (globalThis as Record<string, unknown>).__trUi = { shell, views, version: 1 }; // S5：自绘 UI 快照挂载点
  }

  // ---------------- 启动 ----------------
  await flow.boot();
}

main().catch(err => {
  mount.textContent = `启动失败：${err instanceof Error ? err.message : String(err)}`;
});
