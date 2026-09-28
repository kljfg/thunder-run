/**
 * 音量/静音状态机（S17）：唯一持有 AudioSettings 的地方，负责校验、钳制与存档。
 * 存档键约定 thunderrun:audio:*（与 thunderrun:best / thunderrun:character 同前缀风格）：
 *   thunderrun:audio:master  → "0.8"
 *   thunderrun:audio:muted   → "1" | "0"
 *   thunderrun:audio:bgm     → JSON [enabled, volume]
 *   thunderrun:audio:sfx     → JSON [enabled, volume]
 * 读取容错：任意键缺失/损坏 → 该项回默认值（不整档重置、不 throw）；写入即时穿透（set 即存档）。
 * 混音数学：gainFor(channel) = muted ? 0 : master × (enabled ? volume : 0)，由引擎下推给后端。
 */
import type { SyncStorage } from '@tr/platform/platformAdapter.js';
import type { AudioChannel, AudioSettings } from './types.js';

export const AUDIO_KEY_PREFIX = 'thunderrun:audio:';
export const MASTER_KEY = AUDIO_KEY_PREFIX + 'master';
export const MUTED_KEY = AUDIO_KEY_PREFIX + 'muted';
export const CHANNEL_KEYS: Record<AudioChannel, string> = {
  bgm: AUDIO_KEY_PREFIX + 'bgm',
  sfx: AUDIO_KEY_PREFIX + 'sfx',
};

export const DEFAULT_SETTINGS: AudioSettings = {
  master: 1, muted: false,
  bgm: { enabled: true, volume: 1 },
  sfx: { enabled: true, volume: 1 },
};

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : NaN as number);

function readNumber(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const n = clamp01(Number(raw));
  return Number.isNaN(n) ? fallback : n;
}

function readChannel(raw: string | null, fallback: { enabled: boolean; volume: number }): { enabled: boolean; volume: number } {
  if (raw === null) return { ...fallback };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length < 2) return { ...fallback };
    const vol = clamp01(Number(parsed[1]));
    return { enabled: Boolean(parsed[0]), volume: Number.isNaN(vol) ? fallback.volume : vol };
  } catch {
    return { ...fallback };
  }
}

export interface VolumeState {
  /** 快照拷贝（UI 回显/测试断言用，改副本不影响状态机）。 */
  get(): AudioSettings;
  /** 通道最终增益（合成后下推 voice.setVolume / play.volume）。 */
  gainFor(channel: AudioChannel): number;
  setMaster(v: number): void;
  setMuted(m: boolean): void;
  setChannelEnabled(ch: AudioChannel, on: boolean): void;
  setChannelVolume(ch: AudioChannel, v: number): void;
  /** 写档失败不 throw（无痕/quota），仅回传 false 供上层提示。 */
  persist(): boolean;
}

export function createVolumeState(storage: SyncStorage): VolumeState {
  const state: AudioSettings = {
    master: readNumber(storage.get(MASTER_KEY), DEFAULT_SETTINGS.master),
    muted: storage.get(MUTED_KEY) === '1',
    bgm: readChannel(storage.get(CHANNEL_KEYS.bgm), DEFAULT_SETTINGS.bgm),
    sfx: readChannel(storage.get(CHANNEL_KEYS.sfx), DEFAULT_SETTINGS.sfx),
  };

  const write = (k: string, v: string): boolean => {
    try { storage.set(k, v); return true; } catch { return false; }
  };
  const persistChannel = (ch: AudioChannel) => write(CHANNEL_KEYS[ch], JSON.stringify([state[ch].enabled, state[ch].volume]));

  return {
    get: () => ({
      master: state.master, muted: state.muted,
      bgm: { ...state.bgm }, sfx: { ...state.sfx },
    }),
    gainFor: ch => (state.muted ? 0 : state.master * (state[ch].enabled ? state[ch].volume : 0)),

    setMaster(v) {
      const n = clamp01(Number(v));
      state.master = Number.isNaN(n) ? state.master : n;
      write(MASTER_KEY, String(state.master));
    },
    setMuted(m) {
      state.muted = Boolean(m);
      write(MUTED_KEY, state.muted ? '1' : '0');
    },
    setChannelEnabled(ch, on) {
      state[ch].enabled = Boolean(on);
      persistChannel(ch);
    },
    setChannelVolume(ch, v) {
      const n = clamp01(Number(v));
      if (!Number.isNaN(n)) state[ch].volume = n;
      persistChannel(ch);
    },
    persist() {
      return write(MASTER_KEY, String(state.master)) && write(MUTED_KEY, state.muted ? '1' : '0')
        && persistChannel('bgm') && persistChannel('sfx');
    },
  };
}
