/**
 * AudioEngine —— 音频框架门面（S17 核心，docs/wx-minigame-redesign.md §3.1 / framework-roadmap §3）。
 * 职责装配：声音注册表与预加载、音量状态机（thunderrun:audio:* 存档）、BGM/SFX 双通道、
 * 淡变调度（update() 手动泵，宿主接 adapter.requestFrame；单测假时钟）、后台暂停转发。
 * 宿主无关：backend/storage/clock 全注入（check-import-rules 对 wx. 的全局禁令天然满足）。
 *
 * 典型接线（整合会话在 apps 侧落地，样例见 docs/audio-events.md）：
 *   const engine = createAudioEngine({ backend: createWebAudioBackend(), storage: adapter.storage });
 *   engine.unlock();                       // iOS 手势解锁（内部挂一次性监听）
 *   adapter.requestFrame(t => engine.update(t));
 *   await engine.preload();                // boot 场景
 *   engine.playBgm('bgm_menu');            // 场景切换即交叉淡化
 *   engine.playSfx('coin');                // sim 事件挂点
 */
import type { AudioAsset } from '@tr/platform/audio.js';
import { createFadeRunner } from './fade.js';
import { createBgmChannel } from './bgmChannel.js';
import { createSfxChannel } from './sfxChannel.js';
import { createVolumeState } from './volumeState.js';
import type { AudioEngineOptions, AudioSettings, SfxPlayOverrides, SoundDef } from './types.js';

export interface AudioEngine {
  /** 注册/覆盖声音定义（同 id 覆盖需先 unload 旧资源？——保守：仅允许未加载 id 的新增或同 src 覆盖）。 */
  register(def: SoundDef): void;
  /** 预加载：缺省全部已注册；失败逐个 catch 汇总 reject（boot 侧显示降级）。 */
  preload(ids?: readonly string[]): Promise<void>;
  isLoaded(id: string): boolean;

  playSfx(id: string, overrides?: SfxPlayOverrides): boolean;
  playBgm(id: string): Promise<void>;
  stopBgm(fadeOutMs?: number): void;

  settings(): AudioSettings;
  setMaster(v: number): void;
  setMuted(m: boolean): void;
  setBgmEnabled(on: boolean): void;
  setSfxEnabled(on: boolean): void;
  setBgmVolume(v: number): void;
  setSfxVolume(v: number): void;
  /** bgm 音量开关的合并别名（enabled+volume 一次设）。 */
  setChannelEnabled(ch: 'bgm' | 'sfx', on: boolean): void;
  setChannelVolume(ch: 'bgm' | 'sfx', v: number): void;

  /** 推进淡变；宿主每帧调用（假时钟下等价手动步进）。nowMs 缺省用内部 clock。 */
  update(nowMs?: number): void;
  setPaused(p: boolean): void;
  unlock(): void;
  setBgmFadeMs(ms: number): void;
  dispose(): void;
}

export function createAudioEngine(options: AudioEngineOptions): AudioEngine {
  const { backend, clock = () => Date.now() } = options;
  const sounds = new Map<string, SoundDef>();
  const assets = new Map<string, AudioAsset>(); // id → 已加载资源
  const loads = new Map<string, Promise<AudioAsset>>(); // id → 在途加载（去重）
  const fades = createFadeRunner();
  const volume = createVolumeState(options.storage);

  for (const def of options.sounds ?? []) sounds.set(def.id, def);

  const resolve = (id: string): { def: SoundDef; asset: AudioAsset } | null => {
    const def = sounds.get(id);
    const asset = def ? assets.get(id) : undefined;
    return def && asset ? { def, asset } : null;
  };

  const loadSound = (def: SoundDef): Promise<AudioAsset> => {
    const cached = assets.get(def.id) ?? loads.get(def.id);
    if (cached) return Promise.resolve(cached);
    const p = backend.load(def.src).then(a => {
      assets.set(def.id, a);
      loads.delete(def.id);
      return a;
    }, e => { loads.delete(def.id); throw e; });
    loads.set(def.id, p);
    return p;
  };

  const bgm = createBgmChannel({
    backend, fades, now: () => clock(),
    gain: () => volume.gainFor('bgm'),
    resolve, resolveDef: id => sounds.get(id) ?? null, loadSound,
  }, options.bgmFadeMs ?? 800);

  const sfx = createSfxChannel(
    { backend, now: () => clock(), gain: () => volume.gainFor('sfx'), resolve },
    options.sfxMaxLive ?? 8,
  );

  /** 音量类状态变更统一出口：重乘所有在播声部。 */
  const refreshMix = (): void => { bgm.refresh(); sfx.refresh(); };

  let disposed = false;

  return {
    register(def) {
      if (assets.has(def.id) && sounds.get(def.id)?.src !== def.src) {
        throw new Error(`[audio] 声音 ${def.id} 已加载，覆盖 src 需先 unload（防声部引用旧资源）`);
      }
      sounds.set(def.id, def);
    },

    async preload(ids) {
      const targets = (ids ? ids.map(id => sounds.get(id)) : [...sounds.values()])
        .filter((d): d is SoundDef => Boolean(d));
      const missing = (ids ?? [...sounds.keys()]).filter(id => !sounds.has(id));
      if (missing.length) throw new Error(`[audio] preload 未注册的声音: ${missing.join(', ')}`);
      await Promise.all(targets.map(d => loadSound(d)));
    },

    isLoaded: id => assets.has(id),
    playSfx: (id, overrides) => !disposed && sfx.play(id, overrides),
    playBgm: id => (disposed ? Promise.resolve() : bgm.play(id)),
    stopBgm: fadeOutMs => bgm.stop(fadeOutMs),

    settings: () => volume.get(),
    setMaster(v) { volume.setMaster(v); refreshMix(); },
    setMuted(m) { volume.setMuted(m); refreshMix(); },
    setBgmEnabled(on) { volume.setChannelEnabled('bgm', on); refreshMix(); },
    setSfxEnabled(on) { volume.setChannelEnabled('sfx', on); refreshMix(); },
    setBgmVolume(v) { volume.setChannelVolume('bgm', v); refreshMix(); },
    setSfxVolume(v) { volume.setChannelVolume('sfx', v); refreshMix(); },
    setChannelEnabled: (ch, on) => { volume.setChannelEnabled(ch, on); refreshMix(); },
    setChannelVolume: (ch, v) => { volume.setChannelVolume(ch, v); refreshMix(); },

    update(nowMs) { fades.update(nowMs ?? clock()); },
    setPaused(p) { sfx.setPaused(p); backend.setPaused?.(p); },
    unlock: () => backend.unlock(),
    setBgmFadeMs: ms => bgm.setFadeMs(ms),

    dispose() {
      disposed = true;
      bgm.dispose();
      sfx.dispose();
      assets.forEach(a => backend.unload?.(a));
      assets.clear();
      loads.clear();
      backend.dispose();
    },
  };
}
