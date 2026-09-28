/**
 * 遥测 web 通道（S16b，spec §6/D9）：Console echo + 环缓冲 + sendBeacon 上报（fetch keepalive 兜底）
 * + crash 捕获安装 + createWebTelemetry 装配面。独立导出（不改 webPlatform.ts）——
 * bootstrap/mainFlow 的接线延后到整合会话，位置与代码样例见 docs/telemetry-wiring.md §2。
 * 管线本体在 @tr/telemetry（纯逻辑）；本文件只做 DOM/BOM 出口（platform-web 职责边界）。
 */
import { canonicalJson } from '@tr/telemetry/canonical.js';
import { createNoopTelemetry } from '@tr/telemetry/noop.js';
import { createTelemetry } from '@tr/telemetry/pipeline.js';
import { readTelemetryConfig } from '@tr/telemetry/config.js';
import { createTelemetrySdk } from '@tr/telemetry/sdk.js';
import type { TelemetrySdk } from '@tr/telemetry/sdk.js';
import type {
  Fields, MemoryPayload, Telemetry, TelemetryCommonDimensions, TelemetryConfig,
  TelemetryEnvelope, TelemetryHost, TelemetrySink, Unsubscribe,
} from '@tr/telemetry/types.js';

// ---------- Console sink：echo + 环缓冲（spec §4.6/§6） ----------

export interface ConsoleTelemetrySink extends TelemetrySink {
  /** 环缓冲最近 n 条信封快照（__trRun 探针数据源；管线级 recent 之外的 sink 本地视图）。 */
  recent(n: number): readonly TelemetryEnvelope[];
}

/**
 * console echo + 环缓冲。echo 在 mirror（入队同时）发生——?debug 实时可见，不等 flush。
 * echoMetrics=false 时 metric 只入环不进控制台（高频指标防刷屏）。
 */
export function createConsoleSink(opts?: { echoMetrics?: boolean; ringSize?: number }): ConsoleTelemetrySink {
  const echoMetrics = opts?.echoMetrics ?? true;
  const cap = opts?.ringSize ?? 200;
  const ring: TelemetryEnvelope[] = [];
  const echo = (env: TelemetryEnvelope): void => {
    if (env.ch === 'metric' && !echoMetrics) return;
    const level = env.level ?? (env.ch === 'metric' ? 'debug' : 'info');
    const fn = level === 'warn' ? console.warn
      : level === 'error' || level === 'fatal' ? console.error
        : level === 'info' ? console.info : console.debug;
    const payload: Record<string, unknown> = {};
    if (env.val !== undefined) payload.val = env.val;
    if (env.fields) payload.fields = env.fields;
    if (env.tags) payload.tags = env.tags;
    fn(`[tr.${level}]`, env.name, payload);
  };
  return {
    id: 'web-console',
    send: () => {}, // echo 已在 mirror 同步发生；console 无传输语义（void = 成功）
    mirror(env) {
      ring.push(env);
      if (ring.length > cap) ring.shift();
      try { echo(env); } catch { /* console 被宿主禁用/抛错不冒泡 */ }
    },
    recent: n => ring.slice(Math.max(0, ring.length - n)),
  };
}

// ---------- Beacon sink：sendBeacon 主 + fetch keepalive 兜底（spec §6/D9） ----------

/**
 * endpoint 空串 = 本 sink 不注册（返回 null——调试壳零网络噪音，spec §5）。
 * payload = 信封数组的 canonicalJson（不引入 collector SDK；collector 端形态归 S8/S9）。
 */
export function createBeaconSink(endpoint: string): TelemetrySink | null {
  if (!endpoint) return null;
  return {
    id: 'web-beacon',
    async send(batch) {
      const body = canonicalJson(batch);
      // sendBeacon 同步调用发生在首个 await 之前——crash/pagehide 的最后窗口语义保住
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        try {
          if (navigator.sendBeacon(endpoint, new Blob([body], { type: 'application/json' }))) return true;
        } catch { /* 配额/序列化异常 → 退化 fetch keepalive */ }
      }
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          keepalive: true,
          headers: { 'content-type': 'application/json' },
          body,
        });
        return res.ok;
      } catch {
        return false; // 管线按 batch.retry 重试 1 次后计 dropped{transport}
      }
    },
  };
}

// ---------- crash 捕获（spec §4.5：window.onerror + unhandledrejection） ----------

/**
 * 安装 web 端 crash 捕获 → error 通道（priority now + 指纹去重在管线内建）。
 * 同端多捕获器并存互不吞并：保留并回放此前的 window.onerror。
 */
export function installWebErrorCapture(telemetry: Telemetry): Unsubscribe {
  if (typeof window === 'undefined') return () => {}; // node 直测环境：静默不装
  const prev = window.onerror;
  window.onerror = (message, source, lineno, colno, error): boolean => {
    const context: Fields = {};
    if (typeof source === 'string' && source.length > 0) context.file = source;
    if (typeof lineno === 'number') context.line = lineno;
    if (typeof colno === 'number') context.col = colno;
    // 跨域脚本栈被浏览器净化：error 为空且 message='Script error.'（spec §4.5）
    if (!error && String(message) === 'Script error.') context.src = 'crossorigin';
    telemetry.error(error ?? String(message), context, { priority: 'now', name: 'crash.uncaught' });
    if (typeof prev === 'function') return prev.call(window, message, source, lineno, colno, error);
    return false;
  };
  const onRejection = (e: PromiseRejectionEvent): void => {
    telemetry.error(e.reason, undefined, { priority: 'now', name: 'crash.rejection' });
  };
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.onerror = prev;
    window.removeEventListener('unhandledrejection', onRejection);
  };
}

// ---------- 内存读取（spec §4.3/§6：performance.memory，Chromium 专有） ----------

interface ChromiumMemoryInfo {
  usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number;
}

/** 读 web 内存水位；Firefox/Safari 无 performance.memory → src:'unavailable'（不许静默缺失）。 */
export function readWebMemory(): MemoryPayload {
  const perf: (Performance & { memory?: ChromiumMemoryInfo }) | undefined =
    typeof performance !== 'undefined' ? performance : undefined;
  const mem = perf?.memory;
  if (!mem) return { src: 'unavailable' };
  const mb = (v: number): number => +(v / 1048576).toFixed(2);
  return { usedMB: mb(mem.usedJSHeapSize), totalMB: mb(mem.totalJSHeapSize), limitMB: mb(mem.jsHeapSizeLimit), src: 'performance.memory' };
}

// ---------- 装配面：createWebTelemetry（即插即用，接线见 docs/telemetry-wiring.md §2） ----------

export interface WebTelemetryOptions {
  /** game.json 的 params 对象（含 telemetry 节）；缺节 → noop 管线（D13）。 */
  params?: Record<string, unknown>;
  /** 直接给定配置（优先于 params；「配置未加载先用缺省」的接线方案用 TELEMETRY_CONFIG_DEFAULTS）。 */
  cfg?: TelemetryConfig;
  /** ?debug：minLevel 钳到 trace（spec §3.1），并暴露 __trRun 数据源 recent()。 */
  debug?: boolean;
  /** transport.webEndpoint 覆盖（联调 collector 用；config 值优先被本项覆盖）。 */
  endpoint?: string;
  /** console 是否回显 metric（缺省 true；生产 web 建议 false）。 */
  echoMetrics?: boolean;
  /** crash 捕获随装配自动安装（缺省 true；已自行安装 installWebErrorCapture 时关掉防双份）。 */
  installErrorCapture?: boolean;
  /** 首屏原点 T0（入口第一行的 performance.now()，markBoot 缺省 ms 的基准）。 */
  t0?: number;
  /** 仅 web：T0 与 navigation start 的偏移（performance.timeOrigin 换算），进 boot.summary。 */
  navOffsetMs?: number;
  /** 公共维度初值（common 对象可变：configHash 等配置加载完成后回填，实时生效）。 */
  quality?: string;
  engineVersion?: string;
  configHash?: string;
}

export interface WebTelemetryHandle {
  telemetry: Telemetry;
  sdk: TelemetrySdk;
  /** noop 管线（cfg 缺节）时为 null。 */
  consoleSink: ConsoleTelemetrySink | null;
  /** 可变公共维度：加载配置后回填 common.fields.configHash / tags.quality（信封组装时读当前值）。 */
  common: TelemetryCommonDimensions;
  /** undefined = 缺节 → noop。 */
  cfg: TelemetryConfig | undefined;
  /** pagehide/crash 捕获退订 + telemetry.destroy()（最终 flush 尽力而为）。 */
  uninstall(): void;
}

function webDevice(): string {
  return typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string'
    ? navigator.userAgent.slice(0, 64) : 'node';
}

export function createWebTelemetry(host: TelemetryHost, opts?: WebTelemetryOptions): WebTelemetryHandle {
  const configWarn = (msg: string): void => {
    try { console.warn('[tr.telemetry-config]', msg); } catch { /* console 不可用则吞掉 */ }
  };
  let cfg = opts?.cfg ?? readTelemetryConfig(opts?.params, configWarn);
  if (cfg && opts?.debug && cfg.minLevel !== 'trace') cfg = { ...cfg, minLevel: 'trace' };

  const common: TelemetryCommonDimensions = { tags: { env: 'web' }, fields: { device: webDevice() } };
  if (opts?.quality) common.tags!.quality = opts.quality;
  if (opts?.engineVersion) common.fields!.engineVersion = opts.engineVersion;
  if (opts?.configHash) common.fields!.configHash = opts.configHash;

  const sdkOf = (telemetry: Telemetry): TelemetrySdk =>
    createTelemetrySdk(telemetry, { now: () => host.now(), t0: opts?.t0, navOffsetMs: opts?.navOffsetMs });

  if (!cfg) {
    // 缺节/节非对象 → noop（调用点零分支，D13）；sdk 面完整可用、零副作用
    const telemetry = createNoopTelemetry();
    return { telemetry, sdk: sdkOf(telemetry), consoleSink: null, common, cfg: undefined, uninstall: () => {} };
  }

  const consoleSink = createConsoleSink({ echoMetrics: opts?.echoMetrics ?? true });
  const beacon = createBeaconSink(opts?.endpoint ?? cfg.transport.webEndpoint);
  const sinks: TelemetrySink[] = beacon ? [consoleSink, beacon] : [consoleSink];
  const telemetry = createTelemetry(host, cfg, sinks, common);
  const sdk = sdkOf(telemetry);

  const cleanups: Unsubscribe[] = [];
  if (typeof window !== 'undefined') {
    // pagehide = sendBeacon 的最后窗口（与 adapter.onVisibility 幂等去重：flush 空队列即 no-op）
    const onPageHide = (): void => { void telemetry.flush(); };
    window.addEventListener('pagehide', onPageHide);
    cleanups.push(() => window.removeEventListener('pagehide', onPageHide));
    if (opts?.installErrorCapture !== false) cleanups.push(installWebErrorCapture(telemetry));
  }

  return {
    telemetry,
    sdk,
    consoleSink,
    common,
    cfg,
    uninstall: () => {
      for (const off of cleanups) { try { off(); } catch { /* 退订失败不冒泡 */ } }
      telemetry.destroy();
    },
  };
}
