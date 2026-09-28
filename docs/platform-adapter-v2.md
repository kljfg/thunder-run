# PlatformAdapter v2 接口规格（S10 · 评审稿）

> 状态：待协调者评审，通过后作为 S3（platform 实现）/ S4（ui 输入消费）的实现契约下发。
> 基线：`dev@3eca260`；v1 = `src/platform/platformAdapter.ts`（S2 合入后位于 `packages/platform/src/platformAdapter.ts`，内容一致）。
> 配套类型草案：`drafts/platform-adapter-v2.ts`（可独立编译，验证命令见草案头部；**未挂仓库 tsconfig**）。
> 上游依据：`docs/wx-minigame-redesign.md` §3.1/§3.2/§6、`docs/session-plan.md` S3/S6/S8/S9 提示词。

## 1. 设计原则

1. **结构化最小类型**：接口面不出现 `HTMLElement` / `HTMLCanvasElement` / `window` / `document` / `wx` 等宿主类型；画布、上下文全部用结构化接口或不透明句柄表达（redesign §3.1）。
2. **GL 上下文不透明化**：`getContext` 返回 `ContextHandle = object`。全仓唯一需要真实 WebGL 类型的地方是 render 层喂 three 的**单点断言处**（§7 第 6 条），其余代码不感知上下文真身。
3. **主画布单例**：wx 屏幕画布全局唯一且不可重建，v1「每局 run 新建 canvas」的生命周期在 wx 上走不通 → v2 契约改为 `mainCanvas()` 幂等单例 + `createOffscreenCanvas()` 显式离屏工厂（细化 §3.1 的「首次=屏幕、后续=离屏」隐式语义，避免调用顺序成为隐藏契约）。
4. **输入统一**：`onGesture` + `onKey` 合并为 `onInput(InputEvent)`；手势判定逻辑抽成两端共享的纯函数分类器（S3 任务 2 的提取目标，本规格给出契约）。
5. **旧签名零迁移**：`storage / fetchJson / requestFrame / cancelFrame / onVisibility / now` 六项与 v1 **逐字一致**（§3.1 明文要求），调用方无感。
6. **wx 专属能力可选注入**：`extras?: WxExtras` 不进主接口必备面；web 壳提供 no-op/fetch 兜底实现，业务代码可无分支调用。

## 2. v1 → v2 去向总表（100% 覆盖）

| v1 成员 | 去向 | 说明 |
|---|---|---|
| `env: 'web' \| 'wx'` | **保留** | 原样 |
| `createCanvasHost(container: HTMLElement): CanvasHost` | **拆分+改名** | → `canvas.mainCanvas()` / `canvas.createOffscreenCanvas(w,h)` / `canvas.windowSize()`。`container` 参数**删除**：wx 无 DOM 容器；web 挂载点改为 platform-web 构造参数注入（DOM 知识收敛进实现包） |
| `CanvasHost.canvas: HTMLCanvasElement` | **改名+去 DOM** | → `GLCanvas`（结构化：width/height/getContext/style） |
| `CanvasHost.width/height/dpr` | **改名** | → `WindowSize { width; height; dpr }`，语义不变（CSS 逻辑像素；渲染尺寸 = 尺寸 × dpr），但不再绑定画布创建时刻，可随时查询 |
| `Gesture` 类型（swipe/tap/doubleTap） | **保留为子集** | `type Gesture = Extract<InputEvent, {type:'swipe'\|'tap'\|'doubleTap'}>`；swipe **新增**起点坐标 `x/y`（必填，向后兼容——旧消费方忽略多余字段即可，见 D4） |
| `onGesture(cb)` | **合并** | → `onInput(cb: (e: InputEvent) => void)`；且**废止** v1「未建画布订阅即 throw」的前置条件（D5） |
| `onKey(cb: (code: string) => void)` | **合并** | → `onInput` 的 `{type:'key'; code; phase}` 分支；`code` 保持 `KeyboardEvent.code` 语义；`phase` 新增（v1 隐式仅 down，迁移时过滤 `phase==='down'`）；wx 端不发 key 事件（§6 表） |
| `storage.get/set/remove` | **保留** | 签名逐字不变；新增语义约定「`null` = 无记录」，wx 实现负责归一化 `getStorageSync` 的 `''` 歧义（D11） |
| `fetchJson(url)` | **保留** | 签名逐字不变；两端统一「非 2xx reject」 |
| `requestFrame(cb)` | **保留** | 签名逐字不变；新增契约「cb 时间戳与 `now()` 同基准」（D12） |
| `cancelFrame(handle)` | **保留** | 签名逐字不变 |
| `onVisibility(cb: (hidden) => void)` | **保留** | 签名与参数语义（hidden=true 进后台）逐字不变 |
| `now()` | **保留** | 签名逐字不变 |
| — | **新增** | `version: 2`（运行时探测）、`canvas.onResize`（v1 缺失）、`extras?: WxExtras`、`GestureClassifier` 共享内核 |

## 3. 接口签名（完整；与 drafts/platform-adapter-v2.ts 一致）

```ts
export type Unsubscribe = () => void;
export type FrameHandle = number;

// ---------- §1 画布 ----------
export interface WindowSize { width: number; height: number; dpr: number }
export type ContextHandle = object;                       // 不透明原生上下文
export interface GLContextAttributes {                    // WebGLContextAttributes 结构化子集
  alpha?: boolean; antialias?: boolean; depth?: boolean; stencil?: boolean;
  premultipliedAlpha?: boolean; preserveDrawingBuffer?: boolean;
  powerPreference?: 'default' | 'low-power' | 'high-performance';
  failIfMajorPerformanceCaveat?: boolean;
}
export interface GLCanvas {
  width: number;                                          // 绘图缓冲区物理像素
  height: number;
  getContext(contextId: 'webgl2', attrs?: GLContextAttributes): ContextHandle | null;
  getContext(contextId: 'webgl', attrs?: GLContextAttributes): ContextHandle | null;
  getContext(contextId: '2d', attrs?: unknown): ContextHandle | null;   // 仅离屏有意义
  readonly style?: Record<string, string | undefined>;    // three 写 style 的兜底（wx 垫片给可写空对象）
}
export interface CanvasFactory {
  mainCanvas(): GLCanvas;                                 // 幂等单例（屏幕画布）
  createOffscreenCanvas(width: number, height: number): GLCanvas;       // 每次新实例
  windowSize(): WindowSize;
  onResize(cb: (size: WindowSize) => void): Unsubscribe;  // v2 新增
}

// ---------- §2 输入 ----------
export type SwipeDir = 'up' | 'down' | 'left' | 'right';
export type InputEvent =
  | { type: 'swipe'; dir: SwipeDir; x: number; y: number }   // x/y = 按下起点（v2 新增字段）
  | { type: 'tap'; x: number; y: number }
  | { type: 'doubleTap'; x: number; y: number }
  | { type: 'key'; code: string; phase: 'down' | 'up' };
export type Gesture = Extract<InputEvent, { type: 'swipe' | 'tap' | 'doubleTap' }>;

export interface TouchSample { phase: 'down' | 'up'; x: number; y: number; timeMs: number }
export interface GestureClassifierOptions {
  swipeMinPx?: number; tapMaxMs?: number;
  doubleTapWindowMs?: number; doubleTapMaxDistPx?: number;
}
export interface GestureClassifier {
  push(sample: TouchSample): InputEvent | null;           // 纯状态机，可 node 单测
  reset(): void;                                          // touchcancel / 页面隐藏时清状态
}
export declare function createGestureClassifier(opts?: GestureClassifierOptions): GestureClassifier;
export declare const GESTURE_DEFAULTS: Required<GestureClassifierOptions>;
// v1 现行默认：swipeMinPx=24, tapMaxMs=350, doubleTapWindowMs=280, doubleTapMaxDistPx=40

// ---------- §3 存储（签名同 v1） ----------
export interface SyncStorage {
  get(key: string): string | null;                        // null = 无记录
  set(key: string, value: string): void;
  remove(key: string): void;
}

// ---------- §4 WxExtras ----------
export interface WxIdentity { openid: string; isGuest: boolean }
export interface ShareOptions { title: string; query?: string; imageUrl?: string }
export interface CloudBridge {
  callFunction(name: string, data?: unknown): Promise<unknown>;
  saveProgress(key: string, data: unknown): Promise<void>;
  loadProgress(key: string): Promise<unknown | null>;
  submitScore(score: number, meta?: Record<string, unknown>): Promise<void>;
}
export interface WxExtras {
  login(): Promise<WxIdentity>;                           // S9
  share(opts: ShareOptions): void;                        // S9
  readonly cloud: CloudBridge;                            // S9（此前占位）
  readJson(path: string): Promise<unknown>;               // S6 实装，S8 接 CDN manifest
  readBinary(path: string): Promise<ArrayBuffer>;         // S6 实装（贴图/图集/模型）
  showRewardAd?(unitId: string): Promise<'rewarded' | 'closed' | 'failed'>;   // IAA 预留（S9.4）
  requestSubscribeMessage?(templateIds: readonly string[]): Promise<void>;    // 订阅消息预留（S9.4）
}

// ---------- §5 主接口 ----------
export interface PlatformAdapter {
  readonly version: 2;
  readonly env: 'web' | 'wx';
  readonly canvas: CanvasFactory;
  onInput(cb: (e: InputEvent) => void): Unsubscribe;      // 画布创建前即可订阅
  readonly storage: SyncStorage;
  fetchJson(url: string): Promise<unknown>;               // 非 2xx 一律 reject
  requestFrame(cb: (timeMs: number) => void): FrameHandle; // timeMs 与 now() 同基准
  cancelFrame(handle: FrameHandle): void;
  onVisibility(cb: (hidden: boolean) => void): Unsubscribe;
  now(): number;
  readonly extras?: WxExtras;
}
```

坐标约定：所有输入坐标为 **CSS 逻辑像素、相对主画布左上角**（两端画布即全屏，等价于视口左上角）。dpr 换算由消费方经 `windowSize().dpr` 自取。

## 4. web / wx 实现映射表

| v2 成员 | web（packages/platform-web） | wx（packages/platform-wx） |
|---|---|---|
| `canvas.mainCanvas()` | 首次 `document.createElement('canvas')` 挂入构造注入的挂载点（`#screen`），设置 100%/block 样式（同 v1）；此后返回同一实例 | 首个 `wx.createCanvas()` = 屏幕画布，包装为 `GLCanvas`；幂等 |
| `canvas.createOffscreenCanvas(w,h)` | `createElement('canvas')`，设 width/height，不挂载 | 后续 `wx.createCanvas()`（官方语义即离屏），设 width/height |
| `canvas.windowSize()` | 挂载点 `getBoundingClientRect()`（同 v1）+ `dpr = min(devicePixelRatio, 2)`（沿用 v1 上限策略） | `wx.getWindowInfo()` → `windowWidth/windowHeight/pixelRatio` |
| `canvas.onResize` | `window.resize` + `orientationchange`（去抖后回调） | `wx.onWindowResize` |
| `GLCanvas.style` | 真实 `CSSStyleDeclaration`（结构兼容） | 可写空对象垫片（three `setSize` updateStyle 分支兜底；S11 spike 验证覆盖面） |
| `onInput`（手势） | `pointerdown/pointerup` → 折算 `TouchSample` → `GestureClassifier`（v1 bindGesture 判定逻辑原样提取） | `wx.onTouchStart/End` → `changedTouches[0].clientX/Y` + `timeStamp` → 同一分类器；`onTouchCancel` → `reset()` |
| `onInput`（键盘） | `window.keydown/keyup` → `{type:'key'}`；**保留 v1 的 INPUT 聚焦过滤**（S5 前登录页表单可打字）；S5 后 UI 无 DOM 输入框，过滤逻辑随 screens.ts 退役 | **不发**（无物理键盘）。UI 虚拟按键由 ui 包自行合成业务事件，不经 adapter（§6 表「键盘调试输入」条目） |
| `storage.get` | `localStorage.getItem` + try/catch → null（同 v1） | `wx.getStorageSync`；**`''` → null 归一化**（包 `{v}` JSON 或存在性查询，实现二选一，须有单测锁定语义，D11） |
| `storage.set/remove` | `localStorage` + try/catch 静默（同 v1） | `wx.setStorageSync/removeStorageSync` + try/catch 静默（10MB 上限注意） |
| `fetchJson` | `fetch(url, {cache:'no-store'})`，非 2xx reject（同 v1） | `wx.request({dataType:'json'})`；statusCode 非 2xx 或 fail → reject。**域名白名单**：正式环境需后台配置，开发者工具阶段「不校验合法域名」 |
| `requestFrame/cancelFrame` | `requestAnimationFrame/cancelAnimationFrame`（同 v1，时间戳天然 performance 基准） | 游戏上下文全局 `requestAnimationFrame/cancelAnimationFrame`；时间戳基准与 `now()` 对齐（不一致时实现内换算，D12） |
| `onVisibility` | `document.visibilitychange` → `cb(document.hidden)`（同 v1） | `wx.onShow → cb(false)`；`wx.onHide → cb(true)` |
| `now()` | `performance.now()`（同 v1） | `wx.getPerformance().now()`（基础库不支持时退化 `Date.now()`，汇报注明） |
| `extras` | 提供 no-op/兜底实现：`login`→游客（本地生成测试 openid，`isGuest:true`）；`share`→console 记录；`cloud`→`saveProgress/loadProgress` 落 localStorage、`callFunction/submitScore` reject `'unsupported'`；`readJson`→转发 `fetchJson`；`readBinary`→`fetch().arrayBuffer()` | 全量实装（各成员的 wx API 见下四行） |
| `extras.login` | （同上，游客） | `wx.login → code →` 云函数 code2session → openid（S9；接口形状见 CloudBridge.callFunction） |
| `extras.share` | （同上，no-op） | `wx.shareAppMessage`（S9，含结算页「炫耀一下」带分口令） |
| `extras.cloud` | （同上，兜底） | `wx.cloud.callFunction` + 云开发 DB（S9） |
| `extras.readJson/readBinary` | （同上，fetch 兜底） | 包内路径 → `wx.getFileSystemManager().readFile`（S6，分包资源）；`http(s)` URL → `wx.downloadFile` → 缓存 → fs 读（S8 CDN 复用同一入口） |
| `extras.showRewardAd / requestSubscribeMessage` | 不提供（可选成员缺省） | S9.4：仅 TODO 占位，不实装 |

## 5. WxExtras 注入与消费约定

- 挂载点：`adapter.extras`（可选属性）。**wx 实现必须全量提供**；web 壳提供 §4 表所列兜底实现（也建议挂 `extras`，业务侧统一 `adapter.extras!` 或构造期断言一次）。
- 消费方与时间线：S6 → `readJson/readBinary`（configLoader 的 FileSource 切到该接口，web 继续 fetch，两端 config 同源）；S8 → `readJson` 上叠 manifest/CDN 降级链 + `cloud` 存储上传；S9 → `login/share/cloud` 实装、IAA/订阅消息按预留接口落地。
- **开放数据域好友排行不进 WxExtras**：独立沙箱（另一次 canvas + 受限 API 面），走 `openDataContext` 子包 + `postMessage`，S9 单独设计（redesign §7 风险 5）。
- 登录态迁移（S9）：`login()` 的 `openid` 成为 bestScore/角色选择的主键；本地 `thunderrun:best`、`thunderrun:character` 键保留为离线兜底，`cloud.saveProgress/loadProgress` 为账号级真源。

## 6. 手势归一化共享内核（S3 提取契约）

- v1 `webPlatform.bindGesture`（swipe 位移判定 + tap/doubleTap 窗口判定）是纯逻辑，S3 提取为 `packages/platform` 的 `createGestureClassifier`，**阈值默认值原样保留**（`GESTURE_DEFAULTS`），行为不回退由既有手感保证。
- 两端各自只做「平台触点 → `TouchSample`」折算：web 用 `PointerEvent.clientX/Y` + `performance.now()`；wx 用 `changedTouches[0]` + `timeStamp`（基准对齐 `now()`）。
- 分类器可 node:test 直测（S3 补用例：swipe 四方向、tap、doubleTap 窗口边界、三连击消耗、cancel 清态）。
- `onInput` 多播：adapter 实现内部维护订阅者列表，`cb` 按订阅顺序同步派发；`Unsubscribe` 幂等。

## 7. 迁移注记（v1 调用点逐一给去向）

> 行号以 dev 基线 `src/` 为准；S2 合入后对应 `packages/`、`apps/web/src/` 路径（内容一致）。
> 全部改动由 S3 落地（platform-web 同步实现 + 调用方跟改，保持编译通过）。

| # | 调用点 | 现状（v1） | 改法（v2） |
|---|---|---|---|
| 1 | `src/game/bootstrap.ts:19` | `createWebPlatform()` 无参 | `createWebPlatform({ mount })`：挂载点（`#screen`）由 apps/web 入口查询 DOM 后注入，bootstrap 不再出现 `document`（配合 check-import-rules 对 game 包的禁令） |
| 2 | `src/game/bootstrap.ts:51` | run 场景 `onEnter` 每次 `adapter.createCanvasHost(document.getElementById('screen')!)` | `const gl = adapter.canvas.mainCanvas(); const size = adapter.canvas.windowSize();`——`document` 消失；**跨局复用同一画布**：run 退出只 dispose RunnerScene/renderer，不销毁 canvas（wx 屏幕画布不可重建，见 D1/D3；renderer 是重建还是复用见 §9 开放问题） |
| 3 | `src/game/bootstrap.ts:77-79` | `adapter.onKey(code => …Escape…)` | `adapter.onInput(e => { if (e.type === 'key' && e.phase === 'down' && e.code === 'Escape') … })` |
| 4 | `src/game/bootstrap.ts:88-90` | **绕过 adapter** 直挂 `document.addEventListener('keydown')`（Enter=游客登录，靠 `.btn-primary` DOM 查询 hack） | 改走 `onInput` key 事件（Enter）；S5 自绘 UI 后该 hack 整体消亡（登录按钮是 ui 控件，Enter 由页面级 keymap 触发控件回调） |
| 5 | `src/game/bootstrap.ts:97-99` | configLoader FileSource 接线：`fetchJson/cacheGet/cacheSet` | **不变**（configLoader 本就是结构化类型）。S6 起在 fetchJson 前叠 `extras.readJson` 优先源，S8 再叠 manifest 降级链——FileSource 组装点唯一，改动收敛在 bootstrap |
| 6 | `src/render/runnerScene.ts:43` | 形参 `host: { canvas: HTMLCanvasElement; width; height; dpr }` | `host: { canvas: GLCanvas; size: WindowSize }`（类型 import 自 `@tr/platform`）；**全仓唯一 three 接线断言**在第 55 行：`new THREE.WebGLRenderer({ canvas: host.canvas as unknown as HTMLCanvasElement, antialias: true })`，加注释「平台垫片单点断言，S11 spike 结论如与此冲突在此收敛」 |
| 7 | `src/render/runnerScene.ts:56-57,61` | `setPixelRatio(host.dpr)`、`setSize(host.width, host.height, false)`、相机 aspect | 字段来源换成 `host.size.*`，逻辑不变（CSS 像素 × dpr 语义与 v1 相同）。**新增**：订阅 `canvas.onResize` → `setSize` + `camera.aspect` 更新 + `updateProjectionMatrix`（v1 无此能力，窗口变化即拉伸；wx 转屏/键盘弹起必需），退订进 `dispose()` |
| 8 | `src/render/runnerScene.ts:81-96` | `adapter.onGesture` + `adapter.onKey` 两个订阅 | 合并为单个 `adapter.onInput`：`swipe`→四方向动作、`doubleTap`→skill、`key(phase==='down')`→ArrowLeft/Right/Up/Down/Space/KeyE/ShiftLeft/ShiftRight 映射原样保留；退订函数合一 |
| 9 | `onVisibility` | v1 **零调用点**（接口存在但没人订阅） | 保留接口。建议 S3 顺手在 runnerScene 接入：`hidden=true` → 暂停 tick 累计（避免后台 dt 爆炸）；不接也不算回退 |
| 10 | `src/ui/screens.ts`（S2 后 `apps/web/src/ui/screens.ts`） | v1 不直接消费 adapter（纯 DOM，HUD `document.body.appendChild`） | S10 无需改动。S4/S5：ui overlay 订阅 `onInput` 按控件矩形分发（tap 命中、swipe 列表滚动——swipe 新增的起点坐标即为命中分发用）；HUD/页面 DOM 路径整体退役 |
| 11 | `src/platform/webPlatform.ts` 全体 | v1 实现 | S3 重写为 v2：bindGesture 判定逻辑提取为 GestureClassifier（§6）；`onGesture` 的「先建画布否则 throw」前置**废止**（onInput 绑定 window 级事件，随时可订阅）；其余方法按 §4 映射表平移 |
| 12 | `tools/check-import-rules.mjs` | 禁 window/document/localStorage/fetch 等全局 | 规则不变即可覆盖；S3 补充：`packages/platform-wx` 是唯一允许触碰 `wx` 全局的包（apps/wx 入口垫片除外）——v2 接口面本身无 wx 类型，core/render/ui/game 编译产物不会引用 |

## 8. 关键设计决策清单（评审点）

- **D1 主画布单例 + 显式离屏工厂**：`mainCanvas()` 幂等、`createOffscreenCanvas()` 每次新实例。细化 redesign §3.1 单方法 `createWebGLCanvas()` 的「首次=屏幕」隐式语义——调用顺序不该是隐藏契约，且 web 必须同构（v1 每局新建 canvas 的生命周期废止）。
- **D2 container 参数删除**：挂载点属 web 实现细节，经 platform-web 构造参数注入；接口面从此零 DOM 类型。
- **D3 GL 上下文不透明句柄**（`ContextHandle = object`）：不在接口面引用 `WebGL2RenderingContext`（那是 lib.dom 类型，wx 侧本就无此类型实体）；three 接线是全仓唯一断言点（§7 第 6 条）。
- **D4 onInput 统一事件模型**：手势三变体与 v1 逐字段兼容；swipe 新增起点坐标 `x/y`（UI 命中分发需要，滚动列表要知道手势从哪个控件起）；key 新增 `phase`（v1 隐式 down-only，up 供 ui 按压态/长按预留）。
- **D5 onInput 与画布生命周期解耦**：v1「先 createCanvasHost 才能 onGesture，否则 throw」的坑废止；输入源（window / wx 全局 touch）本就独立于画布。
- **D6 六个旧成员签名逐字保留**：storage/fetchJson/requestFrame/cancelFrame/onVisibility/now（§3.1 明文 + 调用方零迁移成本）；onVisibility 参数保持 `hidden` 语义不翻转为 `visible`。
- **D7 WxExtras 可选注入**（`extras?: WxExtras`）：不污染两端必备面；web 壳给 no-op/fetch 兜底实现而非缺省，业务代码免平台分支。开放数据域排行**不进** extras（独立沙箱，S9 另行设计）。
- **D8 GestureClassifier 纯函数内核进 packages/platform**：两端共享判定逻辑与 v1 阈值默认值，node 可直测（S3 任务 2 的契约形状）。
- **D9 新增 canvas.onResize**：v1 缺失（窗口变化即画面拉伸）；wx 转屏/系统键盘、web 窗口拖动都需要，S3 render 顺手接线（§7 第 7 条）。
- **D10 新增 `version: 2` 字面量字段**：S2/S3 过渡期新旧垫片错配时运行时可探测、报错可定位。
- **D11 storage 空串歧义**：wx `getStorageSync` 无记录返回 `''`，与「存过空串」不可区分。约定接口语义 `null` = 无记录，wx 实现负责归一化（包 `{"v":…}` 或存在性查询二选一），S3 单测锁定。
- **D12 时间基准契约**：`requestFrame` 回调时间戳与 `now()` 同基准；web 天然满足（同为 performance 基准），wx 若不满足由 platform-wx 内部换算——runnerScene 的固定步长循环依赖 `adapter.now()` 与帧时间戳混算，基准漂移会直接表现为 dt 尖峰。
- **D13 `GLCanvas.style` 为可选可写垫片**：three 在 `setSize(updateStyle)` 等路径写 `canvas.style.*`；wx 侧给空对象吞掉写入即可，不引入 DOM 语义。S11 spike 负责验证 three r160 实际触碰面是否超出 `width/height/getContext/style`。

## 9. 开放问题（评审时裁决 / 下游带回）

1. **WebGLRenderer 生命周期**（S3 裁决）：主画布复用后，每局 run 是「重建 renderer（同一 canvas 二次 `getContext('webgl2')` 返回同上下文，需 `forceContextLoss` 与否实测）」还是「顶层持有单 renderer、场景级 swap」。接口对两者中立。
2. **离屏 `'2d'` 上下文**是否被 S4/S12 运行时需要（字体图集为构建期产物，理论上不需要）；不需要则 S3 可在 wx 侧直接返回 null。
3. `env` 是否扩 `'node'`（node:test 直测 adapter 逻辑时）：暂不扩，测试用 `version`/结构探测即可；有需求再评审。
4. wx 侧 `requestFrame` 时间戳与 `getPerformance().now()` 的基准一致性需 S11/S3 真机实测确认（D12 的验证项）。

## 10. 验证记录

- 类型草案独立编译（无 DOM lib，证明自包含）：
  `node tools/vendor/typescript/lib/tsc.js --noEmit --strict --target es2020 --lib es2020 --module esnext drafts/platform-adapter-v2.ts` → **通过**
- 与 DOM lib 共存编译（未来 render 包同环境）：同上命令 `--lib es2020,dom` → **通过**
- 草案未挂仓库 tsconfig；本任务未修改任何既有文件（纯新增 `docs/platform-adapter-v2.md`、`drafts/platform-adapter-v2.ts`）。
