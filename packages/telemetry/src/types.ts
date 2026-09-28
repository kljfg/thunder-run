/**
 * 遥测与日志框架类型契约（S16b 定稿，自 drafts/telemetry.ts 迁入；规格 docs/telemetry-spec.md）。
 * 纯逻辑包：本文件只有类型与枚举常量；实现分布在 canonical/buckets/frameDist/config/
 * errorSerialize/limiter/pipeline/noop/digests/sdk/wxChannel，桶经 index.ts barrel 再导出。
 * 草案 §9 sink 工厂的定稿落位：web → packages/platform-web/src/telemetryChannel.ts；
 * wx → 本包 wxChannel.ts（结构化注入宿主 API，platform-wx 的注册入口留 TODO，
 * 接线点见 docs/telemetry-wiring.md §4——S6 并行期 platform-wx 锁定所致，规格 D1 的纯逻辑纪律不破）。
 * 相对草案的定稿差异（全部加法，逐项见 PR 偏差清单）：
 * - EmitOptions.name：error 通道的事件名载体（crash.uncaught/rejection/wxError）；
 * - TelemetrySink.init：管线构造时回传 bootId/sid（wx 实时日志 setFilterMsg 需要）；
 * - createTelemetry 第 4 参 common（spec §2 公共维度注入，可变对象、组装时读当前值）；
 * - readTelemetryConfig 第 2 参 onWarn（钳制告警出口，纯逻辑包不触 console）。
 */

// ============================================================
// §0 通用类型
// ============================================================

/** 采样百分比：整数 0..100（对齐 antiCheat.replaySampleRate 语义；类型层放宽为 number，readTelemetryConfig 运行时钳制）。 */
export type SamplePercent = number;

/** 日志级别（序：trace < debug < info < warn < error < fatal）。 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** 级别序（spec §3.1）；数值越大越严重。 */
export const LOG_LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
export const LOG_LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5,
};

/** 三通道。 */
export type Channel = 'log' | 'metric' | 'error';

/** metric 形态：counter=增量 gauge=瞬时 timer=ms histogram=桶计数。 */
export type MetricKind = 'counter' | 'gauge' | 'timer' | 'histogram';

/** 信封标量字段值（嵌套对象须先 canonicalJson 成字符串再入 fields）。 */
export type Scalar = string | number | boolean | null;
export type Fields = Record<string, Scalar>;
/** tags 仅收低基数字符串维度（device/quality/env…）；高基数值（seed/runId）一律进 fields。 */
export type Tags = Record<string, string>;

/** on* 订阅退订函数（与 v2 adapter 的 Unsubscribe 同形）。 */
export type Unsubscribe = () => void;

/** 发送优先级：now = 立即成批 + 不入可丢队列（crash 专用）。 */
export interface EmitOptions {
  priority?: 'normal' | 'now';
  /** error 通道事件名（crash.uncaught/crash.rejection/crash.wxError…）；缺省 crash.uncaught。 */
  name?: TelemetryEventName | (string & {});
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
  /** 会话内自 1 单调递增，断流检测（过滤丢弃不占号，空洞仅来自 overflow/transport）。 */
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

/** sessionId 的 storage 键（spec §2，沿用项目 thunderrun: 前缀规范）。 */
export const SESSION_STORAGE_KEY = 'thunderrun:telemetry:session';

/** 信封版本（接收端遇未知大版本拒绝入库）。 */
export const ENVELOPE_VERSION = 1;

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
// §4 对局结果摘要（spec §8，与 replay-format §4 / runner.mjs 逐字对齐）
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
// §5 config 技术段 params.telemetry（spec §5）
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

// ============================================================
// §6 宿主注入面（v2 adapter 的结构子集，spec §1/D1）
// ============================================================

/** 与 PlatformAdapter v2 storage 逐字段兼容（S10 §3；'' 归一化由 v2 实现保证）。 */
export interface TelemetryStorageSync {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/**
 * 管线所需的最小宿主能力：v2 adapter 对象直接满足（now/storage/onVisibility）。
 * 不含 fetch/cloud——那些属 sink 构造参数，核心管线零传输依赖。
 */
export interface TelemetryHost {
  now(): number;
  storage: TelemetryStorageSync;
  onVisibility?(cb: (hidden: boolean) => void): Unsubscribe;
}

/**
 * 管线组装时统一注入的公共维度（spec §2：tags{env,quality}、fields{engineVersion,configHash,device}）。
 * 可变对象：管线在每次组装信封时读当前值——configHash 等在配置加载完成后回填（接线文档 §2.4）。
 */
export interface TelemetryCommonDimensions {
  tags?: Tags;
  fields?: Fields;
}

// ============================================================
// §7 三通道接口与 sink（spec §3/§6/§7）
// ============================================================

/** 管线构造时经 TelemetrySink.init 回传的会话标识（wx setFilterMsg(bootId) 等用）。 */
export interface TelemetrySinkInfo {
  bootId: string;
  sid: string;
}

export interface TelemetrySink {
  readonly id: string;
  /** 一批发出。返回 false / reject = 失败（管线重试后丢弃并计 dropped）。实现内部不得抛穿到调用方。 */
  send(batch: readonly TelemetryEnvelope[]): Promise<boolean | void> | void;
  /** 可选：同步兜底通道（如 wx realtime log 镜像），在批入队同时立即调用。 */
  mirror?(envelope: TelemetryEnvelope): void;
  /** 可选：管线构造完成时调用一次（回传 bootId/sid；晚于 sink 工厂、早于任何事件）。 */
  init?(info: TelemetrySinkInfo): void;
}

export interface Telemetry {
  log(level: LogLevel, name: TelemetryEventName | (string & {}), fields?: Fields, opts?: EmitOptions): void;
  metric(name: TelemetryEventName | (string & {}), kind: MetricKind, val: number | readonly number[], tags?: Tags, opts?: EmitOptions): void;
  /** err: Error | string | 未知值；内部 serializeError + 指纹去重（spec §3.3/§4.5）。事件名经 opts.name。 */
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
