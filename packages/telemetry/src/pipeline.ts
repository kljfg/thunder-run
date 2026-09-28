/**
 * 主管线（spec §3「三通道一条管线」）：级别过滤 → 采样 → 限流/去重 → 批队列 → 触发 flush → sink。
 * 纯逻辑：时钟/存储/可见性经 TelemetryHost 注入，传输经 TelemetrySink 注入（D1）。
 * fire-and-forget、至多一次：同步调用、不向业务抛异常、失败重试 1 次后丢弃并计 dropped（D12）。
 */
import type {
  DropReason, EmitOptions, Fields, Scalar, Telemetry, TelemetryCommonDimensions, TelemetryConfig,
  TelemetryEnvelope, TelemetryHost, TelemetrySink, Unsubscribe,
} from './types.js';
import { ENVELOPE_VERSION, LOG_LEVEL_ORDER } from './types.js';
import { canonicalJson, randomHex, sampleAccepts, utf8Length } from './canonical.js';
import { createRateLimiter } from './limiter.js';
import { fingerprintOf, serializeError } from './errorSerialize.js';
import { createNoopTelemetry } from './noop.js';
import { createEnvelopeBuilder, errorLevelOf, mergeFields, resolveSessionId } from './envelope.js';
import type { MutableEnvelope } from './envelope.js';

/** 每批失败后的重试间隔（spec §3.4 固定 2s）。 */
export const RETRY_DELAY_MS = 2000;
/** recent(n) 环缓冲容量（?debug 探针数据源，spec §4.6）。 */
export const RECENT_RING_SIZE = 256;
/** 队列上限 = 3 个批次（spec §3.4）。 */
export const QUEUE_BATCH_CAP = 3;
/** 100% 采样且绕过按名采样的事件（spec §4.3/§4.7）。 */
const SAMPLING_EXEMPT = new Set(['session.boot', 'perf.memWarn']);
/** 限流豁免（spec §4.7；error 通道与 telemetry.* 自监控走各自路径，不经此表）。 */
const RATE_EXEMPT = new Set(['session.boot', 'perf.memWarn']);

interface QueuedEvent {
  env: MutableEnvelope;
  bytes: number;
  priority: 'normal' | 'now';
  /** telemetry.dropped/flush：不触发 flush，只随批带出（防自激循环）。 */
  selfMon: boolean;
  dropKey?: { reason: DropReason; name?: string };
  fpKey?: string;
}

interface FpState { start: number; count: number; snapshotQueued: boolean; live: MutableEnvelope | null }
const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

/** 主管线工厂：sid/bootId 生成与持久化、信封组装、限流批处理都在内部（draft §8）。 */
export function createTelemetry(
  host: TelemetryHost, cfg: TelemetryConfig, sinks: readonly TelemetrySink[],
  common?: TelemetryCommonDimensions,
): Telemetry {
  const sinkList = [...sinks];
  const sid = resolveSessionId(host.storage);
  const bootId = randomHex(12);
  const nowMs = () => host.now();

  if (!cfg.enabled) {
    // D13：关闭也发一条 dropped{disabled} 作确认（count=0 表示不逐条计数），随后交给 noop（零开销）。
    const env: TelemetryEnvelope = {
      v: ENVELOPE_VERSION, ch: 'log', ts: nowMs(), epochMs: Date.now(), seq: 1, bootId, sid,
      name: 'telemetry.dropped', level: 'warn', fields: { reason: 'disabled', count: 0 },
    };
    for (const s of sinkList) { // sink 异常不冒泡（遥测永不向业务抛异常）
      try { s.init?.({ bootId, sid }); s.mirror?.(env); void Promise.resolve(s.send([env])).catch(() => {}); } catch { /* 忽略 */ }
    }
    return createNoopTelemetry();
  }

  for (const s of sinkList) { try { s.init?.({ bootId, sid }); } catch { /* 同上 */ } }

  const limiter = createRateLimiter(cfg.rateLimit.perNamePerMin, cfg.rateLimit.maxBytesPerMin);
  const queue: QueuedEvent[] = [];
  const ring: MutableEnvelope[] = [];
  const fpState = new Map<string, FpState>();
  let seq = 0, queuedBytes = 0, destroyed = false, flushInFlight = false, flushAgain = false;
  let flushWaiters: (() => void)[] = [];
  let delayTimer: ReturnType<typeof setTimeout> | undefined;

  const offVisibility: Unsubscribe | undefined = cfg.batch.flushOnHide && host.onVisibility
    ? host.onVisibility(hidden => { if (hidden) void flushAll(); })
    : undefined;

  function armDelayTimer(): void {
    if (delayTimer !== undefined || cfg.batch.maxDelayMs <= 0) return;
    delayTimer = setTimeout(() => { delayTimer = undefined; void flushAll(); }, cfg.batch.maxDelayMs);
    (delayTimer as unknown as { unref?(): void }).unref?.(); // node 测试进程不被挂住；浏览器/wx 无 unref 亦无副作用
  }
  function clearDelayTimer(): void {
    if (delayTimer !== undefined) { clearTimeout(delayTimer); delayTimer = undefined; }
  }

  const buildEnvelope = createEnvelopeBuilder({ now: nowMs, bootId, sid, common });

  function countDrop(reason: DropReason, name: string | undefined, count: number): void {
    if (destroyed) return;
    const fields = limiter.recordDrop(reason, name, count, nowMs());
    if (!fields) return; // 本窗口已有在队/已发 dropped，计数已并入（每窗口 ≤1 条，spec §3.3）
    const env = buildEnvelope('log', 'telemetry.dropped', { level: 'warn', fields });
    // attach 用信封内的最终 fields 对象（mergeFields 会拷贝）：后续同窗丢弃才能就地更新 count
    limiter.attachLive(reason, name, env.fields as unknown as { count: number });
    enqueue(env, { priority: 'normal', selfMon: true, dropKey: { reason, name } });
  }

  function detachQueued(item: QueuedEvent): void {
    if (item.dropKey) limiter.detachLive(item.dropKey.reason, item.dropKey.name);
    if (item.fpKey) { const fp = fpState.get(item.fpKey); if (fp?.live === item.env) fp.live = null; }
  }

  function enqueue(env: MutableEnvelope, opts: { priority?: 'normal' | 'now'; selfMon?: boolean; dropKey?: QueuedEvent['dropKey']; fpKey?: string }): void {
    if (destroyed) return;
    env.seq = ++seq; // seq 在全部过滤之后分配：空洞只来自 overflow/transport（断流检测语义纯净）
    const bytes = utf8Length(canonicalJson(env));
    const item: QueuedEvent = { env, bytes, priority: opts.priority ?? 'normal', selfMon: !!opts.selfMon, dropKey: opts.dropKey, fpKey: opts.fpKey };
    ring.push(env);
    if (ring.length > RECENT_RING_SIZE) ring.shift();
    for (const s of sinkList) { try { s.mirror?.(env); } catch { /* mirror 异常不冒泡 */ } }
    // 溢出丢最老 normal（selfMon 小且有窗口去重上界，允许短暂越限，不触发级联丢弃；now 批不可丢，spec §3.4）
    if (!item.selfMon && queue.length + 1 > QUEUE_BATCH_CAP * cfg.batch.maxEvents) {
      const idx = queue.findIndex(q => q.priority === 'normal');
      if (idx >= 0) {
        const [dropped] = queue.splice(idx, 1);
        queuedBytes -= dropped.bytes;
        detachQueued(dropped);
        countDrop('overflow', dropped.env.name, 1);
      }
    }
    queue.push(item);
    queuedBytes += bytes;
    if (item.priority === 'now') { void flushAll(); return; } // crash：立即成批（同 tick 内 sink.send 已被调用）
    if (item.selfMon) return; // 自监控只随批带出，不自触发
    if (queue.length >= cfg.batch.maxEvents || queuedBytes >= cfg.batch.maxBytesPerFlush) { void flushAll(); return; }
    armDelayTimer();
  }

  function gateAndEnqueue(env: MutableEnvelope, priority: 'normal' | 'now', budgetExempt: boolean): void {
    if (!budgetExempt) {
      const bytes = utf8Length(canonicalJson(env));
      if (!limiter.allowBytes(bytes, nowMs())) { countDrop('bytes', env.name, 1); return; }
    }
    enqueue(env, { priority });
  }

  /**
   * 从队首取一批（≤maxEvents 且 ≤maxBytesPerFlush）。allowSelfMonOnly=false 时，
   * 若整批只有自监控事件则不出队（返回 null，留给下一次真实触发——防 flush 事件自激循环，
   * 且绝不「取走又不发」丢事件）。
   */
  function takeChunk(allowSelfMonOnly: boolean): { envs: TelemetryEnvelope[]; bytes: number } | null {
    const picked: QueuedEvent[] = [];
    let bytes = 0, allSelfMon = true;
    for (const item of queue) {
      if (picked.length >= cfg.batch.maxEvents) break;
      if (picked.length > 0 && bytes + item.bytes > cfg.batch.maxBytesPerFlush) break;
      picked.push(item);
      bytes += item.bytes;
      if (!item.selfMon) allSelfMon = false;
    }
    if (picked.length === 0) return null;
    if (allSelfMon && !allowSelfMonOnly) return null;
    queue.splice(0, picked.length);
    for (const item of picked) detachQueued(item);
    queuedBytes -= bytes;
    return { envs: picked.map(p => p.env), bytes };
  }

  async function sendBatch(envs: readonly TelemetryEnvelope[], bytes: number): Promise<boolean> {
    const t0 = nowMs();
    let ok = false, retry = 0;
    for (let attempt = 0; attempt <= cfg.batch.retry; attempt++) {
      if (attempt > 0) { retry = attempt; await sleep(RETRY_DELAY_MS); }
      try {
        const results = await Promise.all(sinkList.map(s => Promise.resolve(s.send(envs))));
        ok = results.every(r => r !== false);
      } catch { ok = false; }
      if (ok) break;
    }
    if (!ok) countDrop('transport', undefined, envs.length);
    // flush 自监控（timer+counter 合并形态，spec §3.4）：selfMon，只随下一批带出
    const env = buildEnvelope('metric', 'telemetry.flush', {
      kind: 'timer', val: nowMs() - t0, fields: { ok, events: envs.length, bytes, retry },
    });
    enqueue(env, { selfMon: true });
    return ok;
  }

  async function flushAll(): Promise<void> {
    if (flushInFlight) {
      // 已有刷写在跑：登记等待者并请求续跑（flushAgain）——公共 flush() 的语义是
      // 「调用时已入队的事件都已尝试发出」，不能提前 resolve（否则调用方竞态读不到 sink）
      flushAgain = true;
      await new Promise<void>(resolve => { flushWaiters.push(resolve); });
      return;
    }
    flushInFlight = true;
    try {
      let first = true;
      while (queue.length > 0) {
        const chunk = takeChunk(first);
        if (!chunk) break;
        first = false;
        const ok = await sendBatch(chunk.envs, chunk.bytes);
        if (!ok) break; // 传输失败：本轮停止，余量等下一次触发（重试已由 sendBatch 做过）
      }
    } finally {
      flushInFlight = false;
      const waiters = flushWaiters;
      flushWaiters = [];
      if (destroyed) clearDelayTimer();
      else if (queue.some(q => !q.selfMon)) armDelayTimer(); // 只剩自监控尾巴不再武装定时器（防周期性空刷自激）
      else clearDelayTimer();
      if (flushAgain) {
        flushAgain = false;
        void flushAll().then(() => { for (const w of waiters) w(); }); // 等待者到续跑完成才 resolve
      } else {
        for (const w of waiters) w();
      }
    }
  }

  function emitError(err: unknown, context?: Fields, opts?: EmitOptions, scopeFields?: Fields): void {
    if (destroyed || cfg.error.sample === 0) return; // 应急总开关（spec §3.2/D4）
    const name = opts?.name ?? 'crash.uncaught';
    const priority = opts?.priority ?? 'now'; // crash 缺省 now：可能就该 boot 最后一条（spec §4.5/D14）
    const serialized: Fields = {};
    for (const [k, v] of Object.entries(serializeError(err, cfg.error.maxStackBytes))) {
      if (v !== undefined) serialized[k] = v as Scalar;
    }
    // 后层覆盖前层：context 显式字段（ErrorEvent 的 file/line/col 比栈解析更准）优先；指纹按最终值重算
    const fields = mergeFields([common?.fields, scopeFields, serialized, context])!;
    const fingerprint = fingerprintOf(String(fields.message ?? ''), typeof fields.stack === 'string' ? fields.stack : undefined, 'error', name);
    fields.fingerprint = fingerprint;
    const now = nowMs();
    let fp = fpState.get(fingerprint);
    if (fp && now - fp.start < cfg.error.dedupWindowMs) {
      fp.count++;
      if (fp.live) { fp.live.fields = { ...(fp.live.fields ?? {}), dupCount: fp.count }; return; } // 更新同一条
      if (fp.snapshotQueued) return; // 快照已发出：本窗口后续重复仅本地计数（至多一次）
      fp.snapshotQueued = true;
      const snap = buildEnvelope('error', name, { level: errorLevelOf(name), fields: { ...fields, dupCount: fp.count } });
      fp.live = snap;
      enqueue(snap, { priority: 'normal', fpKey: fingerprint }); // 批末快照重发（spec §3.3 二选一之「快照」）
      return;
    }
    if (fpState.size > 256) { // 防指纹表无限增长：清掉过期窗
      for (const [k, v] of fpState) if (now - v.start >= cfg.error.dedupWindowMs) fpState.delete(k);
    }
    fp = { start: now, count: 0, snapshotQueued: false, live: null };
    fpState.set(fingerprint, fp);
    const env = buildEnvelope('error', name, { level: errorLevelOf(name), fields });
    fp.live = env;
    enqueue(env, { priority, fpKey: fingerprint }); // error 通道：无级别过滤/采样/限流，只指纹去重（spec §3.1/§3.3）
  }

  function makeHandle(scopeFields?: Fields): Telemetry {
    const self: Telemetry = {
      log(level, name, fields, opts) {
        if (destroyed) return;
        if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[cfg.minLevel]) return; // 级别过滤在采样前，不计 dropped（spec §3.1）
        const exempt = SAMPLING_EXEMPT.has(name);
        if (!exempt) {
          const rate = cfg.sampleRates[name] ?? cfg.sampleRates.default;
          if (!sampleAccepts(sid, name, rate)) return; // 采样丢弃静默：稳定哈希可在服务端重算（D3）
        }
        if (!RATE_EXEMPT.has(name) && !limiter.allowName(name, nowMs())) { countDrop('rate', name, 1); return; }
        const env = buildEnvelope('log', name, { level, fields }, scopeFields);
        gateAndEnqueue(env, opts?.priority ?? 'normal', exempt);
      },
      metric(name, kind, val, tags, opts) {
        if (destroyed) return;
        const rate = cfg.sampleRates[name] ?? cfg.sampleRates.default;
        if (!sampleAccepts(sid, name, rate)) return;
        if (!limiter.allowName(name, nowMs())) { countDrop('rate', name, 1); return; }
        const env = buildEnvelope('metric', name, {
          kind, val: typeof val === 'number' ? val : Array.from(val), tags,
        }, scopeFields);
        gateAndEnqueue(env, opts?.priority ?? 'normal', false);
      },
      error(err, context, opts) { emitError(err, context, opts, scopeFields); },
      withScope(scope) { return makeHandle(mergeFields([scopeFields, scope])); },
      async measure(name, fn) {
        const t0 = nowMs();
        try {
          const result = await fn();
          self.metric(name, 'timer', nowMs() - t0);
          return result;
        } catch (err) {
          self.metric(name, 'timer', nowMs() - t0);
          throw err;
        }
      },
      flush: () => flushAll(),
      destroy() {
        if (destroyed) return;
        destroyed = true;
        clearDelayTimer();
        offVisibility?.();
        void flushAll(); // 尽力而为的收尾刷写（sendBeacon 类同步 sink 在同 tick 已发出）
      },
      recent(n) { return ring.slice(Math.max(0, ring.length - n)); },
    };
    return self;
  }

  return makeHandle();
}
