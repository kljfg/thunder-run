/**
 * 遥测与日志框架类型草案（S16a 产出 · 评审稿，配套文档 docs/telemetry-spec.md）
 *
 * 定位：接口契约，不含实现。S16b 以此为基线落 packages/telemetry（正式化时可拆分文件），
 * web/wx sink 分别落 packages/platform-web 与 packages/platform-wx。
 *
 * 自包含验证（不依赖 DOM lib，不挂仓库 tsconfig；--typeRoots 指向空目录以禁用
 * node_modules/@types 自动注入——仓库根的 @types/three|webxr 无 DOM lib 时会编译失败，与本草案无关）：
 *   npx tsc --noEmit --strict --target es2020 --lib es2020 --module esnext \
 *     --typeRoots <空目录> drafts/telemetry.ts
 *   （与 DOM lib 共存：改 --lib es2020,dom，无需 typeRoots，同样通过）
 *
 * 基线：dev@87ce734。§5 结果摘要与 tools/replay/runner.mjs runReplay() 返回结构逐字对齐
 * （docs/replay-format.md §4/§7）；§7 TelemetryHost 是 PlatformAdapter v2 的结构子集
 * （docs/platform-adapter-v2.md §3），v2 adapter 对象天然满足。
 */

// ============================================================
// §0 通用类型
// ============================================================

/** 采样百分比：整数 0..100（对齐 antiCheat.replaySampleRate 语义；类型层放宽为 number，readTelemetryConfig 运行时钳制）。 */
export type SamplePercent = number;

/** 日志级别（序：trace < debug < info < warn < error < fatal）。 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** 三通道。 */
export type Channel = 'log' | 'metric' | 'error';

/** metric 形态：counter=增量 gauge=瞬时 timer=ms histogram=桶计数。 */
export type MetricKind = 'counter' | 'gauge' | 'timer' | 'histogram';

/** 信封标量字段值（嵌套对象须先 canonicalJson 成字符串再入 fields）。 */
export type Scalar = string | number | boolean | null;
export type Fields = Record<string, Scalar>;
/** tags 仅收低基数字符串维度（device/quality/env…）。 */
export type Tags = Record<string, string>;

/** on* 订阅退订函数（与 v2 adapter 的 Unsubscribe 同形）。 */
export type Unsubscribe = () => void;

/** 发送优先级：now = 立即成批 + 不入可丢队列（crash 专用）。 */
export interface EmitOptions {
  priority?: 'normal' | 'now';
}

// ============================================================
// §1 事件信封（spec §2）
// ============================================================

export interface TelemetryEnvelope {
  /** 信封大版本，v1 恒 1；接收端遇未知版本拒绝入库。 */
  readonly v: 1;
  readonly ch: Channel;
  /** adapter.now() 单调基准（ms，原点=平台构造时刻）。 */
  readonly ts: number;
  /** Date.now() 墙钟，仅报表分日/排序辅助。 */
  readonly epochMs: number;
  /** 会话内自 1 单调递增，断流检测。 */
  readonly seq: number;
  /** 冷启动标识（12 hex，仅内存）。 */
  readonly bootId: string;
  /** 跨冷启动稳定会话 ID（16 hex，storage 键 thunderrun:telemetry:session）。 */
  readonly sid: string;
  readonly name: string;
  readonly level?: LogLevel;
  readonly kind?: MetricKind;
  /** histogram 的 val 是桶计数数组（FRAME_BUCKET_COUNT 长度）。 */
  readonly val?: number | readonly number[];
  readonly fields?: Fields;
  readonly tags?: Tags;
}

/** 规范序列化：语义与 tools/replay/runner.mjs:35-44 同款（键递归字典序、无空白）。 */
export declare function canonicalJson(value: unknown): string;

// ============================================================
// §2 事件名与枚举（spec §4）
// ============================================================

export const TELEMETRY_EVENT_NAMES = [
  'session.boot', 'boot.phase', 'boot.summary',
  'config.load', 'config.loadSummary',
  'perf.frameDist', 'perf.memory', 'perf.memWarn',
  'run.start', 'run.end',
  'crash.uncaught', 'crash.rejection', 'crash.wxError',
  'anticheat.reject', 'debug.probe',
  'telemetry.dropped', 'telemetry.flush',
] as const;
export type TelemetryEventName = (typeof TELEMETRY_EVENT_NAMES)[number];

export const BOOT_PHASES = [
  'entry', 'modulesReady', 'adapterInit', 'configStart', 'configDone',
  'firstFrame', 'interactive', 'total',
] as const;
export type BootPhase = (typeof BOOT_PHASES)[number];

/** 现网三值 + manifest-schema §4 将新增的 bundle（加法演进，形状不变）。 */
export type ConfigFileSource = 'network' | 'cache' | 'bundle' | 'failed';

/** manifest-schema §4 失败策略表编号。 */
export type ManifestFallbackCode = 'F1' | 'F2' | 'F3' | 'F4' | 'F5' | 'F6' | 'F7' | 'F8' | 'F9' | 'F10';

export type MemorySource = 'performance.memory' | 'getPerformance' | 'onMemoryWarning' | 'unavailable';

export type DropReason = 'rate' | 'bytes' | 'overflow' | 'transport' | 'disabled';

// ============================================================
// §3 内置事件 payload（spec §4 各小节，形状规范）
// ============================================================

export interface BootPhasePayload { phase: BootPhase; ms: number }
export interface BootSummaryPayload extends Partial<Record<BootPhase, number>> {
  /** 仅 web：与 navigation start 的偏移（performance.timeOrigin 换算）。 */
  navOffsetMs?: number;
}

export interface ConfigLoadPayload {
  file: string;                      // CONTENT_NAMES 之一
  source: ConfigFileSource;
  ms: number;
  bytes?: number;
  sha12?: string;                    // manifest 期望哈希前 12 位
  contentVersion?: number;
  fallbackCode?: ManifestFallbackCode; // 正常路径无此字段
}
export interface ConfigLoadSummaryPayload {
  countsBySource: string;            // canonicalJson({network:n, cache:n, bundle:n, failed:n})
  hitRateCache: SamplePercent;
  hitRateBundle: SamplePercent;
  failedCount: number;
  manifestSource: 'fresh' | 'cached' | 'none';
  contentVersion?: number;
}

export interface FrameDistPayload {
  runId: string;
  scene: 'run' | 'menu' | 'bench';
  frames: number;
  buckets: readonly number[];        // FRAME_BUCKET_COUNT 个计数
  p50Ms: number;
  p95Ms: number;
  longCount: number;                 // >50ms 帧数
  worstMs: number;
  p95Approx?: boolean;               // ∞ 桶插值（400ms 封顶）时 true
  cumulative?: boolean;              // 长局 30s 快照为 true
}

export interface MemoryPayload {
  usedMB?: number; totalMB?: number; limitMB?: number; maxUsedMB?: number;
  src: MemorySource;
}
export interface MemWarnPayload { level: 5 | 10 | 15 }

export interface CrashPayload {
  message: string;                   // ≤512B 截断
  stack?: string;                    // ≤error.maxStackBytes，保留栈顶
  file?: string; line?: number; col?: number;
  reasonType?: string;               // rejection：typeof+构造器名
  src?: 'crossorigin';               // web 跨域净化标记
  fingerprint: string;
  dupCount?: number;
}

export interface DroppedPayload { reason: DropReason; name?: string; count: number }
export interface FlushPayload { ok: boolean; events: number; bytes: number; ms: number; retry: number }

// ============================================================
// §4 帧时间分桶（spec §4.2 规范常量，S19b perf bench 强制复用）
// ============================================================

/** 桶边界（左闭右开，ms）；11 个边界 + ∞ = 12 桶，最后一桶为 >200ms 溢出桶。 */
export declare const FRAME_BUCKET_EDGES_MS: readonly number[];
export declare const FRAME_BUCKET_COUNT: number;                 // 12
/** ∞ 桶百分位插值封顶（p*Approx 标记时使用的近似值）。 */
export declare const FRAME_OVERFLOW_CAP_MS: number;              // 400

export declare function bucketIndexOf(frameMs: number): number;
/** 就地累加一帧（run 主循环逐帧调用，O(1)、零分配复用数组）。 */
export declare function accumulateFrameBucket(buckets: number[], frameMs: number): void;

/** nearest-rank：ceil(q·frames)-1；q 用百分比（如 p95 → 95）。 */
export declare function percentileNearestRank(qPercent: SamplePercent, frames: number): number;
/** 桶计数 → ms（桶内均匀假设线性插值；∞ 桶封顶并置 approx）。 */
export declare function percentileFromBuckets(qPercent: SamplePercent, frames: number, buckets: readonly number[]): { ms: number; approx: boolean };

// ============================================================
// §5 对局结果摘要（spec §8，与 replay-format §4 / runner.mjs 逐字对齐）
// ============================================================

/** sim.summary() 字段快照（t/distance/coins/nearMiss/hits/score/alive/casts/charId）。 */
export interface SimSummarySnapshot {
  t: number; distance: number; coins: number; nearMiss: number;
  hits: number; score: number; alive: boolean; casts: number; charId: string;
}

/** runReplay() 返回结构的类型化对应物（golden/S18/telemetry 三方共用）。 */
export interface RunResultSummary {
  frames: number;
  summary: SimSummarySnapshot;
  eventCounts: Readonly<Record<string, number>>;  // 键字典序（canonical）
  eventsSha256: string;                            // 64hex，canonicalJson 事件日志之 sha256
  inputsSha256: string;
}

export interface RunEndPayload extends RunResultSummary {
  runId: string;
  seed: number;                    // 32 位无符号
  charId: string;
  engineVersion: string;
  /** contentVersion:sha12；无 manifest 时 'bundle:'+configVersion（spec §4.4）。 */
  configHash: string;
  frameDist: Omit<FrameDistPayload, 'runId' | 'scene' | 'cumulative'>;
  maxUsedMB?: number;
  revives: number;
}

export interface AnticheatRejectPayload {
  reason: 'replay-mismatch' | 'score-cap' | 'rate-cap' | 'config-mismatch' | 'stale-triple' | 'unknown';
  score: number;
  eventsSha256: string;
  inputsSha256: string;
}

// ============================================================
// §6 config 技术段 params.telemetry（spec §5）
// ============================================================

export interface TelemetrySampleRates { default: SamplePercent; [name: string]: SamplePercent }
export interface TelemetryConfig {
  enabled: boolean;
  minLevel: LogLevel;
  sampleRates: TelemetrySampleRates;
  rateLimit: { perNamePerMin: number; maxBytesPerMin: number };
  batch: { maxEvents: number; maxBytesPerFlush: number; maxDelayMs: number; flushOnHide: boolean; retry: number };
  error: { sample: 0 | 100; maxStackBytes: number; dedupWindowMs: number };
  memory: { sampleEveryS: number };
  transport: { webEndpoint: string; wxRealtimeLog: boolean; wxCloudCollection: string; mirrorOfficial: boolean };
}

/** spec §5 JSON 缺省值的类型化镜像。 */
export declare const TELEMETRY_CONFIG_DEFAULTS: TelemetryConfig;

/**
 * 从 game.json 的 params 解析本节：缺节/非对象 → undefined（调用方 → noop 管线）；
 * 越界数值钳制（sample 0..100、maxEvents 1..200、maxBytesPerFlush ≤64KiB）并对每次钳制 warn 一条。
 */
export declare function readTelemetryConfig(params: Record<string, unknown> | undefined): TelemetryConfig | undefined;

// ============================================================
// §7 宿主注入面（v2 adapter 的结构子集，spec §1/D1）
// ============================================================

/** 与 PlatformAdapter v2 storage 逐字段兼容（S10 §3；'' 归一化由 v2 实现保证）。 */
export interface TelemetryStorageSync {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/**
 * 管线所需的最小宿主能力：v2 adapter 对象直接满足（now/storage/onVisibility）。
 * 不含 fetch/cloud——那些属 sink 构造参数（§8），核心管线零传输依赖。
 */
export interface TelemetryHost {
  now(): number;
  storage: TelemetryStorageSync;
  onVisibility?(cb: (hidden: boolean) => void): Unsubscribe;
}

// ============================================================
// §8 三通道接口与 sink（spec §3/§6/§7）
// ============================================================

export interface TelemetrySink {
  readonly id: string;
  /** 一批发出。返回 false / reject = 失败（管线重试 1 次后丢弃并计 dropped）。实现内部不得抛穿到调用方。 */
  send(batch: readonly TelemetryEnvelope[]): Promise<boolean | void> | void;
  /** 可选：同步兜底通道（如 wx realtime log 镜像），在批入队同时立即调用。 */
  mirror?(envelope: TelemetryEnvelope): void;
}

export interface Telemetry {
  log(level: LogLevel, name: TelemetryEventName | (string & {}), fields?: Fields, opts?: EmitOptions): void;
  metric(name: TelemetryEventName | (string & {}), kind: MetricKind, val: number | readonly number[], tags?: Tags, opts?: EmitOptions): void;
  /** err: Error | string | 未知值；内部 serializeError + 指纹去重（spec §3.3/§4.5）。 */
  error(err: unknown, context?: Fields, opts?: EmitOptions): void;
  /** 子句柄：附加 runId/stage 等上下文（浅拷贝，共享父管线队列）。 */
  withScope(scope: Fields): Telemetry;
  /** timer 便捷封装：自动 metric(name,'timer',ms)，透传 fn 结果/异常。 */
  measure<T>(name: string, fn: () => T | Promise<T>): Promise<T>;
  flush(): Promise<void>;
  destroy(): void;
  /** 环缓冲最近 n 条（?debug 探针 __trRun 数据源，spec §4.6）。 */
  recent(n: number): readonly TelemetryEnvelope[];
}

export declare function serializeError(err: unknown, maxStackBytes: number): Omit<CrashPayload, 'dupCount'>;

/** FNV-1a 32 位（纯整数，双端/服务端可重算）。 */
export declare function fnv1a32(text: string): number;
/** 会话级稳定采样判定（spec §3.2）：fnv1a32(sid + '\u0000' + name) % 100 < rate。 */
export declare function sampleAccepts(sid: string, name: string, rate: SamplePercent): boolean;

/** 主管线工厂：sid/bootId 生成与持久化、信封组装、限流批处理都在内部。 */
export declare function createTelemetry(host: TelemetryHost, cfg: TelemetryConfig, sinks: readonly TelemetrySink[]): Telemetry;

// ============================================================
// §9 sink 工厂签名（实现落 platform-web / platform-wx，spec §6/§7）
// ============================================================

/** web：console echo + 环缓冲。echoMetrics=false 时 metric 只入队不进控制台。 */
export declare function createConsoleSink(opts?: { echoMetrics?: boolean; ringSize?: number }): TelemetrySink;
/** web：sendBeacon 主、fetch keepalive 兜底。endpoint 空串 = 本 sink 不注册（spec §5）。 */
export declare function createBeaconSink(endpoint: string): TelemetrySink;
/** web：install crash 捕获（window.onerror / unhandledrejection → telemetry.error）。 */
export declare function installWebErrorCapture(telemetry: Telemetry): Unsubscribe;
/** wx：RealtimeLogManager 摘要镜像（name|k=v 单行；仅 warn/error 级与关键事件）。 */
export declare function createRealtimeLogSink(): TelemetrySink;
/** wx：云函数代收通道（invoke 即 extras.cloud.callFunction 的适配）。 */
export declare function createCloudDbSink(
  collection: string,
  invoke: (name: string, payload: unknown) => Promise<unknown>,
): TelemetrySink;
/** wx：install crash 捕获（wx.onError / wx.onUnhandledRejection）。 */
export declare function installWxErrorCapture(telemetry: Telemetry): Unsubscribe;

// ============================================================
// §10 no-op 实现骨架（证明接口面可被完整实现；S16b 直接搬进包内 noop.ts）
// ============================================================

function noopTelemetry(): Telemetry {
  const nothing = (): void => {};
  const emptyEnvelopes: readonly TelemetryEnvelope[] = [];
  return {
    log: nothing,
    metric: nothing,
    error: nothing,
    withScope: () => noopTelemetry(),
    measure: <T>(_name: string, fn: () => T | Promise<T>): Promise<T> => Promise.resolve(fn()),
    flush: () => Promise.resolve(),
    destroy: nothing,
    recent: () => emptyEnvelopes,
  };
}

export function createNoopTelemetry(): Telemetry {
  return noopTelemetry();
}
