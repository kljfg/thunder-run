/**
 * 默认声音注册表与 sim 事件→音效映射（S17 管线用占位资源，内容侧按 assets/audio/README.md 替换）。
 * src 为**相对约定路径**：web 侧宿主（apps/web 整合会话）拼站点根；wx 侧指分包内文件。
 * 事件名与 @tr/core SimEvent.type / 输入动作一致，接线样例见 docs/audio-events.md。
 * 优先级分档：1 环境类（金币）/ 2 操作反馈（跳铲）/ 3 状态变化（护盾破）/ 4 关键节点（受击、技能）/
 * 5 结算级（必须出声，抢占一切）。
 */
import type { SoundDef } from './types.js';

export const DEFAULT_SOUNDS: readonly SoundDef[] = [
  { id: 'sfx_coin', src: 'assets/audio/sfx_coin.mp3', kind: 'sfx', priority: 1, maxVoices: 4, throttleMs: 45 },
  { id: 'sfx_jump', src: 'assets/audio/sfx_jump.mp3', kind: 'sfx', priority: 2, maxVoices: 2, throttleMs: 100 },
  { id: 'sfx_slide', src: 'assets/audio/sfx_slide.mp3', kind: 'sfx', priority: 2, maxVoices: 2, throttleMs: 100 },
  { id: 'sfx_hit', src: 'assets/audio/sfx_hit.mp3', kind: 'sfx', priority: 4, maxVoices: 2, throttleMs: 250 },
  { id: 'sfx_skill', src: 'assets/audio/sfx_skill.mp3', kind: 'sfx', priority: 4, maxVoices: 2, throttleMs: 300 },
  { id: 'sfx_result', src: 'assets/audio/sfx_result.mp3', kind: 'sfx', priority: 5, maxVoices: 1, throttleMs: 500 },
  { id: 'bgm_menu', src: 'assets/audio/bgm_menu.mp3', kind: 'bgm' },
  { id: 'bgm_run', src: 'assets/audio/bgm_run.mp3', kind: 'bgm' },
];

/** SimEvent.type → sfx id（runnerScene.consumeEvents 的挂点表；未列事件=暂无音效，内容侧扩展）。 */
export const EVENT_SOUNDS: Readonly<Record<string, string>> = {
  coin: 'sfx_coin',
  hit: 'sfx_hit',
  cast: 'sfx_skill',
  shieldBreak: 'sfx_hit', // 占位复用；内容侧拆独立音后在此改 id
  boardBreak: 'sfx_hit',
  death: 'sfx_result', // 死亡 sting；结算页进入音另挂 result onEnter（见 audio-events.md）
};

/** 输入动作 → sfx id（runnerScene onInput 的挂点表）。 */
export const ACTION_SOUNDS: Readonly<Record<string, string>> = {
  jump: 'sfx_jump',
  slide: 'sfx_slide',
  skill: 'sfx_skill',
};
