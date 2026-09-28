/**
 * apps/wx 入口（S3 骨架，redesign §3.5）：platform-wx 适配 + @tr/game 空场景主流程。
 * S11 路线 B 纪律：本文件与打包产物里**没有** window/document 假全局，
 * 唯一垫片是 platform-wx 的画布最小垫片（wx.createCanvas 补 addEventListener/style）。
 * S5（自绘 UI）落地后本入口切换为 createGameFlow（与 apps/web 同源主流程）。
 */
import { createWxAdapter } from '@tr/platform-wx/wxPlatform.js';
import { bootEmptyMain } from '@tr/game/emptyMain.js';

const main = bootEmptyMain(createWxAdapter());

// 开发者工具 Console 探针：__trWx.stats()（fps/尺寸，与性能面板交叉核对）/ __trWx.dispose()
(globalThis as Record<string, unknown>).__trWx = main;
console.log('[tr-wx] boot', JSON.stringify(main.stats()));

// 每 2s 打一条 fps（性能面板录制 30s 时对照用；S6 构建管线接入正式遥测后移除）
setInterval(() => console.log('[tr-wx] stats', JSON.stringify(main.stats())), 2000);
