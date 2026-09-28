/**
 * GameViews —— 主流程对「页面视图」的结构化要求（@tr/game，S3 提取）。
 * apps/web 用 DOM screens.ts 实现（过渡期；S5 换 packages/ui 后两端同源）；
 * apps/wx 在 S5 前走空场景主流程（emptyMain.ts），不实现本接口。
 * 本包受禁令约束：这里禁止出现任何 DOM/wx 类型，视图内部长什么样由 apps 自决。
 */
import type { GameContent } from '@tr/core/config/configTypes.js';
import type { FileSource } from '@tr/core/config/configLoader.js';
import type { RunnerSim } from '@tr/core/sim/runnerSim.js';
import type { RunCallbacks } from '@tr/render/runnerScene.js';

/** 结算摘要（与 core RunnerSim.summary() 同源） */
export type RunSummary = ReturnType<RunnerSim['summary']>;
/** HUD 快照（与 render RunCallbacks.onHud 参数同源，避免双份定义漂移） */
export type HudData = Parameters<RunCallbacks['onHud']>[0];

export interface MenuActions {
  onStartRun(charId: string): void;
  onClearCache(): void;
}

/** 启动页句柄：setStatus(text, isError) —— 错误样式（换行/红色）属视图细节，由实现方自理 */
export interface BootHandle {
  setStatus(text: string, isError: boolean): void;
}

/** 登录页句柄：submit = 「回车提交」入口（v1 的 .btn-primary DOM click hack 收进视图实现，S10 §7.4） */
export interface LoginHandle {
  submit(): void;
}

/** 局内 HUD：挂载即创建（DOM 层 append 由实现方自理），dispose 即移除 */
export interface HudHandle {
  update(h: HudData): void;
  dispose(): void;
}

export interface GameViews {
  renderBoot(): BootHandle;
  renderLogin(actions: { onGuest(): void }): LoginHandle;
  renderMenu(
    content: GameContent,
    sources: Record<string, FileSource>,
    actions: MenuActions,
    currentCharId: string,
  ): void;
  mountHud(): HudHandle;
  renderResult(summary: RunSummary, best: number, actions: { onRetry(): void; onMenu(): void }): void;
  toast(msg: string): void;
}
