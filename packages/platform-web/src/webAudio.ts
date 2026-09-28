/**
 * AudioBackend 的网页实现（S17）：AudioContext + AudioBufferSourceNode + GainNode。
 * 独立导出（不改 webPlatform.ts —— 文件所有权纪律）；apps/web 整合会话里
 * `const backend = createWebAudioBackend()` 注入 AudioEngine 即可演示。
 *
 * 关键点：
 * - AudioContext **懒建**（首次 load/unlock 时 new）：避免未交互就弹 iOS 警告；
 * - iOS 自动播放策略：unlock() 挂一次性 pointerdown/keydown/touchend 监听 → ctx.resume()，
 *   触发或 dispose 后自摘除；running 前 play() 排入 pending 队列，resume 后统一补发；
 * - 每条 AudioVoice 一个 GainNode（常驻），每次 play() 新建一次性 BufferSource（WebAudio 规范），
 *   stop() 置 stoppedFlag 防止 onended 误报自然结束（后端契约要求）；
 * - setPaused = ctx.suspend/resume：暂停期间已排程 source 计时冻结，恢复即续（比 wx 精确）。
 */
import type { AudioAsset, AudioBackend, AudioPlayOptions, AudioVoice } from '@tr/platform/audio.js';

interface WebAudioAsset extends AudioAsset {
  readonly buffer: AudioBuffer;
}

class WebAudioVoice implements AudioVoice {
  private gain: GainNode;
  private source: AudioBufferSourceNode | null = null;
  private endedCb: (() => void) | null = null;
  private stoppedFlag = false;
  private playing = false;
  private destroyed = false;

  constructor(private ctx: AudioContext, readonly asset: WebAudioAsset, private onDestroy: () => void) {
    this.gain = ctx.createGain();
    this.gain.connect(ctx.destination);
  }

  play(opts?: AudioPlayOptions): void {
    if (this.destroyed) return;
    const ctx = this.ctx;
    const start = () => {
      if (this.destroyed) return;
      this.teardownSource();
      const src = ctx.createBufferSource();
      src.buffer = this.asset.buffer;
      src.loop = opts?.loop ?? false;
      if (opts?.playbackRate !== undefined) src.playbackRate.value = opts.playbackRate;
      src.connect(this.gain);
      this.gain.gain.value = opts?.volume ?? 1;
      this.stoppedFlag = false;
      this.playing = true;
      src.onended = () => {
        if (!this.stoppedFlag && this.playing) {
          this.playing = false;
          this.endedCb?.();
        }
      };
      this.source = src;
      try { src.start(0); } catch { this.playing = false; } // 已结束/非法状态：静默（下次 play 重建）
    };
    if (ctx.state === 'suspended') pendingUnlockOps.push(start); // iOS 解锁前排队
    else start();
  }

  stop(): void {
    this.stoppedFlag = true;
    this.playing = false;
    try { this.source?.stop(); } catch { /* 未 start 或已结束 */ }
    this.teardownSource();
  }

  setVolume(v: number): void { if (!this.destroyed) this.gain.gain.value = Math.min(1, Math.max(0, v)); }
  isPlaying(): boolean { return this.playing; }
  onEnded(cb: () => void): void { this.endedCb = cb; }

  destroy(): void {
    if (this.destroyed) return;
    this.stop();
    this.destroyed = true;
    this.gain.disconnect();
    this.onDestroy();
  }

  /** 断掉一次性 source（stop 后重建前清理引用；onended 守卫位已在 stop 处理）。 */
  private teardownSource(): void {
    const src = this.source;
    this.source = null;
    if (!src) return;
    try { src.onended = null; src.disconnect(); } catch { /* 忽略 */ }
  }
}

/** unlock 前排队的 play 闭包（模块级：跨 backend 实例唯一解锁语义，实际只会有一个实例）。 */
const pendingUnlockOps: Array<() => void> = [];

export function createWebAudioBackend(): AudioBackend {
  let ctx: AudioContext | null = null;
  const voices = new Set<WebAudioVoice>();
  const buffers = new Map<string, AudioBuffer>();
  let unlockListeners: Array<keyof WindowEventMap> = [];
  let disposed = false;

  const getCtx = (): AudioContext => (ctx ??= new AudioContext({ latencyHint: 'interactive' }));

  const flushPending = (): void => {
    const ops = pendingUnlockOps.splice(0, pendingUnlockOps.length);
    for (const op of ops) op();
  };

  const detachUnlock = (): void => {
    for (const evt of unlockListeners) window.removeEventListener(evt, onUserGesture);
    unlockListeners = [];
  };

  function onUserGesture(): void {
    const c = getCtx();
    if (c.state === 'suspended') void c.resume().then(() => { if (c.state === 'running') flushPending(); });
    detachUnlock();
  }

  return {
    kind: 'web',

    async load(src: string): Promise<WebAudioAsset> {
      if (disposed) throw new Error('backend 已 dispose');
      const cached = buffers.get(src);
      if (cached) return { src, buffer: cached };
      const res = await fetch(src, { cache: 'force-cache' });
      if (!res.ok) throw new Error(`音频加载失败 HTTP ${res.status}: ${src}`);
      const buf = await res.arrayBuffer();
      // decodeAudioData 在 suspended 状态也可用；成功后才建 ctx 会浪费，先取 ctx 引用
      const buffer = await getCtx().decodeAudioData(buf.slice(0));
      buffers.set(src, buffer);
      return { src, buffer };
    },

    unload(asset: AudioAsset): void {
      buffers.delete(asset.src);
    },

    createVoice(asset: AudioAsset): AudioVoice {
      const v = new WebAudioVoice(getCtx(), asset as WebAudioAsset, () => voices.delete(v));
      voices.add(v);
      return v;
    },

    unlock(): void {
      if (disposed || !('AudioContext' in window)) return;
      const c = getCtx();
      if (c.state === 'running') { flushPending(); return; }
      detachUnlock(); // 幂等：先摘旧监听再挂（多次 unlock 不叠加）
      unlockListeners = ['pointerdown', 'touchend', 'keydown'];
      for (const evt of unlockListeners) window.addEventListener(evt, onUserGesture, { once: false, passive: true });
    },

    setPaused(paused: boolean): void {
      if (!ctx) return;
      if (paused) { if (ctx.state === 'running') void ctx.suspend(); }
      else if (ctx.state === 'suspended') void ctx.resume().then(flushPending);
    },

    dispose(): void {
      disposed = true;
      detachUnlock();
      pendingUnlockOps.length = 0;
      for (const v of voices) v.destroy();
      voices.clear();
      buffers.clear();
      if (ctx) void ctx.close().catch(() => { /* 已关闭 */ });
      ctx = null;
    },
  };
}
