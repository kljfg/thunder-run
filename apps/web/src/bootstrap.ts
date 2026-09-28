/**
 * 网页调试壳入口（apps/web，重设计文档 §3.4）——只做「装配」：
 * 创建 web 平台适配（挂载点在此查 DOM 后注入，主流程不再出现 document，S10 §7.1）
 * → 注入 DOM 版 GameViews → 交给 @tr/game 的共用主流程驱动。
 * 跑酷局本身的组装/生命周期逻辑全在 packages/game（两端同源）。
 */
import { createWebPlatform } from '@tr/platform-web/webPlatform.js';
import { createGameFlow } from '@tr/game/mainFlow.js';
import { createWebViews } from './views.js';

const adapter = createWebPlatform({ mount: document.getElementById('screen')! });
const views = createWebViews();
const flow = createGameFlow({
  adapter,
  views,
  // config/*.json 由 Vite publicDir 挂载到站点根路径（重设计 §2：config 留仓库根，两端共用）
  configResolve: name => `./${name}.json`,
  debug: location.search.includes('debug'),
});

// Enter 提交登录：v1 的 document.querySelector('.btn-primary') DOM hack 废止（S10 §7.4），
// 改走 adapter.onInput 的 key 事件并只驱动 web 视图句柄（S5 自绘 UI 后由页面级 keymap 接管）。
adapter.onInput(e => {
  if (e.type === 'key' && e.phase === 'down' && e.code === 'Enter' && flow.machine.current() === 'login') {
    views.submitLogin();
  }
});

// 调试钩子：暴露场景机与最近 seed（?debug 时；局内探针 __trRun.* 由 packages/render 挂载）
if (location.search.includes('debug')) {
  (globalThis as Record<string, unknown>).__trMachine = flow.machine;
  (globalThis as Record<string, unknown>).__trSeed = () => flow.currentSeed(); // 同种子复现赛道用
}

// ---------------- 启动 ----------------
flow.boot();
