/**
 * @tr/audio —— 音频框架（S17）。主入口 createAudioEngine + 公共类型；
 * 细粒度模块（volumeState/fade/通道）按 '@tr/audio/<路径>.js' 直导（测试即如此消费）。
 */
export { createAudioEngine } from './engine.js';
export type { AudioEngine } from './engine.js';
export type {
  AudioEngineOptions, AudioSettings, ChannelSetting, SfxPlayOverrides, SoundDef,
} from './types.js';
export { ACTION_SOUNDS, DEFAULT_SOUNDS, EVENT_SOUNDS } from './defaults.js';
export { AUDIO_KEY_PREFIX, CHANNEL_KEYS, DEFAULT_SETTINGS, MASTER_KEY, MUTED_KEY, createVolumeState } from './volumeState.js';
export type { VolumeState } from './volumeState.js';
export { createFadeRunner } from './fade.js';
export type { FadeHandle, FadeRunner, FadeSpec } from './fade.js';
export { createBgmChannel } from './bgmChannel.js';
export type { BgmChannel, BgmChannelDeps } from './bgmChannel.js';
export { createSfxChannel } from './sfxChannel.js';
export type { SfxChannel, SfxChannelDeps } from './sfxChannel.js';
