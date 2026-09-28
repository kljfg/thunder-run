/**
 * 与 S18（防作弊云复跑）/ golden 回归对齐的摘要导出（spec §8/D7，replay-format §4/§7）。
 * eventsSha256/inputsSha256 的语义与 tools/replay/runner.mjs:172-173 逐字一致：
 *   eventsSha256 = sha256Hex(canonicalJson([[frame, event], ...]))
 *   inputsSha256 = sha256Hex(canonicalJson(inputs))   （规范化后的 {frame,type,payload} 数组）
 * 云函数/CI/客户端一份实现——哈希一致是三线对齐的前提。
 */
import type { AnticheatRejectPayload, ConfigLoadSummaryPayload, Fields, RunEndPayload } from './types.js';
import { canonicalJson, sha256Hex } from './canonical.js';

/** 事件日志（[frame, event] 对数组）→ eventsSha256（64 hex）。 */
export function digestEventLog(eventLog: readonly (readonly [number, unknown])[]): string {
  return sha256Hex(canonicalJson(eventLog));
}

/** 规范化输入数组 → inputsSha256（64 hex；上报前可做快速一致性预检，replay-format §7）。 */
export function digestInputs(inputs: readonly unknown[]): string {
  return sha256Hex(canonicalJson(inputs));
}

/**
 * configHash（信封公共字段，spec §4.4）：
 * 有 manifest：contentVersion + ':' + sha256Hex(canonicalJson(files 按 CONTENT_NAMES 序的 sha256 列表)).slice(0,12)；
 * 无 manifest（现网/S8 前）：'bundle:' + configVersion。
 */
export function configHashFromShaList(contentVersion: number | string, sha256List: readonly string[]): string {
  return `${contentVersion}:${sha256Hex(canonicalJson(sha256List)).slice(0, 12)}`;
}

export function configHashBundle(configVersion: string): string {
  return `bundle:${configVersion}`;
}

/**
 * RunEndPayload → run.end 事件的平铺 fields（嵌套结构按 spec §2 canonicalJson 成字符串：
 * summary/eventCounts/frameDist 三键；标量原样）。S18 的 {engineVersion,configHash,replay,result}
 * 上报体中 result 子结构（frames/summary/eventCounts/eventsSha256/inputsSha256）与此同源。
 */
export function runEndFields(p: RunEndPayload): Fields {
  const f: Fields = {
    runId: p.runId,
    seed: p.seed,
    charId: p.charId,
    frames: p.frames,
    eventsSha256: p.eventsSha256,
    inputsSha256: p.inputsSha256,
    engineVersion: p.engineVersion,
    configHash: p.configHash,
    revives: p.revives,
    summary: canonicalJson(p.summary),
    eventCounts: canonicalJson(p.eventCounts),
    frameDist: canonicalJson(p.frameDist),
  };
  if (p.maxUsedMB !== undefined) f.maxUsedMB = p.maxUsedMB;
  return f;
}

/** AnticheatRejectPayload → anticheat.reject（log/warn）fields（spec §8：门禁不过只入本地榜并打点）。 */
export function anticheatRejectFields(p: AnticheatRejectPayload): Fields {
  return { reason: p.reason, score: p.score, eventsSha256: p.eventsSha256, inputsSha256: p.inputsSha256 };
}

/**
 * config.loadSummary fields 组装（spec §4.4）：countsBySource 嵌套对象 canonicalJson 成串，
 * 命中率 = 按文件 source 占比（整数百分比，四舍五入；total=0 时 0）。
 */
export function configLoadSummaryFields(input: {
  countsBySource: Readonly<Record<string, number>>;
  manifestSource: ConfigLoadSummaryPayload['manifestSource'];
  contentVersion?: number;
}): Fields {
  const counts = { network: 0, cache: 0, bundle: 0, failed: 0, ...input.countsBySource };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const pct = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0);
  const f: Fields = {
    countsBySource: canonicalJson(counts),
    hitRateCache: pct(counts.cache),
    hitRateBundle: pct(counts.bundle),
    failedCount: counts.failed,
    manifestSource: input.manifestSource,
  };
  if (input.contentVersion !== undefined) f.contentVersion = input.contentVersion;
  return f;
}
