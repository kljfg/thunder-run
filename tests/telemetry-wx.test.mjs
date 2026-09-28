/**
 * wx 通道类测试（packages/telemetry/src/wxChannel.ts，spec §7/D10）。
 * 宿主 API 全部结构化注入 mock（与 platform-wx 测试同款纪律，node 直测零真机依赖）。
 * 注册入口（platform-wx 侧薄层）留 TODO——接线点清单见 wxChannel.ts 文件头与 docs/telemetry-wiring.md §4。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleWxSinks, createCloudDbSink, createRealtimeLogSink, formatRealtimeLine, installWxErrorCapture,
} from '../packages/telemetry/dist/wxChannel.js';
import { createTelemetry, TELEMETRY_CONFIG_DEFAULTS } from '../packages/telemetry/dist/index.js';

const tick = () => new Promise(r => setTimeout(r, 5));

function makeMgrMock() {
  return {
    infos: [], warns: [], errors: [], filters: [],
    info(msg) { this.infos.push(msg); },
    warn(msg) { this.warns.push(msg); },
    error(msg) { this.errors.push(msg); },
    setFilterMsg(msg) { this.filters.push(msg); },
  };
}

function makeApiMock(opts = {}) {
  const mgr = opts.noMgr ? undefined : makeMgrMock();
  const errorCbs = [];
  const rejectionCbs = [];
  const removed = { error: 0, rejection: 0 };
  const api = {
    _mgr: mgr, _errorCbs: errorCbs, _rejectionCbs: rejectionCbs, _removed: removed,
    onUnhandledRejection(cb) { rejectionCbs.push(cb); },
    offUnhandledRejection(cb) { const i = rejectionCbs.indexOf(cb); if (i >= 0) { rejectionCbs.splice(i, 1); removed.rejection++; } },
    _fireError(res) { for (const cb of [...errorCbs]) cb(res); },
    _fireRejection(res) { for (const cb of [...rejectionCbs]) cb(res); },
  };
  if (mgr) api.getRealtimeLogManager = () => mgr;
  if (opts.mgrThrows) api.getRealtimeLogManager = () => { throw new Error('基础库不支持'); };
  if (!opts.noErrorApi) {
    api.onError = cb => errorCbs.push(cb);
    api.offError = cb => { const i = errorCbs.indexOf(cb); if (i >= 0) { errorCbs.splice(i, 1); removed.error++; } };
  }
  return api;
}

function makeHost() {
  const store = new Map();
  let t = 1000;
  return {
    now: () => t,
    advance(ms) { t += ms; },
    storage: { get: k => store.get(k) ?? null, set: (k, v) => store.set(k, v), remove: k => store.delete(k) },
  };
}

const cfg = () => structuredClone(TELEMETRY_CONFIG_DEFAULTS);
const envOf = over => ({
  v: 1, ch: 'log', ts: 5, epochMs: 1700000000000, seq: 1,
  bootId: 'b'.repeat(12), sid: 's'.repeat(16), name: 'boot.summary', level: 'info', ...over,
});

// ---------- 单行摘要格式（spec §7：name|k=v，关键 3~5 字段，非全量信封） ----------

test('formatRealtimeLine：name|k=v 单行、字段 ≤4、值 ≤40 字符、总长 ≤180', () => {
  const line = formatRealtimeLine(envOf({ fields: { total: 123, phase: 'x', a: 1, b: 2, c: 3 } }));
  assert.equal(line, 'boot.summary|total=123|phase=x|a=1|b=2'); // 插入序前 4 个字段
  const longVal = formatRealtimeLine(envOf({ fields: { stack: 'S'.repeat(200) } }));
  assert.ok(longVal.length <= 180);
  assert.ok(longVal.includes('…')); // 长值截断
  const noFields = formatRealtimeLine(envOf({ fields: undefined }));
  assert.equal(noFields, 'boot.summary');
  const unicode = formatRealtimeLine(envOf({ fields: { msg: '中文消息'.repeat(30) } }));
  assert.ok([...unicode].length <= 180); // UTF-8 字节截断不切半字符
});

// ---------- RealtimeLogManager 镜像 sink ----------

test('realtime sink：init 设 bootId 过滤词；镜像级别策略（error/fatal 恒镜像、warn 与关键 log、metric 不镜像）', () => {
  const api = makeApiMock();
  const sink = createRealtimeLogSink(api);
  assert.equal(sink.id, 'wx-realtime');
  assert.equal(sink.send([envOf({})]), undefined); // void = 成功（无传输语义）
  sink.init({ bootId: 'abc123', sid: 's' });
  assert.deepEqual(api._mgr.filters, ['abc123']);
  // error 通道 → mgr.error
  sink.mirror(envOf({ ch: 'error', level: 'fatal', name: 'crash.wxError', fields: { message: 'boom' } }));
  assert.equal(api._mgr.errors.length, 1);
  assert.ok(api._mgr.errors[0].startsWith('crash.wxError|'));
  // log/warn → mgr.warn
  sink.mirror(envOf({ level: 'warn', name: 'perf.memWarn', fields: { level: 10 } }));
  assert.equal(api._mgr.warns.length, 1);
  assert.equal(api._mgr.warns[0], 'perf.memWarn|level=10');
  // 关键 log（info）→ mgr.info
  sink.mirror(envOf({ name: 'boot.summary', fields: { total: 900 } }));
  assert.deepEqual(api._mgr.infos, ['boot.summary|total=900']);
  sink.mirror(envOf({ name: 'config.loadSummary' }));
  assert.equal(api._mgr.infos.length, 2);
  // 普通 info log 不镜像；metric 常规不镜像（平台频控，客户端限流先于平台频控）
  sink.mirror(envOf({ name: 'config.load', fields: { file: 'game' } }));
  sink.mirror(envOf({ ch: 'metric', level: undefined, kind: 'counter', name: 'm.x', val: 1 }));
  assert.equal(api._mgr.infos.length, 2);
  assert.equal(api._mgr.warns.length, 1);
});

test('realtime sink：宿主缺 getRealtimeLogManager / 构造抛错 → null（自动不注册，诚实降级）', () => {
  assert.equal(createRealtimeLogSink(makeApiMock({ noMgr: true })), null);
  assert.equal(createRealtimeLogSink(makeApiMock({ mgrThrows: true })), null);
});

// ---------- 云上报队列 sink ----------

test('cloud sink：批经 telemetryIngest 云函数代收（sid/bootId 冗余顶层）；invoke 失败 → false（管线重试）', async () => {
  const calls = [];
  const invoke = async (name, payload) => { calls.push({ name, payload }); return { ok: true }; };
  const sink = createCloudDbSink('telemetry', invoke);
  assert.equal(sink.id, 'wx-cloud');
  const batch = [envOf({}), envOf({ seq: 2, name: 'run.end' })];
  assert.equal(await sink.send(batch), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'telemetryIngest');
  assert.equal(calls[0].payload.collection, 'telemetry');
  assert.equal(calls[0].payload.sid, 's'.repeat(16));
  assert.equal(calls[0].payload.bootId, 'b'.repeat(12));
  assert.deepEqual(calls[0].payload.batch, batch);
  const failing = createCloudDbSink('telemetry', async () => { throw new Error('cloud -501000'); });
  assert.equal(await failing.send(batch), false);
});

test('cloud sink：invoke 缺省（S9 云环境未就绪）→ degraded——吞批恒成功、零调用（realtime-only 退化，spec §7）', async () => {
  const sink = createCloudDbSink('telemetry');
  assert.equal(sink.id, 'wx-cloud(degraded)');
  assert.equal(await sink.send([envOf({})]), undefined); // void = 成功，不触发管线重试/dropped 噪音
});

// ---------- crash 捕获 ----------

test('installWxErrorCapture：onError → crash.wxError（fatal、now）、rejection → crash.rejection；退订生效', async () => {
  const api = makeApiMock();
  const host = makeHost();
  const t = createTelemetry(host, cfg(), []);
  const off = installWxErrorCapture(api, t);
  assert.equal(api._errorCbs.length, 1);
  assert.equal(api._rejectionCbs.length, 1);
  api._fireError({ message: 'wx boom', stack: 'Error: wx boom\n    at foo (game.js:1:2)' });
  await tick(); // priority now → 立即成批
  let crash = t.recent(5).find(e => e.name === 'crash.wxError');
  assert.equal(crash.level, 'fatal');
  assert.equal(crash.fields.message, 'wx boom');
  assert.equal(crash.fields.file, 'game.js');
  assert.equal(crash.fields.line, 1);
  api._fireRejection({ reason: { then: undefined, msg: 'obj reason' } });
  await tick();
  crash = t.recent(5).find(e => e.name === 'crash.rejection');
  assert.ok(crash);
  assert.equal(crash.fields.reasonType, 'object:Object');
  // 退订：off* 回调收到同一函数引用
  off();
  assert.equal(api._removed.error, 1);
  assert.equal(api._removed.rejection, 1);
  const before = t.recent(100).length;
  api._errorCbs.length = 0; api._rejectionCbs.length = 0; // mock 的 off 已移除回调
  api._fireError({ message: 'after off' });
  assert.equal(t.recent(100).length, before);
  t.destroy();
});

test('installWxErrorCapture：宿主缺 on* API（老基础库）→ 静默不装、退订不炸', () => {
  const api = makeApiMock({ noErrorApi: true });
  const t = createTelemetry(makeHost(), cfg(), []);
  const off = installWxErrorCapture(api, t);
  off();
  assert.equal(t.recent(10).length, 0);
  t.destroy();
});

// ---------- 装配面 + 管线端到端 ----------

test('assembleWxSinks：按 transport 配置组装；端到端（mirror 即时、批走云函数、onHide 经管线可见性）', async () => {
  const api = makeApiMock();
  const calls = [];
  const invoke = async (name, payload) => { calls.push(payload); return {}; };
  const c = cfg();
  const asm = assembleWxSinks(api, c.transport, invoke);
  assert.deepEqual(asm.sinks.map(s => s.id), ['wx-realtime', 'wx-cloud']);
  // wxRealtimeLog=false → 只云；wxCloudCollection='' → 只实时
  assert.deepEqual(assembleWxSinks(api, { wxRealtimeLog: false, wxCloudCollection: 'telemetry' }, invoke).sinks.map(s => s.id), ['wx-cloud']);
  assert.deepEqual(assembleWxSinks(api, { wxRealtimeLog: true, wxCloudCollection: '' }).sinks.map(s => s.id), ['wx-realtime']);
  assert.deepEqual(assembleWxSinks(makeApiMock({ noMgr: true }), { wxRealtimeLog: true, wxCloudCollection: '' }).sinks, []);

  const host = makeHost();
  let visCb = null;
  host.onVisibility = cb => { visCb = cb; return () => { visCb = null; }; };
  const t = createTelemetry(host, c, asm.sinks, { tags: { env: 'wx' } });
  // init 已收 bootId（setFilterMsg：真机复现后 MP 后台按 bootId 过滤）
  assert.equal(api._mgr.filters.length, 1);
  assert.match(api._mgr.filters[0], /^[0-9a-f]{12}$/);
  // warn log：mirror 即时进实时日志（不等 flush）
  t.log('warn', 'perf.memWarn', { level: 10 });
  assert.deepEqual(api._mgr.warns, ['perf.memWarn|level=10']);
  assert.equal(calls.length, 0); // 云通道等批
  // onHide（经 adapter.onVisibility 映射）→ 强刷 → 云函数收批
  visCb(true);
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].batch[0].name, 'perf.memWarn');
  assert.equal(calls[0].batch[0].tags.env, 'wx');
  // crash：error 通道同步镜像 RealtimeLogManager.error（spec §4.5 双写）+ 云批
  asm.installErrorCapture(t);
  api._fireError({ message: 'fatal boom', stack: 'Error: fatal boom\n  at x (a.js:3:4)' });
  await tick();
  assert.equal(api._mgr.errors.length, 1);
  assert.ok(api._mgr.errors[0].startsWith('crash.wxError|'));
  assert.ok(api._mgr.errors[0].includes('message=fatal boom'));
  assert.ok(calls.length >= 2);
  assert.ok(calls[calls.length - 1].batch.some(e => e.name === 'crash.wxError'));
  t.destroy();
});
