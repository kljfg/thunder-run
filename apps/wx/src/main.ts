/**
 * apps/wx 入口（S3 骨架 + S6 分包/config 装载链，redesign §3.5）：
 * platform-wx 适配 + @tr/game 空场景主流程；启动后立即异步走「wx.loadSubpackage(pkg-assets)
 * → extras.readJson 读分包内 config → core.loadAllConfig 校验」验证链（任务 4：与 web 侧
 * loadAllConfig 同一实现，两端同源；web 侧 fetch 链不受影响）。
 * S5（自绘 UI）落地后本入口切换为 createGameFlow（与 apps/web 同源主流程）；届时 config
 * 装载应经 adapter.extras.readJson 作优先源（packages/game 注释 S10 §7.5 已预留，S20 接线）。
 * S11 路线 B 纪律：本文件与打包产物里**没有** window/document 假全局，
 * 唯一垫片是 platform-wx 的画布最小垫片（wx.createCanvas 补 addEventListener/style）。
 */
import { loadAllConfig } from '@tr/core/config/configLoader.js';
import type { LoadReport } from '@tr/core/config/configLoader.js';
import { createWxAdapter } from '@tr/platform-wx/wxPlatform.js';
import { getWx } from '@tr/platform-wx/wxTypes.js';
import { PKG_ASSETS, loadWxSubpackage, subpackageAssetPath } from '@tr/platform-wx/subpackage.js';
import { bootEmptyMain } from '@tr/game/emptyMain.js';

const adapter = createWxAdapter();
const main = bootEmptyMain(adapter);

let configReport: LoadReport | null = null;

/** 分包加载 → 分包内 config 校验链（不阻塞空场景渲染；失败只记日志不崩）。 */
async function loadAssets(): Promise<void> {
  const extras = adapter.extras;
  if (!extras) {
    console.warn('[tr-wx] adapter.extras 缺失（非 wx 运行时？），跳过分包装载链');
    return;
  }
  const cost = await loadWxSubpackage(getWx(), PKG_ASSETS, p => {
    if (p % 25 === 0) console.log(`[tr-wx] subpackage ${PKG_ASSETS} ${p}%`);
  });
  console.log(`[tr-wx] subpackage ${PKG_ASSETS} loaded in ${cost}ms`);
  const report = await loadAllConfig(
    {
      fetchJson: path => extras.readJson(path), // wx 侧：分包/包内文件走 readJson（S8 在此叠 CDN 优先源）
      cacheGet: k => adapter.storage.get(k),
      cacheSet: (k, v) => adapter.storage.set(k, v),
    },
    name => subpackageAssetPath('config', `${name}.json`),
  );
  configReport = report;
  console.log(`[tr-wx] config chain ${JSON.stringify({ ok: report.ok, sources: report.sources, errors: report.errors })}`);
}

loadAssets().catch(e => console.error('[tr-wx] 分包/config 装载失败:', (e as Error).message));

// 开发者工具 Console 探针：__trWx.stats()（fps/尺寸）/ __trWx.configReport()（装载链结果，boot 前为 null）
// / __trWx.loadAssets()（手动重跑装载链）/ __trWx.dispose()
(globalThis as Record<string, unknown>).__trWx = { ...main, configReport: () => configReport, loadAssets };
console.log('[tr-wx] boot', JSON.stringify(main.stats()));

// 每 2s 打一条 fps（性能面板录制 30s 时对照用；S16b 遥测合入后由正式通道接管）
setInterval(() => console.log('[tr-wx] stats', JSON.stringify(main.stats())), 2000);
