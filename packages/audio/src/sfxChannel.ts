/**
 * SFX 通道（S17）：声部池 + 同类节流 + 并发上限 + 优先级抢占。
 * playSfx 判定顺序（全部同步，无补加载——音效必须 preload 过，缺失只 warn 不隐式拉取）：
 *   1. 节流窗口内同名重复 → 丢弃（金币连吸/连续铲跳防爆音堆叠）；
 *   2. 暂停中 → 丢弃（后台不该有触发音）；
 *   3. 同声部池有空闲（上一发已 onEnded）→ 复用；
 *   4. 池未满（maxVoices）且全局未满（sfxMaxLive）→ 新建声部；
 *   5. 池已满（或新建被全局上限挡住但池里有在播的）→ 同池最旧声部**重触发**（同类音效
 *      以新盖旧，跑酷品类惯例：听感的连续性比逐发完整更重要）；
 *   6. 只剩「池空但被全局上限挡住」→ 跨声部抢占：找全局最低优先级·最旧的在播声部，
 *      新音优先级**严格更高**才顶掉它，否则丢弃（同级竞争不破坏既有声景）。
 * 全局上限默认 8 的依据：iOS InnerAudioContext 同时实例官方上限 10（见 platform/audio.ts 头注释）。
 */
import type { AudioAsset, AudioBackend, AudioVoice } from '@tr/platform/audio.js';
import type { SfxPlayOverrides, SoundDef } from './types.js';

export interface SfxChannelDeps {
  readonly backend: AudioBackend;
  gain(): number;
  now(): number;
  resolve(id: string): { def: SoundDef; asset: AudioAsset } | null;
}

interface Slot {
  def: SoundDef;
  voice: AudioVoice;
  playing: boolean;
  startedAt: number;
  /** play 时的单次增益覆盖（def.volume × slotVol × 通道增益 = 最终音量）。 */
  slotVol: number;
}

export interface SfxChannel {
  play(id: string, overrides?: SfxPlayOverrides): boolean;
  setPaused(p: boolean): void;
  refresh(): void;
  stopAll(): void;
  liveCount(): number;
  voiceCount(): number;
  dispose(): void;
}

export function createSfxChannel(deps: SfxChannelDeps, maxLive: number): SfxChannel {
  const pools = new Map<string, Slot[]>();
  const lastPlayed = new Map<string, number>();
  let paused = false;

  const compose = (s: Slot): number => (s.def.volume ?? 1) * s.slotVol * deps.gain();
  const allSlots = (): Slot[] => { const out: Slot[] = []; pools.forEach(a => out.push(...a)); return out; };

  const makeSlot = (def: SoundDef, asset: AudioAsset): Slot => {
    const slot: Slot = { def, voice: deps.backend.createVoice(asset), playing: false, startedAt: 0, slotVol: 1 };
    // 后端契约：仅自然播完回调（stop 不回调）→ 回收为空闲，供池复用
    slot.voice.onEnded(() => { slot.playing = false; });
    return slot;
  };

  const trigger = (s: Slot, overrides: SfxPlayOverrides | undefined, now: number): void => {
    s.slotVol = overrides?.volume ?? 1;
    s.playing = true;
    s.startedAt = now;
    s.voice.play({
      loop: false,
      volume: compose(s),
      playbackRate: overrides?.playbackRate ?? 1,
    });
    lastPlayed.set(s.def.id, now);
  };

  /** 同池最旧在播声部（策略 5 的重触发对象）。 */
  const oldestPlaying = (list: Slot[]): Slot | null => {
    let best: Slot | null = null;
    for (const s of list) if (s.playing && (!best || s.startedAt < best.startedAt)) best = s;
    return best;
  };

  /** 全局最低优先级 + 最旧的在播声部（策略 6 的抢占对象）。 */
  const prio = (s: Slot): number => s.def.priority ?? 1;
  const preemptVictim = (): Slot | null => {
    let best: Slot | null = null;
    for (const s of allSlots()) {
      if (!s.playing) continue;
      if (!best || prio(s) < prio(best) || (prio(s) === prio(best) && s.startedAt < best.startedAt)) best = s;
    }
    return best;
  };

  return {
    play(id, overrides) {
      const found = deps.resolve(id);
      if (!found) { console.warn(`[audio] playSfx 未注册或未加载的声音: ${id}`); return false; }
      if (found.def.kind !== 'sfx') { console.warn(`[audio] playSfx 指向了非 sfx 声音: ${id}`); return false; }
      if (paused) return false;
      if (deps.gain() === 0) return false; // 静音/通道关：瞬态音效直接丢弃，不占原生声部（BGM 相反——保留 0 音量声部供取消静音复响）
      const { def, asset } = found;
      const now = deps.now();
      const throttleMs = def.throttleMs ?? 60;
      const prev = lastPlayed.get(id);
      if (prev !== undefined && now - prev < throttleMs) return false; // 策略 1

      const list = pools.get(id) ?? [];
      if (!pools.has(id)) pools.set(id, list);
      const maxVoices = def.maxVoices ?? 3;
      const priority = def.priority ?? 1;

      const idle = list.find(s => !s.playing); // 策略 3
      if (idle) { trigger(idle, overrides, now); return true; }

      const live = allSlots().filter(s => s.playing).length;
      if (list.length < maxVoices && live < maxLive) { // 策略 4
        const slot = makeSlot(def, asset);
        list.push(slot);
        trigger(slot, overrides, now);
        return true;
      }

      const oldest = oldestPlaying(list); // 策略 5
      if (oldest) { trigger(oldest, overrides, now); return true; }

      const victim = preemptVictim(); // 策略 6（oldest 为空 ⇒ 本池无在播，victim 必属他池）
      if (victim && priority > (victim.def.priority ?? 1)) {
        victim.playing = false;
        victim.voice.stop();
        victim.voice.destroy();
        const owner = pools.get(victim.def.id);
        if (owner) { const i = owner.indexOf(victim); if (i >= 0) owner.splice(i, 1); }
        const slot = makeSlot(def, asset);
        list.push(slot);
        trigger(slot, overrides, now);
        return true;
      }
      return false; // 抢占失败：丢弃新音
    },

    setPaused(p) { paused = p; },

    refresh() { for (const s of allSlots()) if (s.playing) s.voice.setVolume(compose(s)); },

    stopAll() {
      for (const s of allSlots()) {
        if (!s.playing) continue;
        s.playing = false; // 先置位：后端的误回调不会把它又标成在播
        s.voice.stop();
      }
    },

    liveCount: () => allSlots().filter(s => s.playing).length,
    voiceCount: () => allSlots().length,

    dispose() {
      for (const s of allSlots()) { s.playing = false; s.voice.stop(); s.voice.destroy(); }
      pools.clear();
      lastPlayed.clear();
    },
  };
}
