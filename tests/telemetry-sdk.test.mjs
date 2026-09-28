/**
 * 埋点 SDK 面测试（S16b 任务 4：markBoot/frameTime/memory/configSource/unhandledError，
 * 事件语义对齐 spec §4）+ S18 形状复用（runEnd/anticheatReject）+ noop 兜底安全性。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelemetry, createNoopTelemetry, createTelemetrySdk, TELEMETRY_CONFIG_DEFAULTS, FRAME_BUCKET_COUNT } from '../packages/telemetry/dist/index.js';

const tick = () => new Promise(r => setTimeout(r, 5));

function makeHost(startMs = 0) {
  const store = new Map();
  let t = startMs;
  return {
    now: () => t,
    advance(ms) { t += ms; },
    storage: { get: k => store.get(k) ?? null, set: (k, v) => store.set(k, v), remove: k => store.delete(k) },
  };
}

function spySink() {
  return {
    id: 'spy', sent: [],
    send(batch) { this.sent.push(batch.map(e => structuredClone(e))); },
    get events() { return this.sent.flat(); },
  };
}

function setup(over = {}) {
  const host = makeHost();
  const sink = spySink();
  const c = structuredClone(TELEMETRY_CONFIG_DEFAULTS);
  Object.assign(c, over);
  const telemetry = createTelemetry(host, c, [sink]);
  const sdk = createTelemetrySdk(telemetry, { now: () => host.now(), t0: 0, navOffsetMs: 7 });
  return { host, sink, telemetry, sdk };
}

test('markBoot：逐阶段 boot.phase（timer + phase/ms fields）；interactive 派生 total 并发 boot.summary（每 boot 1 条）', async () => {
  const { host, sink, sdk, telemetry } = setup();
  host.advance(10);
  sdk.markBoot('entry');                       // ms = now()-T0 = 10
  sdk.markBoot('modulesReady', 12);            // 显式 ms
  host.advance(40);
  sdk.markBoot('adapterInit');                 // 50
  sdk.markBoot('configStart', 51);
  sdk.markBoot('configDone', 80);
  sdk.markBoot('firstFrame', 90);
  host.advance(50);
  sdk.markBoot('interactive');                 // now=100 → total=100 派生 + summary
  sdk.markBoot('interactive');                 // 重复标记：summary 不再发
  await telemetry.flush();
  const phases = sink.events.filter(e => e.name === 'boot.phase');
  assert.equal(phases.length, 8); // entry/modulesReady/adapterInit/configStart/configDone/firstFrame/interactive/total
  assert.ok(phases.every(e => e.ch === 'metric' && e.kind === 'timer'));
  const entry = phases.find(e => e.fields.phase === 'entry');
  assert.equal(entry.val, 10);
  assert.equal(entry.fields.ms, 10);
  const total = phases.find(e => e.fields.phase === 'total');
  assert.equal(total.val, 100);
  const summary = sink.events.filter(e => e.name === 'boot.summary');
  assert.equal(summary.length, 1);
  assert.equal(summary[0].level, 'info');
  assert.equal(summary[0].fields.entry, 10);
  assert.equal(summary[0].fields.modulesReady, 12);
  assert.equal(summary[0].fields.total, 100);
  assert.equal(summary[0].fields.navOffsetMs, 7);
});

test('frameTime + emitFrameDist：逐帧入桶零事件；histogram val=桶数组；缺省清零、reset:false 保留', async () => {
  const { sink, sdk, telemetry } = setup();
  for (let i = 0; i < 60; i++) sdk.frameTime(16.7);
  sdk.frameTime(120); // 长帧
  assert.equal(sink.events.length, 0); // 采集期零事件
  assert.equal(sdk.frameDist.frames(), 61);
  sdk.emitFrameDist('run', { runId: 'r1' });
  await telemetry.flush();
  const ev = sink.events.find(e => e.name === 'perf.frameDist');
  assert.equal(ev.ch, 'metric');
  assert.equal(ev.kind, 'histogram');
  assert.equal(ev.val.length, FRAME_BUCKET_COUNT);
  assert.equal(ev.fields.runId, 'r1');
  assert.equal(ev.fields.scene, 'run');
  assert.equal(ev.fields.frames, 61);
  assert.equal(ev.fields.longCount, 1);
  assert.equal(ev.fields.worstMs, 120);
  assert.equal(ev.fields.buckets, undefined); // 桶走 val，fields 只收标量
  assert.equal(sdk.frameDist.frames(), 0); // 缺省清零
  // cumulative 快照不清零
  sdk.frameTime(20); sdk.frameTime(300);
  sdk.emitFrameDist('run', { runId: 'r1', cumulative: true, reset: false });
  await telemetry.flush();
  const cum = sink.events.filter(e => e.name === 'perf.frameDist').pop();
  assert.equal(cum.fields.cumulative, true);
  assert.equal(cum.fields.p95Approx, true); // 300ms 落 ∞ 桶
  assert.equal(sdk.frameDist.frames(), 2);
});

test('memory：字节入 MB 出（gauge + fields/src）；null → unavailable 哨兵；高水位跟踪', async () => {
  const { sink, sdk, telemetry } = setup();
  sdk.memory(100 * 1048576, { totalBytes: 200 * 1048576, limitBytes: 400 * 1048576, src: 'performance.memory' });
  sdk.memory(150 * 1048576);
  assert.equal(sdk.maxUsedMB(), 150);
  sdk.memory(null, { src: 'unavailable' });
  await telemetry.flush();
  const mems = sink.events.filter(e => e.name === 'perf.memory');
  assert.equal(mems.length, 3);
  assert.equal(mems[0].kind, 'gauge');
  assert.equal(mems[0].val, 100);
  assert.equal(mems[0].fields.usedMB, 100);
  assert.equal(mems[0].fields.totalMB, 200);
  assert.equal(mems[0].fields.limitMB, 400);
  assert.equal(mems[0].fields.src, 'performance.memory');
  assert.equal(mems[1].fields.src, 'performance.memory'); // 缺省来源
  assert.equal(mems[2].val, -1);                          // unavailable 哨兵
  assert.equal(mems[2].fields.usedMB, null);
  assert.equal(mems[2].fields.src, 'unavailable');
  sdk.resetMemory();
  assert.equal(sdk.maxUsedMB(), 0);
});

test('memWarn：log/warn + now 优先级（立即成批，绕采样由管线豁免）', async () => {
  const { sink, sdk } = setup();
  sdk.memWarn(10);
  await tick(); // now → 同 tick 触发 flush，无需手动
  const ev = sink.events.find(e => e.name === 'perf.memWarn');
  assert.equal(ev.ch, 'log');
  assert.equal(ev.level, 'warn');
  assert.equal(ev.fields.level, 10);
});

test('configSource / configSummary：spec §4.4 字段形状', async () => {
  const { sink, sdk, telemetry } = setup();
  sdk.configSource({ file: 'game', source: 'cache', ms: 3, bytes: 1234, fallbackCode: 'F2' });
  sdk.configSource({ file: 'items', source: 'network', ms: 30 });
  sdk.configSummary({ countsBySource: { cache: 1, network: 1 }, manifestSource: 'none', contentVersion: 3 });
  await telemetry.flush();
  const loads = sink.events.filter(e => e.name === 'config.load');
  assert.equal(loads.length, 2);
  assert.equal(loads[0].fields.file, 'game');
  assert.equal(loads[0].fields.source, 'cache');
  assert.equal(loads[0].fields.fallbackCode, 'F2');
  assert.equal(loads[1].fields.fallbackCode, undefined); // 正常路径无此字段
  const sum = sink.events.find(e => e.name === 'config.loadSummary');
  assert.equal(sum.fields.hitRateCache, 50);
  assert.equal(sum.fields.failedCount, 0);
  assert.equal(sum.fields.manifestSource, 'none');
  assert.equal(sum.fields.contentVersion, 3);
});

test('unhandledError：error 通道 now 优先级、缺省 crash.uncaught、可指定事件名', async () => {
  const { sink, sdk } = setup();
  sdk.unhandledError(new Error('top boom'));
  sdk.unhandledError('rejection text', { page: 'menu' }, 'crash.rejection');
  await tick();
  const c1 = sink.events.find(e => e.name === 'crash.uncaught');
  assert.equal(c1.ch, 'error');
  assert.equal(c1.level, 'fatal');
  assert.equal(c1.fields.message, 'top boom');
  const c2 = sink.events.find(e => e.name === 'crash.rejection');
  assert.equal(c2.fields.message, 'rejection text');
  assert.equal(c2.fields.page, 'menu');
});

test('runStart / runEnd（S18 同源摘要）/ anticheatReject / bootStart / debugProbe', async () => {
  const { sink, sdk, telemetry } = setup();
  sdk.bootStart({ launchMode: 'web' });
  sdk.runStart({ runId: 'r1', seed: 777, charId: 'char_volt' });
  sdk.runEnd({
    runId: 'r1', seed: 777, charId: 'char_volt', frames: 600,
    summary: { t: 10, distance: 100, coins: 5, nearMiss: 1, hits: 1, score: 1000, alive: false, casts: 0, charId: 'char_volt' },
    eventCounts: { coin: 5, hit: 1 },
    eventsSha256: 'e'.repeat(64), inputsSha256: 'i'.repeat(64),
    engineVersion: '0.1.0', configHash: 'bundle:1.0.0',
    frameDist: { frames: 600, buckets: new Array(FRAME_BUCKET_COUNT).fill(0), p50Ms: 16.7, p95Ms: 21, longCount: 0, worstMs: 30 },
    maxUsedMB: 123.4, revives: 1,
  });
  sdk.anticheatReject({ reason: 'replay-mismatch', score: 999, eventsSha256: 'e2', inputsSha256: 'i2' });
  sdk.debugProbe({ score: 10 });
  await telemetry.flush();
  const boot = sink.events.find(e => e.name === 'session.boot');
  assert.equal(boot.fields.phase, 'start');
  assert.equal(boot.fields.launchMode, 'web');
  const rs = sink.events.find(e => e.name === 'run.start');
  assert.equal(rs.fields.seed, 777);
  const re = sink.events.find(e => e.name === 'run.end');
  assert.equal(re.fields.eventsSha256, 'e'.repeat(64));
  assert.equal(re.fields.maxUsedMB, 123.4);
  assert.deepEqual(JSON.parse(re.fields.summary).score, 1000);
  assert.equal(JSON.parse(re.fields.frameDist).p95Ms, 21);
  const ar = sink.events.find(e => e.name === 'anticheat.reject');
  assert.equal(ar.level, 'warn');
  assert.equal(ar.fields.reason, 'replay-mismatch');
  const dp = sink.events.find(e => e.name === 'debug.probe');
  assert.equal(dp, undefined); // 缺省采样 0% → 不发（config sampleRates['debug.probe']=0）
});

test('SDK 对 noop Telemetry 全接口安全（零副作用、零异常）', async () => {
  const noop = createNoopTelemetry();
  const host = makeHost();
  const sdk = createTelemetrySdk(noop, { now: () => host.now(), t0: 0 });
  sdk.bootStart();
  sdk.markBoot('entry');
  sdk.markBoot('interactive');
  sdk.frameTime(16);
  sdk.emitFrameDist('menu');
  sdk.memory(1024);
  sdk.memory(null);
  sdk.memWarn(5);
  sdk.configSource({ file: 'game', source: 'cache', ms: 1 });
  sdk.configSummary({ countsBySource: {}, manifestSource: 'none' });
  sdk.unhandledError(new Error('x'));
  sdk.runStart({ runId: 'r', seed: 1, charId: 'c' });
  sdk.debugProbe({ a: 1 });
  assert.equal(sdk.maxUsedMB(), 0); // 1024 字节 → 0.00 MB（两位圆整）；高水位是 SDK 本地状态，与 noop 无关
  assert.equal(noop.recent(10).length, 0);
  await sdk.telemetry.flush();
});
