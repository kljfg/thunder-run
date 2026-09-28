/**
 * 信封组装辅助（纯函数，从 pipeline 拆出——R4「一个文件一个概念」：管线只做编排）。
 * sid 解析与持久化（spec §2/D5）、fields/tags 合并（公共维度→scope→事件 三层覆盖）、
 * error 通道级别判定（spec §2 表 + §3.1「fatal 仅 crash 通道」）。
 */
import type {
  Channel, Fields, LogLevel, MetricKind, Tags, TelemetryCommonDimensions, TelemetryEnvelope,
  TelemetryStorageSync,
} from './types.js';
import { ENVELOPE_VERSION, SESSION_STORAGE_KEY } from './types.js';
import { randomHex } from './canonical.js';

/** 管线内部可变信封（dupCount/dropped.count 在 flush 前就地更新；发出后不可再变）。 */
export type MutableEnvelope = { -readonly [K in keyof TelemetryEnvelope]: TelemetryEnvelope[K] };

/** storage 读写全 try/catch（宿主异常不冒泡——遥测永不向业务抛异常，spec §1.3）。 */
export function resolveSessionId(storage: TelemetryStorageSync): string {
  try {
    const existing = storage.get(SESSION_STORAGE_KEY);
    if (typeof existing === 'string' && /^[0-9a-f]{16}$/.test(existing)) return existing;
  } catch { /* 读失败 → 新造 */ }
  const sid = randomHex(16);
  try { storage.set(SESSION_STORAGE_KEY, sid); } catch { /* 写失败 → 本 boot 内存态 */ }
  return sid;
}

/** 多层 fields 合并（后层覆盖前层；undefined 值剔除——canonicalJson 语义稳定）。 */
export function mergeFields(layers: readonly (Fields | null | undefined)[]): Fields | undefined {
  let out: Fields | undefined;
  for (const l of layers) {
    if (!l) continue;
    for (const k of Object.keys(l)) {
      const v = l[k];
      if (v === undefined) continue;
      (out ??= {})[k] = v;
    }
  }
  return out;
}

/** 多层 tags 合并（后层覆盖前层）。 */
export function mergeTags(layers: readonly (Tags | null | undefined)[]): Tags | undefined {
  let out: Tags | undefined;
  for (const l of layers) if (l) for (const k of Object.keys(l)) (out ??= {})[k] = l[k];
  return out;
}

/** error 通道级别：crash.* = fatal（该 boot 可能就此终结），其余 = error。 */
export const errorLevelOf = (name: string): LogLevel => (name.startsWith('crash.') ? 'fatal' : 'error');

/** 信封部件（通道特有字段）。 */
export interface EnvelopeParts {
  level?: LogLevel;
  kind?: MetricKind;
  val?: number | readonly number[];
  fields?: Fields;
  tags?: Tags;
}

/**
 * 信封构建器：seq 留 0 占位（管线在过滤全通过后才赋号——空洞只来自 overflow/transport），
 * 公共维度（spec §2，可变对象组装时读当前值）→ scope → 事件字段 三层合并。
 */
export function createEnvelopeBuilder(ctx: {
  now(): number; bootId: string; sid: string; common?: TelemetryCommonDimensions;
}) {
  return function buildEnvelope(ch: Channel, name: string, parts: EnvelopeParts, scopeFields?: Fields): MutableEnvelope {
    const env: MutableEnvelope = {
      v: ENVELOPE_VERSION, ch, ts: ctx.now(), epochMs: Date.now(), seq: 0, bootId: ctx.bootId, sid: ctx.sid, name,
    };
    if (parts.level !== undefined) env.level = parts.level;
    if (parts.kind !== undefined) env.kind = parts.kind;
    if (parts.val !== undefined) env.val = parts.val;
    const fields = mergeFields([ctx.common?.fields, scopeFields, parts.fields]);
    if (fields) env.fields = fields;
    const tags = mergeTags([ctx.common?.tags, parts.tags]);
    if (tags) env.tags = tags;
    return env;
  };
}
