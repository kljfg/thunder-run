/**
 * @tr/telemetry —— 遥测与日志框架（S16b，契约 docs/telemetry-spec.md + 本包 types.ts）。
 * 纯逻辑包（与 core 同级纪律）：console/sendBeacon/宿主全局一律经 TelemetrySink / WxTelemetryApi
 * 注入。消费入口速查：
 * - 管线：createTelemetry / createNoopTelemetry / readTelemetryConfig / TELEMETRY_CONFIG_DEFAULTS
 * - 埋点 SDK：createTelemetrySdk（markBoot/frameTime/memory/configSource/unhandledError…）
 * - S19b perf bench：只 import buckets.js（FRAME_BUCKET_EDGES_MS / percentileFromBuckets）
 * - S18 对齐：digests.js（digestEventLog/digestInputs/configHashFromShaList/runEndFields）+ canonical.js
 * - web sink：packages/platform-web/src/telemetryChannel.ts（不在本包，平台边界纪律）
 * - wx 通道类：wxChannel.js（结构化注入宿主 API；platform-wx 注册 TODO 见该文件头）
 */
export * from './types.js';
export {
  canonicalJson, fnv1a32, randomHex, sampleAccepts, sha256Hex, truncateUtf8, utf8Bytes, utf8Length,
} from './canonical.js';
export {
  FRAME_BUCKET_COUNT, FRAME_BUCKET_EDGES_MS, FRAME_OVERFLOW_CAP_MS, LONG_FRAME_MS,
  accumulateFrameBucket, bucketIndexOf, newFrameBuckets, percentileFromBuckets, percentileNearestRank,
} from './buckets.js';
export { createFrameDistTracker, frameDistFields } from './frameDist.js';
export type { FrameDistTracker } from './frameDist.js';
export { TELEMETRY_CONFIG_DEFAULTS, readTelemetryConfig } from './config.js';
export type { TelemetryConfigWarn } from './config.js';
export { MAX_MESSAGE_BYTES, fingerprintOf, reasonTypeOf, serializeError } from './errorSerialize.js';
export { createEnvelopeBuilder, errorLevelOf, mergeFields, mergeTags, resolveSessionId } from './envelope.js';
export type { EnvelopeParts, MutableEnvelope } from './envelope.js';
export { RATE_WINDOW_MS, createRateLimiter } from './limiter.js';
export type { RateLimiter } from './limiter.js';
export { QUEUE_BATCH_CAP, RECENT_RING_SIZE, RETRY_DELAY_MS, createTelemetry } from './pipeline.js';
export { createNoopTelemetry } from './noop.js';
export {
  anticheatRejectFields, configHashBundle, configHashFromShaList, configLoadSummaryFields,
  digestEventLog, digestInputs, runEndFields,
} from './digests.js';
export { createTelemetrySdk } from './sdk.js';
export type { TelemetrySdk, TelemetrySdkOptions } from './sdk.js';
export {
  assembleWxSinks, createCloudDbSink, createRealtimeLogSink, formatRealtimeLine, installWxErrorCapture,
} from './wxChannel.js';
export type {
  WxCloudInvoke, WxErrorRes, WxRealtimeLogManagerLike, WxRejectionRes, WxTelemetryApi, WxTelemetryAssembly,
} from './wxChannel.js';
