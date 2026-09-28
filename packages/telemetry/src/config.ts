/**
 * config 技术段 params.telemetry 的解析与钳制（spec §5）。
 * 缺节/节非对象 → undefined（调用方 → createNoopTelemetry，调用点零分支，D13）；
 * 字段级类型错 → 回落缺省并 warn；越界数值钳制（sample 0..100、maxEvents 1..200、
 * maxBytesPerFlush ≤ 64KiB）并 warn——warn 经注入的 onWarn 出口（纯逻辑包不触 console）。
 */
import type { LogLevel, TelemetryConfig } from './types.js';
import { LOG_LEVELS } from './types.js';

/** spec §5 JSON 缺省值的类型化镜像（数值与文档逐项一致）。 */
export const TELEMETRY_CONFIG_DEFAULTS: TelemetryConfig = {
  enabled: true,
  minLevel: 'info',
  sampleRates: { default: 100, 'perf.frameDist': 100, 'debug.probe': 0 },
  rateLimit: { perNamePerMin: 30, maxBytesPerMin: 65536 },
  batch: { maxEvents: 30, maxBytesPerFlush: 16384, maxDelayMs: 5000, flushOnHide: true, retry: 1 },
  error: { sample: 100, maxStackBytes: 4096, dedupWindowMs: 60000 },
  memory: { sampleEveryS: 10 },
  transport: { webEndpoint: '', wxRealtimeLog: true, wxCloudCollection: 'telemetry', mirrorOfficial: false },
};

export type TelemetryConfigWarn = (msg: string) => void;

const MAX_FLUSH_BYTES_HARD = 65536; // sendBeacon 体积安全线（spec §3.4）

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 数值字段读取：缺失/非有限数 → fallback + warn；否则 clamp 到 [min,max]（越界 warn）。 */
function num(src: Record<string, unknown>, key: string, fallback: number, min: number, max: number,
  where: string, warn: TelemetryConfigWarn, int = true): number {
  const raw = src[key];
  if (raw === undefined) return fallback;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    warn(`${where}.${key}: 非数值（${JSON.stringify(raw)}），回落缺省 ${fallback}`);
    return fallback;
  }
  let v = int ? Math.round(raw) : raw;
  if (v < min || v > max) {
    const clamped = Math.min(max, Math.max(min, v));
    warn(`${where}.${key}: ${v} 越界，钳制为 ${clamped}（允许 [${min},${max}]）`);
    v = clamped;
  }
  return v;
}

function bool(src: Record<string, unknown>, key: string, fallback: boolean, where: string, warn: TelemetryConfigWarn): boolean {
  const raw = src[key];
  if (raw === undefined) return fallback;
  if (typeof raw !== 'boolean') {
    warn(`${where}.${key}: 非布尔（${JSON.stringify(raw)}），回落缺省 ${fallback}`);
    return fallback;
  }
  return raw;
}

function str(src: Record<string, unknown>, key: string, fallback: string, where: string, warn: TelemetryConfigWarn): string {
  const raw = src[key];
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string') {
    warn(`${where}.${key}: 非字符串（${JSON.stringify(raw)}），回落缺省 ${JSON.stringify(fallback)}`);
    return fallback;
  }
  return raw;
}

/**
 * 从 game.json 的 params 解析 telemetry 节。
 * @param params game.json 的 params 对象（undefined/缺节/节非对象 → undefined → noop 管线）
 * @param onWarn 钳制/类型告警出口（每次钳制 warn 一条；缺省吞掉）
 */
export function readTelemetryConfig(
  params: Record<string, unknown> | undefined,
  onWarn?: TelemetryConfigWarn,
): TelemetryConfig | undefined {
  if (!isObj(params)) return undefined;
  const raw = params.telemetry;
  if (raw === undefined) return undefined;
  if (!isObj(raw)) {
    onWarn?.('game.params.telemetry: 节存在但不是对象，按缺节处理（noop 管线）');
    return undefined;
  }
  const warn: TelemetryConfigWarn = onWarn ?? (() => {});
  const d = TELEMETRY_CONFIG_DEFAULTS;

  let minLevel: LogLevel = d.minLevel;
  if (raw.minLevel !== undefined) {
    if (typeof raw.minLevel === 'string' && (LOG_LEVELS as readonly string[]).includes(raw.minLevel)) {
      minLevel = raw.minLevel as LogLevel;
    } else {
      warn(`game.params.telemetry.minLevel: 非法级别（${JSON.stringify(raw.minLevel)}），回落缺省 ${d.minLevel}`);
    }
  }

  const sampleRates: TelemetryConfig['sampleRates'] = { default: d.sampleRates.default };
  if (isObj(raw.sampleRates)) {
    for (const name of Object.keys(raw.sampleRates)) {
      sampleRates[name] = num(raw.sampleRates, name, d.sampleRates.default, 0, 100,
        'game.params.telemetry.sampleRates', warn);
    }
  } else if (raw.sampleRates !== undefined) {
    warn('game.params.telemetry.sampleRates: 非对象，整节回落缺省');
    Object.assign(sampleRates, d.sampleRates);
  } else {
    Object.assign(sampleRates, d.sampleRates);
  }

  const rl = isObj(raw.rateLimit) ? raw.rateLimit : {};
  if (raw.rateLimit !== undefined && !isObj(raw.rateLimit)) warn('game.params.telemetry.rateLimit: 非对象，回落缺省');
  const batch = isObj(raw.batch) ? raw.batch : {};
  if (raw.batch !== undefined && !isObj(raw.batch)) warn('game.params.telemetry.batch: 非对象，回落缺省');
  const err = isObj(raw.error) ? raw.error : {};
  if (raw.error !== undefined && !isObj(raw.error)) warn('game.params.telemetry.error: 非对象，回落缺省');
  const mem = isObj(raw.memory) ? raw.memory : {};
  if (raw.memory !== undefined && !isObj(raw.memory)) warn('game.params.telemetry.memory: 非对象，回落缺省');
  const tr = isObj(raw.transport) ? raw.transport : {};
  if (raw.transport !== undefined && !isObj(raw.transport)) warn('game.params.telemetry.transport: 非对象，回落缺省');

  // error.sample 仅允许 100|0（应急总开关，不半采——D4）：非 0 一律归 100
  let errorSample: 0 | 100 = d.error.sample;
  if (err.sample !== undefined) {
    if (err.sample === 0) errorSample = 0;
    else {
      if (err.sample !== 100) warn(`game.params.telemetry.error.sample: ${JSON.stringify(err.sample)} 非法（仅 0|100），归 100`);
      errorSample = 100;
    }
  }

  return {
    enabled: bool(raw, 'enabled', d.enabled, 'game.params.telemetry', warn),
    minLevel,
    sampleRates,
    rateLimit: {
      perNamePerMin: num(rl, 'perNamePerMin', d.rateLimit.perNamePerMin, 1, 100000, 'game.params.telemetry.rateLimit', warn),
      maxBytesPerMin: num(rl, 'maxBytesPerMin', d.rateLimit.maxBytesPerMin, 1024, 10485760, 'game.params.telemetry.rateLimit', warn),
    },
    batch: {
      maxEvents: num(batch, 'maxEvents', d.batch.maxEvents, 1, 200, 'game.params.telemetry.batch', warn),
      maxBytesPerFlush: num(batch, 'maxBytesPerFlush', d.batch.maxBytesPerFlush, 1024, MAX_FLUSH_BYTES_HARD, 'game.params.telemetry.batch', warn),
      maxDelayMs: num(batch, 'maxDelayMs', d.batch.maxDelayMs, 0, 600000, 'game.params.telemetry.batch', warn),
      flushOnHide: bool(batch, 'flushOnHide', d.batch.flushOnHide, 'game.params.telemetry.batch', warn),
      retry: num(batch, 'retry', d.batch.retry, 0, 3, 'game.params.telemetry.batch', warn),
    },
    error: {
      sample: errorSample,
      maxStackBytes: num(err, 'maxStackBytes', d.error.maxStackBytes, 256, 65536, 'game.params.telemetry.error', warn),
      dedupWindowMs: num(err, 'dedupWindowMs', d.error.dedupWindowMs, 0, 3600000, 'game.params.telemetry.error', warn),
    },
    memory: {
      sampleEveryS: num(mem, 'sampleEveryS', d.memory.sampleEveryS, 1, 3600, 'game.params.telemetry.memory', warn),
    },
    transport: {
      webEndpoint: str(tr, 'webEndpoint', d.transport.webEndpoint, 'game.params.telemetry.transport', warn),
      wxRealtimeLog: bool(tr, 'wxRealtimeLog', d.transport.wxRealtimeLog, 'game.params.telemetry.transport', warn),
      wxCloudCollection: str(tr, 'wxCloudCollection', d.transport.wxCloudCollection, 'game.params.telemetry.transport', warn),
      mirrorOfficial: bool(tr, 'mirrorOfficial', d.transport.mirrorOfficial, 'game.params.telemetry.transport', warn),
    },
  };
}
