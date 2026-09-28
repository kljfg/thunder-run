/**
 * BGM 通道（S17）：单声部 + 场景切换交叉淡化（crossfade）。
 * 切换语义：play(新) = 旧声部淡出到 0 后释放 ∥ 新声部从 0 淡入（两段同时走，时长均 fadeMs）；
 * 同 id 正在播 → no-op（幂等，供场景机 onEnter 重复进入安全调用）。
 * 淡变基于声部原始电平 raw；通道增益变化只触发 refresh 重乘，不打断淡变。
 * 异步竞态：play 内可能需要补 load（boot 预加载未完成就切场景），用代数计数 gen 保证
 * 迟到的 load 结果不会把更晚的切换覆盖。
 */
import type { AudioAsset, AudioBackend, AudioVoice } from '@tr/platform/audio.js';
import type { FadeHandle, FadeRunner } from './fade.js';
import type { SoundDef } from './types.js';

export interface BgmChannelDeps {
  readonly backend: AudioBackend;
  readonly fades: FadeRunner;
  gain(): number;
  /** 已注册且已加载 → 返回 def+asset；否则 null。 */
  resolve(id: string): { def: SoundDef; asset: AudioAsset } | null;
  /** 已注册（未必加载）→ def；未注册 → null。 */
  resolveDef(id: string): SoundDef | null;
  loadSound(def: SoundDef): Promise<AudioAsset>;
  now(): number;
}

interface BgmVoice {
  def: SoundDef;
  voice: AudioVoice;
  raw: number; // 0..1 原始电平（淡变作用量）
  fade: FadeHandle | null;
}

export interface BgmChannel {
  play(id: string): Promise<void>;
  stop(fadeOutMs?: number): void;
  setFadeMs(ms: number): void;
  refresh(): void;
  currentId(): string | null;
  dispose(): void;
}

export function createBgmChannel(deps: BgmChannelDeps, initialFadeMs: number): BgmChannel {
  let fadeMs = Math.max(0, initialFadeMs);
  let current: BgmVoice | null = null;
  let gen = 0;

  const apply = (b: BgmVoice): void => { b.voice.setVolume(b.raw * deps.gain()); };

  const fadeOut = (b: BgmVoice, ms: number): void => {
    if (current === b) current = null;
    b.fade?.cancel(null); // 关键：先撤在途淡入，否则 destroy 后旧 fade 仍会回写音量
    b.fade = deps.fades.start({
      from: b.raw, to: 0, durationMs: ms,
      apply(v) { b.raw = v; apply(b); },
      onDone() { b.fade = null; b.voice.stop(); b.voice.destroy(); },
    }, deps.now());
  };

  return {
    currentId: () => current?.def.id ?? null,

    async play(id) {
      if (current && current.def.id === id) return; // 幂等：同曲已在播不重启
      const myGen = ++gen;
      if (current) fadeOut(current, fadeMs);

      let resolved = deps.resolve(id);
      if (resolved && resolved.def.kind !== 'bgm') {
        console.warn(`[audio] playBgm 指向了非 bgm 声音: ${id}`);
        return;
      }
      if (!resolved) {
        const def = deps.resolveDef(id);
        if (!def || def.kind !== 'bgm') { console.warn(`[audio] playBgm 未注册或非 bgm 声音: ${id}`); return; }
        try {
          await deps.loadSound(def);
        } catch (e) {
          console.warn(`[audio] BGM 加载失败: ${id}`, (e as Error).message);
          return;
        }
        if (myGen !== gen) return; // 在途 load 期间发生了更新的切换/停止
        resolved = deps.resolve(id);
        if (!resolved) return;
      }

      const voice = deps.backend.createVoice(resolved.asset);
      const b: BgmVoice = { def: resolved.def, voice, raw: 0, fade: null };
      voice.play({ loop: true, volume: 0 }); // 0 起播防咔哒，淡入接管
      current = b;
      b.fade = deps.fades.start({
        from: 0, to: 1, durationMs: fadeMs,
        apply(v) { b.raw = v; apply(b); },
        onDone() { b.fade = null; },
      }, deps.now());
    },

    stop(fadeOutMs) {
      gen++; // 作废在途的 play
      if (!current) return;
      fadeOut(current, fadeOutMs ?? fadeMs);
    },

    setFadeMs(ms) { fadeMs = Math.max(0, ms); },

    refresh() {
      if (current) apply(current);
      // 淡出声部由 fade 回调在下一次 update 时自然用上新 gain，无需干预
    },

    dispose() {
      gen++;
      if (current) {
        const b = current;
        current = null;
        b.fade?.cancel(null);
        b.voice.stop();
        b.voice.destroy();
      }
    },
  };
}
