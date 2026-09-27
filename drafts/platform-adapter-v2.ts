/**
 * PlatformAdapter v2 类型草案（S10 产出 · 评审稿，配套文档 docs/platform-adapter-v2.md）
 *
 * 定位：接口契约，不含实现。S3 以此为基线落 packages/platform（正式化时可拆分文件），
 * packages/platform-web 与 packages/platform-wx 分别实现。
 *
 * 自包含验证（不依赖 DOM lib，不挂仓库 tsconfig）：
 *   node tools/vendor/typescript/lib/tsc.js --noEmit --strict \
 *     --target es2020 --lib es2020 --module esnext drafts/platform-adapter-v2.ts
 *
 * 基线：dev@3eca260，v1 = src/platform/platformAdapter.ts（S2 搬迁后为 packages/platform/src/platformAdapter.ts）。
 */

// ============================================================
// §0 通用
// ============================================================

/** 所有 on* 订阅方法的返回值：调用即退订（与 v1 一致）。 */
export type Unsubscribe = () => void;

/** requestFrame 返回的帧句柄（web/wx 两端均为 number）。 */
export type FrameHandle = number;

// ============================================================
// §1 画布抽象（CanvasFactory）—— 去 DOM 类型
// ============================================================

/**
 * 窗口/画布逻辑尺寸。width/height 为 CSS 逻辑像素（与 v1 CanvasHost 同语义：
 * 渲染尺寸 = 尺寸 × dpr）；dpr 的上限策略属于实现（web 沿用 v1 的 min(devicePixelRatio, 2)）。
 */
export interface WindowSize {
  width: number;
  height: number;
  dpr: number;
}

/**
 * 不透明的原生渲染上下文句柄。运行时即平台原生 WebGL/WebGL2/2D 上下文对象；
 * 类型层刻意不展开——全仓唯一需要真实类型的地方是 render 层喂给 three 的
 * 单点断言处（见规格文档 §7 迁移注记第 6 条）。
 */
export type ContextHandle = object;

/** WebGL 上下文创建参数（结构化最小子集，字段语义同 WebGLContextAttributes）。 */
export interface GLContextAttributes {
  alpha?: boolean;
  antialias?: boolean;
  depth?: boolean;
  stencil?: boolean;
  premultipliedAlpha?: boolean;
  preserveDrawingBuffer?: boolean;
  powerPreference?: 'default' | 'low-power' | 'high-performance';
  failIfMajorPerformanceCaveat?: boolean;
}

/**
 * 平台无关画布（v1 CanvasHost.canvas: HTMLCanvasElement 的替代）。
 * width/height 为绘图缓冲区物理像素（three setSize 会写它，与 web canvas.width 语义一致）。
 */
export interface GLCanvas {
  width: number;
  height: number;
  getContext(contextId: 'webgl2', attrs?: GLContextAttributes): ContextHandle | null;
  getContext(contextId: 'webgl', attrs?: GLContextAttributes): ContextHandle | null;
  /** 仅对离屏画布有意义；wx 屏幕画布不支持 2d 时实现返回 null。 */
  getContext(contextId: '2d', attrs?: unknown): ContextHandle | null;
  /**
   * three.js 部分代码路径会写 canvas.style（setSize updateStyle 分支等）。
   * web 实现即真实 CSSStyleDeclaration（结构化兼容）；wx 垫片给可写空对象，不得缺省。
   */
  readonly style?: Record<string, string | undefined>;
}

/**
 * 画布工厂（v1 createCanvasHost(container) 的替代，容器参数删除）。
 * 关键契约：主画布是单例——wx 的屏幕画布全局唯一且不可重建，web 实现保持同构，
 * 跨场景（run 进出）复用同一 GLCanvas，v1「每局新建 canvas」的生命周期废止。
 */
export interface CanvasFactory {
  /** 屏幕主画布：首次调用创建并挂载（web 挂到实现内部持有的挂载点；wx 包装首个 wx.createCanvas()），重复调用返回同一实例。 */
  mainCanvas(): GLCanvas;
  /** 离屏画布：每次返回独立新实例（web: createElement 不挂载；wx: 后续 wx.createCanvas()），尺寸为物理像素。 */
  createOffscreenCanvas(width: number, height: number): GLCanvas;
  /** 当前窗口逻辑尺寸（v1 CanvasHost.width/height/dpr 的替代，画布创建前后均可调用）。 */
  windowSize(): WindowSize;
  /** v2 新增：窗口尺寸/横竖屏变化订阅（web: resize+orientationchange；wx: wx.onWindowResize）。 */
  onResize(cb: (size: WindowSize) => void): Unsubscribe;
}

// ============================================================
// §2 输入（onInput）—— 手势 + 键盘统一事件模型
// ============================================================

export type SwipeDir = 'up' | 'down' | 'left' | 'right';

/**
 * 统一输入事件（v1 onGesture 的 Gesture 与 onKey 的 code 合并）。
 * 坐标一律为 CSS 逻辑像素、相对主画布左上角（两端即视口左上角）。
 */
export type InputEvent =
  /** v1 swipe 原样保留；x/y 为按下起点（新增必填字段，向后兼容——旧消费方忽略即可）。 */
  | { type: 'swipe'; dir: SwipeDir; x: number; y: number }
  /** v1 tap 原样保留。 */
  | { type: 'tap'; x: number; y: number }
  /** v1 doubleTap 原样保留。 */
  | { type: 'doubleTap'; x: number; y: number }
  /** v1 onKey(code) 的替代：code 保持 KeyboardEvent.code 语义（ArrowLeft/Space/Escape…）；
   *  phase 为 v2 新增（v1 隐式只在 down 时回调）。wx 端无物理键盘，只发手势事件；
   *  UI 层「虚拟按键」由 ui 包自行合成业务事件，不经 adapter。 */
  | { type: 'key'; code: string; phase: 'down' | 'up' };

/** v1 的 Gesture 类型去向：InputEvent 的手势子集（导出名保留，减少调用方 churn）。 */
export type Gesture = Extract<InputEvent, { type: 'swipe' | 'tap' | 'doubleTap' }>;

// ---------- 手势归一化共享内核（纯函数，S3 提取到 packages/platform，两端复用） ----------

/** 平台触点采样：web 由 PointerEvent 折算，wx 由 wx.onTouch* 折算；坐标 CSS 逻辑像素。 */
export interface TouchSample {
  phase: 'down' | 'up';
  x: number;
  y: number;
  /** 与 adapter.now() 同基准的时间戳。 */
  timeMs: number;
}

/** 判定阈值；默认值取 v1 webPlatform.ts 的现行常量（见 GESTURE_DEFAULTS）。 */
export interface GestureClassifierOptions {
  swipeMinPx?: number;
  tapMaxMs?: number;
  doubleTapWindowMs?: number;
  doubleTapMaxDistPx?: number;
}

export interface GestureClassifier {
  /** 喂入触点采样；产生手势事件则返回，否则 null。纯状态机，无平台依赖，可 node 单测。 */
  push(sample: TouchSample): InputEvent | null;
  /** 触点序列被打断（touchcancel / 页面隐藏）时清状态。 */
  reset(): void;
}

/** 草案只声明契约；实现体在 S3 从 v1 webPlatform.bindGesture 的判定逻辑提取。 */
export declare function createGestureClassifier(opts?: GestureClassifierOptions): GestureClassifier;

/** v1 现行默认：swipeMinPx=24, tapMaxMs=350, doubleTapWindowMs=280, doubleTapMaxDistPx=40。 */
export declare const GESTURE_DEFAULTS: Required<GestureClassifierOptions>;

// ============================================================
// §3 存储 / 网络 / 帧循环 / 可见性 / 时钟（六项签名与 v1 逐字一致）
// ============================================================

/** 同步 KV 存储。语义约定：get 返回 null = 无记录（wx 实现需归一化 getStorageSync 的 '' 歧义）。 */
export interface SyncStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

// ============================================================
// §4 WxExtras —— wx 侧专属能力，可选注入（S6/S8/S9 消费）
// ============================================================

/** 登录结果。web 壳 no-op 实现返回游客身份（openid 为本地生成的测试串，isGuest=true）。 */
export interface WxIdentity {
  openid: string;
  isGuest: boolean;
}

/** 定向分享参数（S9），映射 wx.shareAppMessage。 */
export interface ShareOptions {
  title: string;
  /** 回流场景识别用的 query 串（如 "score=1234&from=share"）。 */
  query?: string;
  imageUrl?: string;
}

/**
 * 云能力桥（S9 实装；此前占位）。开放数据域好友排行不在此——它是独立沙箱
 * （另一次 canvas + 受限 API），走 openDataContext 子包 + postMessage，S9 单独设计。
 */
export interface CloudBridge {
  /** 通用云函数调用（wx.cloud.callFunction）。 */
  callFunction(name: string, data?: unknown): Promise<unknown>;
  /** 账号级存档写入（云开发 DB，key 主键含 openid；换机不丢档）。 */
  saveProgress(key: string, data: unknown): Promise<void>;
  /** 账号级存档读取；无记录 resolve null。 */
  loadProgress(key: string): Promise<unknown | null>;
  /** 分数上报（榜单数据源）。 */
  submitScore(score: number, meta?: Record<string, unknown>): Promise<void>;
}

/**
 * wx 专属能力集合。挂载为 PlatformAdapter.extras（可选）：
 * - wx 实现必须全量提供；
 * - web 壳提供 no-op / fetch 兜底实现（readJson→fetchJson、login→游客、share→console、cloud→reject），
 *   业务代码可无分支调用，「网页调试壳走通全流程」不被 wx 能力缺失卡死。
 */
export interface WxExtras {
  /** wx.login → code → 云函数 code2session → openid（S9；替换登录页本地格式校验）。 */
  login(): Promise<WxIdentity>;
  /** 主动分享（S9）。 */
  share(opts: ShareOptions): void;
  readonly cloud: CloudBridge;
  /**
   * 读 JSON 资源（S6 实装，S8 接 CDN manifest）。
   * path 为包内相对路径（分包资源，wx.getFileSystemManager 读）或 http(s) URL（wx.downloadFile→缓存→读）。
   */
  readJson(path: string): Promise<unknown>;
  /** 读二进制资源（贴图/字体图集/模型），来源约定同 readJson。 */
  readBinary(path: string): Promise<ArrayBuffer>;
  /** IAA 预留（S9.4：只定义不实装）：激励视频，resolve 观看结果。 */
  showRewardAd?(unitId: string): Promise<'rewarded' | 'closed' | 'failed'>;
  /** 订阅消息预留（S9.4：只定义不实装）。 */
  requestSubscribeMessage?(templateIds: readonly string[]): Promise<void>;
}

// ============================================================
// §5 PlatformAdapter v2 主接口
// ============================================================

export interface PlatformAdapter {
  /** 运行时探测用（S2/S3 过渡期防新旧垫片错配）；v1 无此字段。 */
  readonly version: 2;
  readonly env: 'web' | 'wx';

  /** v1 createCanvasHost 的去向（拆分为工厂四方法，见 §1）。 */
  readonly canvas: CanvasFactory;

  /** v1 onGesture + onKey 的合并去向。可在画布创建前任意时刻订阅（v1「先建画布否则 throw」的坑废止）。 */
  onInput(cb: (e: InputEvent) => void): Unsubscribe;

  readonly storage: SyncStorage;
  /** 非 2xx 一律 reject（两端一致）；wx 映射 wx.request。 */
  fetchJson(url: string): Promise<unknown>;
  /** cb 的 timeMs 与 now() 同时间基准（契约，wx 实现必要时内部换算）。 */
  requestFrame(cb: (timeMs: number) => void): FrameHandle;
  cancelFrame(handle: FrameHandle): void;
  /** 参数语义保持 v1：hidden=true 表示进入后台。wx 映射 onShow→false / onHide→true。 */
  onVisibility(cb: (hidden: boolean) => void): Unsubscribe;
  /** 毫秒单调钟（web: performance.now；wx: getPerformance().now）。 */
  now(): number;

  /** wx 专属能力（可选注入，见 §4）；wx 实现必供，web 壳给 no-op/兜底实现。 */
  readonly extras?: WxExtras;
}

/** S3 两端工厂的契约锚点（实现体不在草案内）。 */
export declare function createWxAdapter(): PlatformAdapter;

// ============================================================
// §6 最小 wx 全局类型声明（自包含草案用；生产由 platform-wx 换官方 miniprogram-api-typings）
// ============================================================

interface WxTouch {
  identifier: number;
  clientX: number;
  clientY: number;
}

interface WxTouchEvent {
  touches: WxTouch[];
  changedTouches: WxTouch[];
  timeStamp: number;
}

interface WxCanvasLike {
  width: number;
  height: number;
  getContext(contextId: string, attrs?: unknown): ContextHandle | null;
  style?: Record<string, string | undefined>;
}

interface WxRequestTask {
  abort(): void;
}

interface WxFileSystemManager {
  readFileSync(filePath: string, encoding?: string): string | ArrayBuffer;
  readFile(opts: {
    filePath: string;
    encoding?: string;
    success?(res: { data: string | ArrayBuffer }): void;
    fail?(err: { errMsg: string }): void;
  }): void;
}

interface WxGlobal {
  /** 首次调用返回屏幕画布，后续返回离屏画布（官方语义）。 */
  createCanvas(): WxCanvasLike;
  getWindowInfo(): { windowWidth: number; windowHeight: number; pixelRatio: number };
  onTouchStart(cb: (e: WxTouchEvent) => void): void;
  onTouchEnd(cb: (e: WxTouchEvent) => void): void;
  onTouchCancel(cb: (e: WxTouchEvent) => void): void;
  offTouchStart(cb: (e: WxTouchEvent) => void): void;
  offTouchEnd(cb: (e: WxTouchEvent) => void): void;
  offTouchCancel(cb: (e: WxTouchEvent) => void): void;
  getStorageSync(key: string): string;
  setStorageSync(key: string, data: string): void;
  removeStorageSync(key: string): void;
  request(opts: {
    url: string;
    method?: 'GET' | 'POST';
    dataType?: 'json' | string;
    timeout?: number;
    success?(res: { statusCode: number; data: unknown }): void;
    fail?(err: { errMsg: string }): void;
  }): WxRequestTask;
  downloadFile(opts: {
    url: string;
    success?(res: { statusCode: number; tempFilePath: string }): void;
    fail?(err: { errMsg: string }): void;
  }): WxRequestTask;
  onShow(cb: () => void): void;
  onHide(cb: () => void): void;
  offShow(cb: () => void): void;
  offHide(cb: () => void): void;
  onWindowResize(cb: (res: { windowWidth: number; windowHeight: number }) => void): void;
  offWindowResize(cb: (res: { windowWidth: number; windowHeight: number }) => void): void;
  getPerformance(): { now(): number };
  requestAnimationFrame(cb: (timeMs: number) => void): number;
  cancelAnimationFrame(handle: number): void;
  login(opts: {
    success?(res: { code: string }): void;
    fail?(err: { errMsg: string }): void;
  }): void;
  shareAppMessage(opts: { title?: string; query?: string; imageUrl?: string }): void;
  getFileSystemManager(): WxFileSystemManager;
  cloud?: {
    callFunction(opts: {
      name: string;
      data?: unknown;
      success?(res: { result: unknown }): void;
      fail?(err: { errMsg: string }): void;
    }): Promise<unknown>;
  };
}

/** 仅本草案可见的模块级声明；platform-wx 生产代码改用官方全局类型。 */
declare const wx: WxGlobal;

/** 类型层自检：wx 全局面足以支撑映射表（编译通过即证明签名对齐，无运行时产物）。 */
declare const _wxSurfaceCheck: [
  typeof wx.createCanvas,
  typeof wx.getWindowInfo,
  typeof wx.onTouchStart,
  typeof wx.getStorageSync,
  typeof wx.request,
  typeof wx.downloadFile,
  typeof wx.onShow,
  typeof wx.getPerformance,
  typeof wx.requestAnimationFrame,
  typeof wx.login,
  typeof wx.shareAppMessage,
  typeof wx.getFileSystemManager,
];
export type _WxSurface = typeof _wxSurfaceCheck;
