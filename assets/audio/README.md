# 音频资源规范（assets/audio，S17 框架定版）

> 目录现状：`sfx_coin.mp3 / sfx_hit.mp3 / bgm_menu.mp3` 为**程序合成占位音**（`node gen-placeholders.mjs`
> 重新生成，lamejs 为临时编码依赖：`npm install --no-save @breezystack/lamejs`），仅供管线联调，
> **内容侧须按本规范替换正式音色**。替换即覆盖同名文件，不改代码。

## 1. 格式与编码

| 项 | 规范 | 原因 |
|---|---|---|
| 容器/编码 | **MP3**（CBR 即可）| 两端原生解码（web decodeAudioData / wx InnerAudioContext）唯一交集；AAC 版权路径与 OGG wx 端支持差异规避 |
| 采样率 | 44100 Hz | 两端一致重采样基准；禁止 48k 混用（wx iOS 有重采样失真报告）|
| 声道 | **单声道**（SFX 必须；BGM 允许立体声）| 单声道 96kbps 听感达标且省一半体积；BGM 立体声 128kbps |
| 码率 | SFX 96-128 kbps；BGM 128 kbps | 预算内最高质量档 |
| 响度 | 峰值归一 **-1 dBFS**；整体响度目标 **-16 LUFS ±1**（短音效 -14 ±2）| 防削波 + 同类音效响度一致；用 loudnorm/ffmpeg `loudnorm=I=-16:TP=-1` 批处理 |
| 首尾处理 | SFX 起始 ≤5ms 静默、结尾自然衰减；BGM **首尾淡变 150ms 保证可循环**（引擎 loop 无缝接缝依赖素材本身）| 防爆音咔哒 |

## 2. 命名（引擎注册表 src 以此为准，见 `packages/audio/src/defaults.ts`）

```
sfx_<事件>.mp3     例：sfx_coin.mp3 sfx_hit.mp3 sfx_jump.mp3 sfx_slide.mp3 sfx_skill.mp3 sfx_result.mp3
bgm_<场景>.mp3     例：bgm_menu.mp3 bgm_run.mp3 bgm_result.mp3
vo_<角色>_<语句>.mp3  （预留，S9 内容；不进当前预算）
```
- `<事件>` 与 `docs/audio-events.md` 挂点表的事件名一一对应（coin/hit/cast…→ 文件用动作语义名 jump/slide/skill）。
- 小写、下划线、ASCII；不允许空格与中文文件名（wx 分包路径兼容）。

## 3. 体积预算（进包即计入，超标 = S6 构建体积门禁失败）

| 类别 | 单文件 | 备注 |
|---|---|---|
| SFX | **≤ 50 KB**（时长 ≤1.5s）| 超预算通常是采样率/声道不合规 |
| BGM | **≤ 500 KB**（128kbps ≈ 31s；建议 30-60s 循环段）| 循环听感优先于时长 |
| 总量 | **全部进独立分包 `audio/`**，主包不放音频 | 微信主包 4MB 门禁；wx 加载分包后路径 `audio/sfx_coin.mp3` |

分包接线（S6）：`apps/wx` 构建脚本把 `assets/audio/**.mp3` 拷入分包目录并登记 `game.json` subPackages；
引擎 `SoundDef.src` 由宿主按 env 拼前缀（web 相对站点根 / wx 分包路径），注册表本身存**裸文件名**。

## 4. 已知不一致（接线会话处理，勿在此改）

- `config/themes.json` 的 `music` 现引用 `assets/audio/bgm/*.ogg`（内容侧旧格式）。
  整合会话（S5/S6 合流）二选一：内容侧转 mp3 改引用，或 framework 侧在 `DEFAULT_SOUNDS` 增设 theme→bgm id 映射。
- `config/characters.json` 的 `audio.voDir/footstep` 为 S9 预留字段，当前引擎不消费。
