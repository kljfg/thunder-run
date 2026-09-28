# 音频事件挂点设计（S17）

> 目的：把 AudioEngine 接进现有事件流的**位置与写法**定下来；实际接线延后到整合会话
> （S5 页面迁移 × S6 wx 管线合流后，一次性改 `runnerScene`/`mainFlow`/apps 入口）。
> 本文引用的行号基于 `origin/dev@6ceb82a`，接线时以当时代码为准重定位（按语义锚点找）。
> 引擎契约与用法另见 `packages/platform/src/audio.ts`（后端）与 `packages/audio/src/engine.ts`（门面）。

## 0. 接线前置：引擎构建与驱动（apps 入口，两端各一处）

```ts
// apps/web bootstrap（示意，与 createWebPlatform 并列）
import { createWebAudioBackend } from '@tr/platform-web/webAudio.js';
import { createAudioEngine, DEFAULT_SOUNDS } from '@tr/audio/index.js';

const audio = createAudioEngine({ backend: createWebAudioBackend(), storage: adapter.storage, sounds: DEFAULT_SOUNDS });
audio.unlock();                                   // 挂一次性手势监听（iOS 解锁；见 §7）
const pump = (t: number) => { audio.update(t); adapter.requestFrame(pump); }; // 淡变泵：必须逐帧驱动
adapter.requestFrame(pump);
await audio.preload();                            // boot 场景里等首包音效（失败显示降级不阻塞）
```

**铁律**：`audio.update()` 不逐帧调，所有淡变（含 BGM 起播音量）不会推进——BGM 将停在 0 音量。
整合会话务必把 pump 与主循环合并（wx 侧经 adapter.requestFrame 同构接入）。

## 1. 局内事件（`packages/render/src/runnerScene.ts` → `consumeEvents()`，L122-133）

sim 事件源：`SimEvent`（`packages/core/src/sim/simTypes.ts:23-28`）。现每个分支已有表现反馈（爆点/震屏），
音频接线 = 在对应分支追加一行 `cb.onSound?.(id)`（建议给 RunCallbacks 加可选回调，render 不 import 音频包，保持单向数据流）。

| SimEvent | 行号 | 建议 soundId（defaults.ts） | 备注 |
|---|---|---|---|
| `coin` | 124 | `sfx_coin` | 高频事件：节流窗口（45ms）在引擎内，挂点侧**无条件调用**即可 |
| `hit` | 126 | `sfx_hit` | 与震屏同帧 |
| `helmetSave` | 125 | `sfx_hit`（占位）| 内容侧可拆独立音：改 `EVENT_SOUNDS` |
| `death` | 127 | `sfx_result` | 死亡 sting；结算进入音在 §3.4（同 id 有 500ms 节流不会双响） |
| `cast` | 129 | `sfx_skill` | |
| `shieldBreak` / `boardBreak` | 130 | `sfx_hit`（占位）| `layers` 参数可做音高变化（`playSfx(id,{playbackRate})`） |
| `pickup` | 131（现无表现） | 预留 `vo`/buff 音，S9 内容 | itemRef → 音效映射由内容侧在 `EVENT_SOUNDS` 扩展 |
| `protected` / `nearMiss` | — | 暂不挂音 | 框架只保证“想挂就有一行”的成本 |

样例（接线后的 consumeEvents 形态）：

```ts
const evSound: Partial<Record<SimEvent['type'], string>> = EVENT_SOUNDS; // @tr/audio/defaults
for (const ev of sim.drainEvents()) {
  const sid = evSound[ev.type];
  if (sid) cb.onSfx?.(sid);        // 新增可选回调，apps 侧转 engine.playSfx
  /* …原有爆点/震屏分支不动… */
}
```

## 2. 局内操作（同文件 `onInput`，L85-101）

输入动作直接触发（sim 采纳与否都响——操作反馈音的惯例；采纳判定音可后续用 `sim.state` 差值精化）：

| 输入 | 建议 id |
|---|---|
| `swipe:up` / 键 ArrowUp、Space（jump） | `sfx_jump` |
| `swipe:down` / ArrowDown（slide） | `sfx_slide` |
| `doubleTap` / KeyE/Shift（skill） | `sfx_skill` |
| 换道（left/right） | 暂不挂（内容侧定） |

## 3. 场景切换（`packages/game/src/mainFlow.ts` 场景机，L51-92）

BGM 全部经 `engine.playBgm(id)`：同 id 幂等、异 id 自动交叉淡化（默认 800ms），
挂在各场景 `onEnter/onExit` 即可，**无需**宿主手工淡出。

| 时机 | 行号 | 动作 |
|---|---|---|
| 启动完成进登录 `boot()` 末尾 | L119 | `playBgm('bgm_menu')`（登录/菜单共用；解锁前 iOS 静默属预期，首次点击后 pump+resume 自然出声） |
| menu → run（onEnter run） | L64-78 | `playBgm('bgm_run')`（与菜单曲交叉淡化） |
| run 死亡 → result（`onEnd` 回调侧） | L75 | `playBgm('bgm_menu')` 或 result 专曲；`stopBgm()` 用于 Esc 退出 |
| result → run（Retry）/ result → menu | L87-88 | 随 onEnter 自动切（同 §3 各条） |
| 局中途 Esc 退出（全局输入） | L95-98 | run onExit 里 `stopBgm()` 后 menu onEnter `playBgm('bgm_menu')` |
| 设置页开关（S5 UI 迁移时） | — | `setMuted/setMaster/setChannelEnabled('bgm'|'sfx')`（状态机自动写 `thunderrun:audio:*` 存档） |

HUD 层可选进阶（不属必需挂点）：技能能量满（`onHud` 里对 `skill.ready` 做上升沿检测 → 提示音）；
`pushHud`（runnerScene L169）处给 cb 增加 `skillReady` 布尔边沿即可，S5 时再定。

## 4. 后台可见性（runnerScene L117-120 已有订阅；mainFlow 无）

```ts
adapter.onVisibility(hidden => audio.setPaused(hidden));
```
web = AudioContext.suspend/resume（进度精确保留）；wx = 逐声部 pause/resume（InnerAudioContext
原生支持续播）。与渲染暂停相互独立：渲染暂停归 runnerScene，音频暂停归 apps 装配层单点。

## 5. UI 交互音（S5 范围）

登录/菜单/结算页按钮（`packages/ui` Button onRelease）→ `sfx_ui_click`（内容侧补素材后在
`DEFAULT_SOUNDS` 追加）。框架侧规则：UI 控件层不 import 音频，由 apps 在 mountViews 时注入
`onSound` 回调，保持与 §1 相同的单向流。

## 6. wx 侧 TODO 接线点（本会话有意不改的文件与位置）

| 接线点 | 位置 | 动作 |
|---|---|---|
| Backend 构造 | `packages/platform-wx/src/audio.ts` 头注释 TODO-1/2 | `createWxAudioBackend(getWx() as WxAudioGlobal)` |
| wxTypes 扩面 | `packages/platform-wx/src/wxTypes.ts`（S6 会话属主） | `WxLike.createInnerAudioContext()` 并回，删本地 `WxAudioGlobal` |
| 资源分发 | `tools/build-wx.mjs` + `apps/wx/game.json`（S6 属主） | `assets/audio/**.mp3` → 分包 `audio/`（README §3） |
| 注册导出 | `packages/platform-wx/src/index.ts` | barrel 补 `export { createWxAudioBackend } ...`（等 S6 文件冻结） |

## 7. iOS 解锁链路（web）

`createWebAudioBackend().unlock()` 挂 `pointerdown/touchend/keydown` 一次性监听 → `ctx.resume()`，
并把 resume 前排队的 `play` 闭包补发（引擎的静音丢弃策略不受影响：队列只含 playBgm 与解锁前已判定
可播的 sfx）。接线时机：入口 bootstrap 调一次即可；登录页「游客进入」按钮的 pointerdown 天然满足首次手势。

## 8. web 侧演示（不依赖 apps/web 改动）

1. `npm run check` → `node --test tests/audio-engine.test.mjs`（假时钟全链路行为验证）；
2. 真听感演示：任意静态服务器根置 `assets/audio/`（如 `python tools/serve.py` 同思路），
   控制台执行 §0 六行（`adapter` 用页面已挂载的 `createWebPlatform` 实例或 `?debug` 探针环境）；
   `audio.playBgm('bgm_menu')` 应出声、`audio.playSfx('sfx_coin')` 连点应节流不炸音。
   S5 整合会话把 §0 落进 bootstrap 后即为永久演示路径。

## 9. 给内容侧的音频需求单（占位 → 正式素材）

| id | 文件 | 时长 | 描述建议 | 数量 |
|---|---|---|---|---|
| `sfx_coin` | `sfx_coin.mp3` | ≤0.15s | 上跳双音 blip，高频区，音量小 | 1 |
| `sfx_jump` | `sfx_jump.mp3` | ≤0.2s | 短促上扬 whoosh（鞋底摩擦感） | 1 |
| `sfx_slide` | `sfx_slide.mp3` | ≤0.25s | 下滑擦地 noise sweep | 1 |
| `sfx_hit` | `sfx_hit.mp3` | ≤0.3s | 低频闷击 + 碎屑尾（受击=护盾碎可分两层素材） | 2（hit / shieldBreak） |
| `sfx_skill` | `sfx_skill.mp3` | ≤0.5s | 能量释放 sweep+冲击 | 1 |
| `sfx_result` | `sfx_result.mp3` | ≤1.0s | 结算 sting（上行情 + 余韵） | 1 |
| `sfx_ui_click` | `sfx_ui_click.mp3` | ≤0.06s | UI 通用点击（S5 需要时补） | 1 |
| `bgm_menu` | `bgm_menu.mp3` | 30-60s 可循环 | 主菜单：中速电子/放克，循环点无缝 | 1 |
| `bgm_run` | `bgm_run.mp3` | 60-90s 可循环 | 跑酷：130-150 BPM 强节奏，低中频留白给音效 | 1 |

规格红线：见 `assets/audio/README.md` §1-§3（MP3/44.1k/mono(SFX)/-16 LUFS/-1 dBFS/SFX≤50KB/BGM≤500KB/全部进分包）。
themes.json 的 `.ogg` 引用不一致项已在 README §4 登记，由整合会话统一。
