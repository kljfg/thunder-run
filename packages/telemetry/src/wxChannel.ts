/**
 * wx 通道类（spec §7/D10，S16b 任务 2）：实时日志镜像 + 云上报队列 + crash 捕获。
 *
 * 落位说明（偏差清单 #5）：规格 §9 把 wx sink 工厂放 packages/platform-wx；本波次 S6 并行锁定
 * 该包 → 类落在本包并以「结构化注入宿主 API」实现（WxTelemetryApi 接口，本文件零处触碰宿主
 * 全局，纯逻辑纪律与可 node 直测性都保住）。platform-wx 侧只需一层薄注册把真宿主对象递进来：
 *
 * TODO(S6 合入后 · 整合会话执行)：packages/platform-wx 新增 src/telemetry.ts——
 *   1) import { assembleWxSinks, installWxErrorCapture } from '@tr/telemetry/wxChannel.js'
 *      与 { createTelemetry } from '@tr/telemetry/pipeline.js'、{ readTelemetryConfig } from '@tr/telemetry/config.js'；
 *   2) 宿主 API 对象 = 全局 wx 本身（结构满足 WxTelemetryApi：getRealtimeLogManager/onError/
 *      onUnhandledRejection/offError/offUnhandledRejection；缺项自动降级）；
 *   3) cfg = readTelemetryConfig(game.json params)（config 经 extras.readJson 分包内读，S6 已通）；
 *   4) cloudInvoke = extras.cloud.callFunction（S9 云环境未就绪时 callFunction reject →
 *      createCloudDbSink 走 degraded 或 invoke 传 undefined → realtime-only，spec §7）；
 *   5) createTelemetry(adapter, cfg, assembleWxSinks(...).sinks, common) 后
 *      installWxErrorCapture(api, telemetry)；bootId 过滤词经 sink.init 自动 setFilterMsg；
 *   6) onHide flush 不用单独接：adapter.onVisibility(hidden) 已由管线订阅（flushOnHide）；
 *   7) transport.mirrorOfficial=true 时 wx.reportPerformance 镜像 boot.total（官方报表交叉校验，
 *      指标 id 需在 MP 后台先建——接线时补）。
 *   注册文件落位后：本文件保持纯逻辑不动，或在整合会话把类迁入 platform-wx（届时同步禁碰矩阵）。
 */
import type { Fields, Telemetry, TelemetryEnvelope, TelemetrySink, TelemetrySinkInfo, Unsubscribe } from './types.js';
import { truncateUtf8 } from './canonical.js';

// ---------- 宿主 API 的结构化描述（platform-wx 注册时把真 wx 全局赋进来即可） ----------

/** RealtimeLogManager 的结构子集（文档面：error/warn/info/setFilterMsg/addFilterMsg，spec §11 已核）。 */
export interface WxRealtimeLogManagerLike {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  setFilterMsg(msg: string): void;
  addFilterMsg?(msg: string): void;
}

/** 应用级错误事件（onError res：message+stack；onUnhandledRejection res：reason）。 */
export interface WxErrorRes { message?: string; stack?: string }
export interface WxRejectionRes { reason: unknown }

export interface WxTelemetryApi {
  getRealtimeLogManager?(): WxRealtimeLogManagerLike;
  onError?(cb: (res: WxErrorRes) => void): void;
  offError?(cb: (res: WxErrorRes) => void): void;
  onUnhandledRejection?(cb: (res: WxRejectionRes) => void): void;
  offUnhandledRejection?(cb: (res: WxRejectionRes) => void): void;
}

/** 云函数调用适配（= extras.cloud.callFunction 的签名，S10 CloudBridge）。 */
export type WxCloudInvoke = (name: string, payload: unknown) => Promise<unknown>;

// ---------- 实时日志镜像 sink（spec §7：单行摘要 name|k=v，不是全量信封） ----------

/** 关键 log 事件镜像白名单（warn 及以上恒镜像；metric 常规不镜像——平台频控，D10）。 */
const REALTIME_KEY_LOGS = new Set(['boot.summary', 'config.loadSummary', 'session.boot', 'run.end', 'anticheat.reject']);
/** 单行摘要长度上限（实时日志平台侧有截断，先自截留余量）。 */
const REALTIME_LINE_MAX = 180;
/** 摘要携带的关键字段数上限（spec §7：3~5 个）。 */
const REALTIME_FIELD_MAX = 4;
/** 单字段值长度上限（canonicalJson 串等长值先截）。 */
const REALTIME_VALUE_MAX = 40;

/** 信封 → 单行摘要 `name|k=v|k=v…`（字段取 fields 插入序前 N 个——打点侧按重要性排列）。 */
export function formatRealtimeLine(env: TelemetryEnvelope): string {
  const parts: string[] = [env.name];
  const fields: Fields = env.fields ?? {};
  let n = 0;
  for (const key of Object.keys(fields)) {
    if (n >= REALTIME_FIELD_MAX) break;
    let v = String(fields[key]).replace(/[\r\n]+/g, ' '); // 单行摘要：换行压平（stack 等）
    if (v.length > REALTIME_VALUE_MAX) v = v.slice(0, REALTIME_VALUE_MAX) + '…';
    parts.push(`${key}=${v}`);
    n++;
  }
  return truncateUtf8(parts.join('|'), REALTIME_LINE_MAX);
}

/**
 * RealtimeLogManager 镜像 sink：mirror 同步写（手机上立即可查、不依赖网络落库），
 * send 恒成功（本通道无传输语义——全量结构化数据在云通道）。api 缺能力 → null（不注册）。
 */
export function createRealtimeLogSink(api: WxTelemetryApi): TelemetrySink | null {
  let mgr: WxRealtimeLogManagerLike | null = null;
  try { mgr = api.getRealtimeLogManager?.() ?? null; } catch { mgr = null; }
  if (!mgr) return null;
  const m = mgr;
  return {
    id: 'wx-realtime',
    send: () => {}, // void = 成功（本通道无传输语义，全量数据在云通道）
    mirror(env) {
      const line = formatRealtimeLine(env);
      // 镜像级别策略（spec §7）：error/fatal 恒镜像；warn 与关键 log 镜像；metric 常规不镜像
      if (env.ch === 'error' || env.level === 'error' || env.level === 'fatal') m.error(line);
      else if (env.level === 'warn') m.warn(line);
      else if (env.ch === 'log' && REALTIME_KEY_LOGS.has(env.name)) m.info(line);
    },
    init(info: TelemetrySinkInfo) {
      // 真机复现后 MP 后台按 bootId 过滤（过滤词有长度上限，用短 bootId，spec §7）
      try { m.setFilterMsg(info.bootId); } catch { /* 平台异常不冒泡 */ }
    },
  };
}

// ---------- 云上报队列 sink（spec §7：云函数代收，批 ≤ maxBytesPerFlush 由管线保证） ----------

/**
 * 云数据库上报（经云函数代收而非直写 DB：权限白名单 + 入库前校验，D10）。
 * invoke 缺省 = 云环境未就绪（S9 前）→ 退化为「realtime-only + 内存批丢弃」：send 吞批恒成功
 * （不触发管线重试/dropped 噪音——退化是预期状态，不是传输失败）。
 */
export function createCloudDbSink(collection: string, invoke?: WxCloudInvoke): TelemetrySink {
  if (!invoke) {
    return {
      id: 'wx-cloud(degraded)',
      send: () => {}, // 丢弃即成功（void）：退化模式无重试语义（spec §7）
    };
  }
  const call = invoke;
  return {
    id: 'wx-cloud',
    async send(batch) {
      try {
        // sid/bootId 冗余到 payload 顶层（信封内也有）：云函数按会话分片/索引方便
        const head = batch[0];
        await call('telemetryIngest', {
          collection,
          sid: head?.sid ?? '',
          bootId: head?.bootId ?? '',
          batch,
        });
        return true;
      } catch {
        return false; // 管线按 batch.retry 重试 1 次后计 dropped{transport}
      }
    },
  };
}

// ---------- crash 捕获（spec §4.5：wx.onError / wx.onUnhandledRejection） ----------

/**
 * 安装 wx 端 crash 捕获 → error 通道（priority now + 指纹去重在管线内建）。
 * 双写镜像不用在这里做：error 信封入队时管线自动调 RealtimeLogManager sink 的 mirror（spec §4.5）。
 * api 缺对应 on* 能力 → 该半边静默不装（基础库版本差异诚实降级）。
 */
export function installWxErrorCapture(api: WxTelemetryApi, telemetry: Telemetry): Unsubscribe {
  const onError = (res: WxErrorRes): void => {
    // res 是 {message,stack} 普通对象：serializeError 走 duck-typing 同 Error 处理
    telemetry.error(res ?? 'onError(empty)', undefined, { priority: 'now', name: 'crash.wxError' });
  };
  const onRejection = (res: WxRejectionRes): void => {
    telemetry.error(res?.reason, undefined, { priority: 'now', name: 'crash.rejection' });
  };
  try { api.onError?.(onError); } catch { /* 装机失败不冒泡 */ }
  try { api.onUnhandledRejection?.(onRejection); } catch { /* 同上 */ }
  return () => {
    try { api.offError?.(onError); } catch { /* 卸载失败不冒泡 */ }
    try { api.offUnhandledRejection?.(onRejection); } catch { /* 同上 */ }
  };
}

// ---------- 装配便捷面（整合会话在 platform-wx 注册文件里一次调齐） ----------

export interface WxTelemetryAssembly {
  sinks: TelemetrySink[];
  /** crash 捕获安装（需在 createTelemetry 之后调用）；返回退订。 */
  installErrorCapture(telemetry: Telemetry): Unsubscribe;
}

/**
 * 按 cfg.transport 组装 wx sinks：wxRealtimeLog → 实时镜像；wxCloudCollection → 云队列
 * （cloudInvoke 未传 = 云未就绪 → degraded）。实时镜像不可用且云退化时返回空 sinks
 * （管线照常运转，只是无处可去——dropped{transport} 不会误报，send 全成功语义）。
 */
export function assembleWxSinks(api: WxTelemetryApi, transport: {
  wxRealtimeLog: boolean; wxCloudCollection: string;
}, cloudInvoke?: WxCloudInvoke): WxTelemetryAssembly {
  const sinks: TelemetrySink[] = [];
  if (transport.wxRealtimeLog) {
    const realtime = createRealtimeLogSink(api);
    if (realtime) sinks.push(realtime);
  }
  if (transport.wxCloudCollection) sinks.push(createCloudDbSink(transport.wxCloudCollection, cloudInvoke));
  return { sinks, installErrorCapture: t => installWxErrorCapture(api, t) };
}
