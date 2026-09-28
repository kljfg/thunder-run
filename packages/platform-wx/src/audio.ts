/**
 * AudioBackend 的微信小游戏实现（S17）：wx.createInnerAudioContext 声部池。
 * 与 extras.ts 同构的可注入设计：wx 对象经参数传入（WxAudioGlobal = WxLike + 音频 API 面），
 * node:test 可 mock 直测；**不改动** wxPlatform.ts/extras.ts/wxTypes.ts/index.ts。
 *
 * TODO(S6 整合会话，接线两处)：
 *   1. wxTypes.ts 的 WxLike 扩 createInnerAudioContext 后，本文件可删掉 WxAudioGlobal 局部扩面；
 *   2. apps/wx 入口装配：`createWxAudioBackend(getWx() as WxAudioGlobal)` 注入 AudioEngine
 *      （注册进 wxPlatform 需改既有文件——所有权纪律禁止，先保持独立导出）。
 *
 * 平台差异备忘：
 * - load 无真预取语义：InnerAudioContext 首次 play() 才拉流，load 仅做 src 句柄化（分包内
 *   文件为本地路径，play 即秒开；CDN 远程音源时首个 play 有延迟，内容侧注意分包位置）；
 * - iOS 同时存活实例上限 10（引擎 sfxMaxLive 默认 8 的由来）：voice.destroy() **必须**真调
 *   ctx.destroy()，池回收交给引擎，本层不自动复用已销毁句柄；
 * - setPaused：逐 voice pause/resume（onHide 时 wx 会自动暂停播放，这里显式做保证语义与 web 对齐）；
 * - unlock：no-op（小游戏无手势解锁策略）。
 */
import type { AudioAsset, AudioBackend, AudioPlayOptions, AudioVoice } from '@tr/platform/audio.js';
import type { WxLike } from './wxTypes.js';

/** wx.createInnerAudioContext() 返回值的最小使用面（基础库 ≥2.19 字段核对后收敛）。 */
export interface WxInnerAudioContext {
  src: string;
  loop: boolean;
  volume: number;
  playbackRate: number;
  play(): void;
  pause(): void;
  resume(): void;
  stop(): void;
  seek(position: number): void;
  destroy(): void;
  onPlay(cb: () => void): void;
  onPause(cb: () => void): void;
  onEnded(cb: () => void): void;
  onError(cb: (err: { errMsg: string }) => void): void;
}

/** 本文件用到的 wx API 扩面（TODO S6：并回 WxLike）。 */
export interface WxAudioGlobal extends WxLike {
  createInnerAudioContext(): WxInnerAudioContext;
}

interface WxAsset extends AudioAsset {
  readonly id: number; // 仅用于调试标识
}

let assetSeq = 0;

class WxAudioVoice implements AudioVoice {
  private readonly ctx: WxInnerAudioContext;
  private endedCb: (() => void) | null = null;
  private playing = false; // 意图态：play() 置位，ended/stop 清位
  private paused = false;
  private destroyed = false;

  constructor(ctx: WxInnerAudioContext, asset: WxAsset) {
    this.ctx = ctx;
    this.ctx.src = asset.src;
    this.ctx.onError((err: { errMsg: string }) => {
      // 出错视同结束：回收在播标记，让池槽位能被复用（引擎侧节流负责防爆音重试）
      console.warn(`[platform-wx] 音频错误 ${asset.src}:`, err.errMsg);
      this.playing = false;
      this.endedCb?.();
    });
    this.ctx.onPlay(() => { this.playing = true; });
    this.ctx.onEnded(() => {
      this.playing = false;
      this.endedCb?.();
    });
  }

  play(opts?: AudioPlayOptions): void {
    if (this.destroyed) return;
    this.ctx.loop = opts?.loop ?? false;
    this.ctx.volume = Math.min(1, Math.max(0, opts?.volume ?? 1));
    if (opts?.playbackRate !== undefined) this.ctx.playbackRate = opts.playbackRate;
    if (this.playing) this.ctx.stop(); // 重触发：从头播（对齐 web「replay 重建 source」语义）
    this.paused = false;
    this.ctx.play();
  }

  stop(): void {
    this.playing = false;
    this.paused = false;
    if (this.destroyed) return;
    try { this.ctx.stop(); } catch { /* 已销毁竞态 */ }
  }

  setVolume(v: number): void {
    if (!this.destroyed) this.ctx.volume = Math.min(1, Math.max(0, v));
  }

  isPlaying(): boolean { return this.playing; }
  onEnded(cb: () => void): void { this.endedCb = cb; }

  /** 整体暂停/恢复（backend.setPaused 转发；自然播放状态用 paused 记忆）。 */
  setPaused(p: boolean): void {
    if (this.destroyed || this.paused === p) return;
    this.paused = p;
    if (p) { if (this.playing) this.ctx.pause(); }
    else if (this.playing) this.ctx.resume();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.playing = false;
    this.destroyed = true;
    try { this.ctx.destroy(); } catch { /* double-destroy 防御 */ }
  }
}

export function createWxAudioBackend(wx: WxAudioGlobal): AudioBackend {
  const voices = new Set<WxAudioVoice>();
  let disposed = false;

  return {
    kind: 'wx',

    async load(src: string): Promise<WxAsset> {
      if (disposed) throw new Error('backend 已 dispose');
      if (!src) throw new Error('音频 src 为空');
      return { src, id: ++assetSeq }; // 惰性资源：InnerAudioContext.play 时才真加载
    },

    unload(): void { /* wx 侧无解码缓存可清（引擎已 destroy 全部 voice） */ },

    createVoice(asset: AudioAsset): AudioVoice {
      const v = new WxAudioVoice(wx.createInnerAudioContext(), asset as WxAsset);
      voices.add(v);
      return v;
    },

    unlock(): void { /* 小游戏无手势解锁要求 */ },

    setPaused(paused: boolean): void {
      for (const v of voices) v.setPaused(paused);
    },

    dispose(): void {
      disposed = true;
      for (const v of voices) v.destroy();
      voices.clear();
    },
  };
}
