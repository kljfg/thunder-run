/**
 * 组装入口（game 层，对应 docs/09 T0.5 + M1）
 * 职责：创建平台适配 → 场景状态机 → 加载配置 → 驱动页面流转；
 *       跑酷局内：每次进入 run 场景创建全新 RunnerSim（seed 记录在案，可复现），
 *       渲染场景消费 sim 事件；死亡 1.2s 后自动进结算页。
 */
import { loadAllConfig } from '@tr/core/config/configLoader.js';
import type { GameContent } from '@tr/core/config/configTypes.js';
import type { FileSource } from '@tr/core/config/configLoader.js';
import { createSceneMachine } from '@tr/core/scene/sceneMachine.js';
import type { SceneName } from '@tr/core/scene/sceneMachine.js';
import { RunnerSim } from '@tr/core/sim/runnerSim.js';
import { hashSeed } from '@tr/core/rng.js';
import { createWebPlatform } from '@tr/platform-web/webPlatform.js';
import { createRunnerScene } from '@tr/render/runnerScene.js';
import { renderBoot, renderLogin, renderMenu, renderResult, createRunHud, toast } from './ui/screens.js';
import type { RunSummary } from './ui/screens.js';

const adapter = createWebPlatform();
let content: GameContent | null = null;
let sources: Record<string, FileSource> = {};
let scene: { dispose(): void } | null = null;
let hud: ReturnType<typeof createRunHud> | null = null;
let lastSeed = 0;

const BEST_KEY = 'thunderrun:b…st';
const CHAR_KEY = 'thunderrun:character';
const bestScore = () => Number(adapter.storage.get(BEST_KEY) ?? 0);
/** 上次选的角色（本机记忆；账号级保存在 M3 接后端） */
let charId = adapter.storage.get(CHAR_KEY) ?? 'char_volt';

// ---------------- 场景机 ----------------
const machine = createSceneMachine<SceneName>({
  boot: {},
  login: { onEnter: () => renderLogin({ onGuest: () => machine.go('menu') }) },
  menu: {
    onEnter: () => content && renderMenu(content, sources, {
      onStartRun: id => { charId = id; adapter.storage.set(CHAR_KEY, id); machine.go('run'); },
      onClearCache: () => {
        Object.keys(sources).forEach(k => adapter.storage.remove('thunderrun:config:' + k));
        adapter.storage.remove('thunderrun:lastUser');
        toast('已清除，重新加载页面生效');
      },
    }, charId),
  },
  run: {
    onEnter: () => {
      if (!content) return;
      lastSeed = hashSeed('run-' + Date.now());
      const sim = new RunnerSim(content, lastSeed, charId);
      const host = adapter.createCanvasHost(document.getElementById('screen')!);
      hud = createRunHud();
      document.body.appendChild(hud.el);
      hud.update({ score: 0, coins: 0, distance: 0, hits: 0, lives: sim.lives, buffs: [], skill: null });
      scene = createRunnerScene(host, adapter, sim, content, {
        onHud: h => hud?.update(h),
        onEnd: summary => machine.go('result', summary),
        debug: location.search.includes('debug'),
      });
    },
    onExit: () => { scene?.dispose(); scene = null; hud?.el.remove(); hud = null; },
  },
  result: {
    onEnter: ctx => {
      const summary = ctx as RunSummary;
      const best = bestScore();
      if (summary.score > best) adapter.storage.set(BEST_KEY, String(summary.score));
      renderResult(summary, best, {
        onRetry: () => machine.go('run'),
        onMenu: () => machine.go('menu'),
      });
    },
  },
}, 'boot');

// ---------------- 全局按键：run 中 Esc 退出到菜单 ----------------
adapter.onKey(code => {
  if (code === 'Escape' && machine.current() === 'run') machine.go('menu');
});

// 调试钩子：暴露场景机当前状态（?debug 时）
if (location.search.includes('debug')) {
  (globalThis as Record<string, unknown>).__trMachine = machine;
  (globalThis as Record<string, unknown>).__trSeed = () => lastSeed; // 复现本局赛道用：node 端同 seed 重放 TrackGen
}

// 空格开始页快捷（登录页回车=游客进入）
document.addEventListener('keydown', e => {
  if (e.code === 'Enter' && machine.current() === 'login') (document.querySelector('.btn-primary') as HTMLButtonElement | null)?.click();
});

// ---------------- 启动流程 ----------------
async function boot() {
  const bootUi = renderBoot(() => {});
  const report = await loadAllConfig(
    {
      fetchJson: url => adapter.fetchJson(url),
      cacheGet: k => adapter.storage.get(k),
      cacheSet: (k, v) => adapter.storage.set(k, v),
    },
    // config/*.json 由 Vite publicDir 挂载到站点根路径（重设计文档 §2：config 留在仓库根，两端共用）
    name => `./${name}.json`,
  );
  sources = report.sources;
  if (!report.ok) {
    bootUi.statusEl.textContent = '配置加载失败：\n' + report.errors.join('\n');
    bootUi.statusEl.style.whiteSpace = 'pre-wrap';
    bootUi.statusEl.style.color = '#ff8f8f';
    return; // 停在启动页，错误信息可见（不静默吞错）
  }
  content = report.content;
  machine.go('login');
}
boot();
