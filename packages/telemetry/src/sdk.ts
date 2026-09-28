/**
 * 埋点 SDK 面（S16b 任务 4，事件语义逐条对齐 spec §4）：
 *   markBoot(stage)     → boot.phase（metric/timer）+ interactive/total 时 boot.summary（log/info，每 boot 1 条）
 *   frameTime(dt)       → FrameDistTracker 逐帧入桶（零逐帧事件）；emitFrameDist 收尾发 perf.frameDist
 *   memory(bytes)       → perf.memory（metric/gauge）+ 本局高水位跟踪；memWarn(level) 绕采样立即发
 *   configSource(hit)   → config.load（log/info，每文件）；configSummary() → config.loadSummary
 *   unhandledError(err) → error 通道 priority:'now'（crash.*）
 * 另有 run 生命周期便捷面（runStart/runEnd/anticheatReject，payload 形状 = spec §8）。
 * 对 noop Telemetry 调用同样安全（接口面完整、零副作用）。
 */
import type {
  BootPhase, ConfigFileSource, ConfigLoadPayload, Fields, MemWarnPayload, MemoryPayload,
  RunEndPayload, AnticheatRejectPayload, Telemetry, TelemetryEventName,
} from './types.js';
import { createFrameDistTracker, frameDistFields } from './frameDist.js';
import type { FrameDistTracker } from './frameDist.js';
import { anticheatRejectFields, configLoadSummaryFields, runEndFields } from './digests.js';

export interface TelemetrySdkOptions {
  /** 单调钟（= adapter.now，与信封 ts 同基准）。 */
  now: () => number;
  /** 首屏原点 T0（spec §4.1：入口脚本开始执行时刻，now() 同基准）；缺省 = 构造时刻。 */
  t0?: number;
  /** 仅 web：与 navigation start 的偏移（performance.timeOrigin 换算），进 boot.summary。 */
  navOffsetMs?: number;
}

export interface TelemetrySdk {
  /** boot 阶段打点：ms 缺省 = now()-T0；标到 interactive/total 时自动派生 total 并发 boot.summary。 */
  markBoot(stage: BootPhase, ms?: number): void;
  /** 逐帧帧时长入桶（run 主循环 rAF 差分调用；O(1) 零分配）。 */
  frameTime(dtMs: number): void;
  /** 发 perf.frameDist（histogram）并可选清零；触发时机 = run.end / 长局 30s / 菜单每分钟（spec §4.2）。 */
  emitFrameDist(scene: 'run' | 'menu' | 'bench', opts?: { runId?: string; cumulative?: boolean; reset?: boolean }): void;
  /** 帧分布收集器本体（S19b bench 或自定义编排直接操作）。 */
  readonly frameDist: FrameDistTracker;
  /**
   * 内存水位（字节入、MB 出）；extra.src 标注来源（spec §4.3 诚实三档），缺省 performance.memory。
   * usedBytes = null：读不到数据（iOS JS 堆普遍不可读）→ 每 boot 发 1 条 src:'unavailable'
   * （usedMB=null、gauge val=-1 哨兵），不许静默缺失。
   */
  memory(usedBytes: number | null, extra?: { totalBytes?: number; limitBytes?: number; src?: MemoryPayload['src'] }): void;
  /** wx.onMemoryWarning 兜底：立即发 perf.memWarn{level}，绕采样（spec §4.3）。 */
  memWarn(level: MemWarnPayload['level']): void;
  /** 本局内存高水位 MB（run.end 附带；resetMemory 清零）。 */
  maxUsedMB(): number;
  resetMemory(): void;
  /** 单文件配置来源打点（config.load）；hit = ConfigLoadPayload（file/source/ms/…）。 */
  configSource(hit: ConfigLoadPayload): void;
  /** 每 boot 1 条 config.loadSummary（命中率 = 按文件 source 占比，spec §4.4）。 */
  configSummary(input: {
    countsBySource: Readonly<Record<string, number>>;
    manifestSource: 'fresh' | 'cached' | 'none';
    contentVersion?: number;
  }): void;
  /** 未捕获错误/rejection 统一入口（capture 层与业务兜底共用）；缺省事件名 crash.uncaught。 */
  unhandledError(err: unknown, context?: Fields, name?: TelemetryEventName | (string & {})): void;
  /** 每冷启动第一条（session.boot，100% 采样、限流豁免——管线内建，spec §4.7）。 */
  bootStart(fields?: Fields): void;
  runStart(fields: { runId: string; seed: number; charId: string } & Fields): void;
  /** run.end：payload = spec §8 规范形状（含 eventsSha256/inputsSha256/summary 摘要，S18 同源）。 */
  runEnd(payload: RunEndPayload): void;
  anticheatReject(payload: AnticheatRejectPayload): void;
  /** debug.probe 事件（log/trace，缺省采样 0%，spec §4.6）。 */
  debugProbe(fields: Fields): void;
  /** 底层 Telemetry 句柄（逃生舱：直接 log/metric/error/withScope）。 */
  readonly telemetry: Telemetry;
}

export function createTelemetrySdk(telemetry: Telemetry, opts: TelemetrySdkOptions): TelemetrySdk {
  const t0 = opts.t0 ?? opts.now();
  const tracker = createFrameDistTracker();
  const phases = new Map<BootPhase, number>();
  let summarySent = false;
  let maxUsed = 0;
  const mb = (bytes: number) => +(bytes / 1048576).toFixed(2);

  function sendBootSummary(): void {
    if (summarySent) return;
    summarySent = true;
    const fields: Fields = {};
    for (const [phase, ms] of phases) fields[phase] = ms;
    if (opts.navOffsetMs !== undefined) fields.navOffsetMs = opts.navOffsetMs;
    telemetry.log('info', 'boot.summary', fields); // summary 恒 100%（sampleRates 不应配置该名字）
  }

  return {
    markBoot(stage, ms) {
      const value = +(ms ?? (opts.now() - t0)).toFixed(2);
      // 每阶段 1 条：首次标记生效、重复标记忽略（boot.phase 不重发；summary 由 summarySent 守护）
      const mark = (s: BootPhase, v: number): void => {
        if (phases.has(s)) return;
        phases.set(s, v);
        // metric 无 fields 参数（draft 签名不动）：phase/ms 经 withScope 并入信封 fields（spec §4.1）
        telemetry.withScope({ phase: s, ms: v }).metric('boot.phase', 'timer', v);
      };
      mark(stage, value);
      if (stage === 'interactive') mark('total', value); // total = interactive 值，派生不重复打点（spec §4.1）
      if (stage === 'total') mark('interactive', value);
      if (stage === 'interactive' || stage === 'total') sendBootSummary(); // 每 boot 1 条
    },
    frameTime(dtMs) { tracker.add(dtMs); },
    emitFrameDist(scene, o) {
      const payload = tracker.payload(o?.runId ?? '', scene, o?.cumulative);
      // histogram：桶计数走 val，标量维度（runId/scene/p50…）经 withScope 入 fields——单事件不翻倍
      telemetry.withScope(frameDistFields(payload)).metric('perf.frameDist', 'histogram', payload.buckets);
      if (o?.reset !== false) tracker.reset();
    },
    frameDist: tracker,
    memory(usedBytes, extra) {
      if (usedBytes === null) {
        telemetry.withScope({ usedMB: null, src: extra?.src ?? 'unavailable' }).metric('perf.memory', 'gauge', -1);
        return;
      }
      const usedMB = mb(usedBytes);
      if (usedMB > maxUsed) maxUsed = usedMB;
      const fields: Fields = { usedMB, src: extra?.src ?? 'performance.memory' };
      if (extra?.totalBytes !== undefined) fields.totalMB = mb(extra.totalBytes);
      if (extra?.limitBytes !== undefined) fields.limitMB = mb(extra.limitBytes);
      telemetry.withScope(fields).metric('perf.memory', 'gauge', usedMB);
    },
    memWarn(level) {
      // 立即发、绕过采样（管线 SAMPLING_EXEMPT）；now 优先级抢在冻结前出去
      telemetry.log('warn', 'perf.memWarn', { level }, { priority: 'now' });
    },
    maxUsedMB: () => maxUsed,
    resetMemory() { maxUsed = 0; },
    configSource(hit) {
      const fields: Fields = { file: hit.file, source: hit.source, ms: hit.ms };
      if (hit.bytes !== undefined) fields.bytes = hit.bytes;
      if (hit.sha12 !== undefined) fields.sha12 = hit.sha12;
      if (hit.contentVersion !== undefined) fields.contentVersion = hit.contentVersion;
      if (hit.fallbackCode !== undefined) fields.fallbackCode = hit.fallbackCode;
      telemetry.log('info', 'config.load', fields);
    },
    configSummary(input) {
      telemetry.log('info', 'config.loadSummary', configLoadSummaryFields(input));
    },
    unhandledError(err, context, name) {
      telemetry.error(err, context, { priority: 'now', name: name ?? 'crash.uncaught' });
    },
    bootStart(fields) {
      telemetry.log('info', 'session.boot', { phase: 'start', ...fields });
    },
    runStart(fields) {
      telemetry.log('info', 'run.start', fields);
    },
    runEnd(payload) {
      telemetry.log('info', 'run.end', runEndFields(payload));
    },
    anticheatReject(payload) {
      telemetry.log('warn', 'anticheat.reject', anticheatRejectFields(payload));
    },
    debugProbe(fields) {
      telemetry.log('trace', 'debug.probe', fields);
    },
    telemetry,
  };
}

/** 便捷别名：文件来源常量再导出（接线侧少一处 import）。 */
export type { ConfigFileSource };
