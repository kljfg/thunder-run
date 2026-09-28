/**
 * AudioBackend —— 音频后端契约（S17，docs/wx-minigame-redesign.md §3.1 泛化思路的音频延伸）。
 * 定位与 WxExtras 相同：**零宿主类型**的纯接口，由 platform-web / platform-wx 各自实现，
 * @tr/audio 的 AudioEngine 只消费本契约完成加载/池化/混音/节流（混音数学全在引擎侧，
 * 后端只暴露「一条声音」的最小原语，两端可实现性优先于接口漂亮）。
 *
 * 双端映射总表：
 * | 契约成员        | web（webAudio.ts）                        | wx（platform-wx/audio.ts）              |
 * |----------------|-------------------------------------------|------------------------------------------|
 * | load(src)      | fetch → AudioContext.decodeAudioData 预热   | 校验 src，返回惰性资源句柄（真加载在 play） |
 * | createVoice    | GainNode + 每次 play 新建 BufferSource      | 一个 InnerAudioContext（播完复用）          |
 * | setPaused      | AudioContext.suspend/resume（精确恢复）      | 逐 voice pause/resume（不丢播放位置）        |
 * | unlock         | 一次性手势监听 + ctx.resume()（iOS 策略）     | no-op（小游戏无此限制）                     |
 *
 * 并发预算约束（引擎默认值依据）：iOS 同时存活的 InnerAudioContext 实例官方上限 10，
 * 故 sfxMaxLive 默认 8 + BGM 1 + 1 余量；web 侧无硬上限但仍走同一预算保证两端手感一致。
 *
 * 音量语义：voice.setVolume 只接受 **引擎合成的最终增益**（master × 通道 × 人声三级
 * 相乘在 @tr/audio 完成后下推），后端不做任何音量策略。
 */

/** 通道：背景音乐 / 音效（混音状态机按通道分档，存档键 thunderrun:audio:* 对应）。 */
export type AudioChannel = 'bgm' | 'sfx';

/** 已加载资源的后端句柄（web 内含解码后的 AudioBuffer；wx 仅包 src 字符串）。 */
export interface AudioAsset {
  readonly src: string;
}

/** play 的一次性参数；replay 时以最后一次 play 的参数为准。 */
export interface AudioPlayOptions {
  /** 循环播放（BGM 用；wx 映射 InnerAudioContext.loop）。默认 false。 */
  readonly loop?: boolean;
  /** 起始人声增益 0..1（默认 1，后续用 setVolume 步进淡入淡出）。 */
  readonly volume?: number;
  /** 变速 0.5..2（web: source.playbackRate；wx: InnerAudioContext.playbackRate）。默认 1。 */
  readonly playbackRate?: number;
}

/**
 * 一条可复用的「声部」。生命周期由引擎池管理：play→(onEnded|stop)→可再 play。
 * 实现注意：stop()/destroy() 触发的**人工结束不得**回调 onEnded（只播完自然结束才回调），
 * 引擎靠 onEnded 回收空闲声部，误触会抢占错乱。
 */
export interface AudioVoice {
  play(opts?: AudioPlayOptions): void;
  /** 立即停止并复位到开头（可再 play）。不触发 onEnded。 */
  stop(): void;
  /** 实时增益（淡入淡出的步进落点；引擎保证 0..1）。 */
  setVolume(v: number): void;
  isPlaying(): boolean;
  /** 自然播完回调（loop=true 永不触发；注册一次即可）。 */
  onEnded(cb: () => void): void;
  /** 释放后端原生资源（wx: InnerAudioContext.destroy 必调；web: disconnect 节点）。 */
  destroy(): void;
}

export interface AudioBackend {
  readonly kind: 'web' | 'wx';
  /** 加载（web 解码预热；失败 reject——调用方决定降级，不静默）。同 src 重复调用允许，引擎自带按 id 去重。 */
  load(src: string): Promise<AudioAsset>;
  /** 可选：释放资源缓存（引擎 dispose/preload 失败回滚时调用；缺省实现可省）。 */
  unload?(asset: AudioAsset): void;
  /** 新建一条声部；asset 必须来自本 backend.load。 */
  createVoice(asset: AudioAsset): AudioVoice;
  /**
   * 自动播放策略解锁（iOS Safari / 桌面 Chrome 需用户手势后 ctx 才 running）。
   * 幂等、可反复调；实现应挂一次性 pointerdown/keydown 监听，触发后自摘除。
   */
  unlock(): void;
  /**
   * 整体暂停/恢复（可选能力，引擎在 adapter.onVisibility 时调用）：
   * web = AudioContext.suspend/resume；wx = 各存活 voice pause/resume。
   * 缺省视为 no-op（表现：进后台声音按平台默认行为处理）。
   */
  setPaused?(paused: boolean): void;
  /** 释放后端全部资源（所有存活 voice + 解码缓存 + 上下文）。之后不可再用。 */
  dispose(): void;
}
