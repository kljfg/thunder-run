/**
 * @tr/audio 公共类型（S17）。
 * 引擎是纯逻辑：宿主能力全部经 AudioBackend（@tr/platform/audio.js）与 SyncStorage 注入，
 * 本包不出现任何 DOM/wx 引用（check-import-rules 精神；与 core 同级洁癖）。
 */
import type { SyncStorage } from '@tr/platform/platformAdapter.js';
import type { AudioBackend, AudioChannel } from '@tr/platform/audio.js';

export type { AudioBackend, AudioChannel } from '@tr/platform/audio.js';

/** 一个可播放声音的静态定义（内容侧资源与运行时参数的桥）。 */
export interface SoundDef {
  readonly id: string;
  /** 资源地址：web = 可 fetch 的 URL；wx = 分包内文件路径。约定见 assets/audio/README.md。 */
  readonly src: string;
  readonly kind: AudioChannel;
  /** SFX 抢占权重（默认 1）：全局并发满时，只有**更高**优先级的新音才能顶掉最低优先级旧音。 */
  readonly priority?: number;
  /** SFX 同声音部池上限（默认 3）：池满但全局未满 → 新建；两者都满 → 走抢占判定。 */
  readonly maxVoices?: number;
  /** SFX 同声节流窗口 ms（默认 60）：窗口内重复触发直接丢弃（金币连吸/连续受击防爆音与堆叠）。 */
  readonly throttleMs?: number;
  /** 人声基准增益 0..1（默认 1）：与 master/通道增益相乘。 */
  readonly volume?: number;
}

/** playSfx 的单次覆盖参数。 */
export interface SfxPlayOverrides {
  readonly volume?: number;
  readonly playbackRate?: number;
}

/** 通道混音档位（存档持久化的最小集，键约定见 volumeState.ts）。 */
export interface ChannelSetting {
  enabled: boolean;
  /** 0..1 */
  volume: number;
}

/** 音频状态机快照（settings() 返回的拷贝形态）。 */
export interface AudioSettings {
  /** 主音量 0..1 */
  master: number;
  /** 全局静音开关（UI 喇叭按钮直控） */
  muted: boolean;
  bgm: ChannelSetting;
  sfx: ChannelSetting;
}

/** createAudioEngine 参数。 */
export interface AudioEngineOptions {
  readonly backend: AudioBackend;
  readonly storage: SyncStorage;
  /** 声音注册表（同 id 后注册覆盖先注册，支持热替换内容）。 */
  readonly sounds?: readonly SoundDef[];
  /** SFX 全局同时发声上限（默认 8；iOS InnerAudioContext 总实例官方上限 10，留 BGM 与余量）。 */
  readonly sfxMaxLive?: number;
  /** BGM 场景切换交叉淡化时长 ms（默认 800）。 */
  readonly bgmFadeMs?: number;
  /** 时钟注入（默认 Date.now）；单测用假时钟推演淡变与节流。 */
  readonly clock?: () => number;
}
