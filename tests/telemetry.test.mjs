/**
 * telemetry 管线测试（S16b，spec §2/§3 全矩阵）：信封/seq/会话标识、级别过滤、采样稳定性、
 * 限流与字节预算、error 指纹去重、批量触发（条数/字节/延时/now/可见性）、溢出丢弃、
 * 传输重试与 dropped 聚合、flush 自监控防自激、withScope/measure/recent、no-op 与 disabled 零开销。
 * 全部用注入的假宿主（可控时钟/存储/可见性）与 spy sink 在 node 下直测。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTelemetry, createNoopTelemetry, resolveSessionId, sampleAccepts, fnv1a32,
  TELEMETRY_CONFIG_DEFAULTS, SESSION_STORAGE_KEY, RECENT_RING_SIZE,
} from '../packages/telemetry/dist/index.js';

const tick = () => new Promise(r => setTimeout(r, 5));

function makeHost(startMs = 1000) {
  const store = new Map();
  let t = startMs;
  let visCb = null;
  return {
    now: () => t,
    advance(ms) { t += ms; },
    setHidden(h) { if (visCb) visCb(h); },
    storage: {
      get: k => (store.has(k) ? store.get(k) : null),
      set: (k, v) => store.set(k, v),
      remove: k => store.delete(k),
    },
    onVisibility(cb) { visCb = cb; return () => { visCb = null; }; },
    _store: store,
  };
}

function cfg(over = {}) {
  const base = structuredClone(TELEMETRY_CONFIG_DEFAULTS);
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) base[k] = { ...base[k], ...v };
    else base[k] = v;
  }
  return base;
}

/** spy sink：send 时深拷贝批（信封在 flush 前可变，断言以序列化时点为准）。 */
function spySink(id = 'spy') {
  return {
    id, sent: [], mirrored: [], inited: null, mode: 'ok', deferred: null,
    send(batch) {
      this.sent.push(batch.map(e => structuredClone(e)));
      if (this.mode === 'fail') return false;
      if (this.mode === 'hang') return this.deferred;
      return undefined;
    },
    mirror(e) { this.mirrored.push(e.name); },
    init(info) { this.inited = info; },
    get events() { return this.sent.flat(); },
  };
}

function setup(over = {}, sinkOpts = {}) {
  const host = makeHost();
  const sink = spySink();
  if (sinkOpts.mode) sink.mode = sinkOpts.mode;
  if (sinkOpts.deferred) sink.deferred = sinkOpts.deferred;
  const t = createTelemetry(host, cfg(over), [sink]);
  return { host, sink, t };
}

// ---------- 信封与会话标识（spec §2） ----------

test('信封字段齐全、seq 自 1 单调、sid/bootId 形状正确', async () => {
  const { t, sink, host } = setup();
  t.log('info', 'a.b');
  t.metric('m.x', 'counter', 3);
  t.error(new Error('boom'));
  await t.flush();
  const evs = sink.events.filter(e => !e.name.startsWith('telemetry.'));
  assert.equal(evs.length, 3);
  const [log, metric, err] = evs;
  assert.equal(log.v, 1);
  assert.equal(log.ch, 'log');
  assert.equal(log.level, 'info');
  assert.equal(log.name, 'a.b');
  assert.match(log.sid, /^[0-9a-f]{16}$/);
  assert.match(log.bootId, /^[0-9a-f]{12}$/);
  assert.equal(log.ts, host.now());
  assert.ok(Math.abs(log.epochMs - Date.now()) < 5000);
  assert.deepEqual(evs.map(e => e.seq), [1, 2, 3]);
  assert.equal(metric.ch, 'metric');
  assert.equal(metric.kind, 'counter');
  assert.equal(metric.val, 3);
  assert.equal(err.ch, 'error');
  assert.equal(err.level, 'fatal'); // crash.* = fatal（spec §3.1）
  assert.equal(err.name, 'crash.uncaught');
  assert.equal(err.fields.message, 'boom');
  assert.match(err.fields.fingerprint, /^[0-9a-f]{16}$/);
  assert.ok(typeof err.fields.stack === 'string');
  assert.equal(sink.inited.sid, log.sid);
  assert.equal(sink.inited.bootId, log.bootId);
});

test('sid 跨实例持久（storage 键规范）、bootId 每实例新造', () => {
  const host = makeHost();
  const t1 = createTelemetry(host, cfg(), []);
  t1.log('info', 'x');
  const sid1 = t1.recent(1)[0].sid;
  const boot1 = t1.recent(1)[0].bootId;
  assert.equal(host.storage.get(SESSION_STORAGE_KEY), sid1);
  const t2 = createTelemetry(host, cfg(), []);
  t2.log('info', 'x');
  const env2 = t2.recent(1)[0];
  assert.equal(env2.sid, sid1);
  assert.notEqual(env2.bootId, boot1);
  assert.equal(resolveSessionId(host.storage), sid1);
});

// ---------- 级别过滤（spec §3.1） ----------

test('低于 minLevel 的 log 直接丢弃且不计 dropped；metric/error 不受 minLevel 约束', async () => {
  const { t, sink } = setup({ minLevel: 'warn' });
  t.log('info', 'quiet');
  t.log('trace', 'quieter');
  t.metric('m', 'counter', 1);
  t.error('err');
  await t.flush();
  const names = sink.events.map(e => e.name);
  assert.ok(!names.includes('quiet') && !names.includes('quieter'));
  assert.ok(names.includes('m') && names.includes('crash.uncaught'));
  assert.ok(!sink.events.some(e => e.name === 'telemetry.dropped'));
});

// ---------- 采样（spec §3.2/D3） ----------

test('采样稳定：同 sid+name 判定恒定，0/100 边界，双实例一致，服务端可重算', async () => {
  assert.equal(fnv1a32(''), 0x811c9dc5);
  assert.equal(fnv1a32('a'), 0xe40c292c);
  assert.equal(fnv1a32('foobar'), 0xbf9cf968);
  const host = makeHost();
  const sinkA = spySink('a');
  const tA = createTelemetry(host, cfg({ sampleRates: { default: 50, off: 0, on: 100 } }), [sinkA]);
  const sid = host.storage.get(SESSION_STORAGE_KEY);
  tA.log('info', 'off');
  tA.log('info', 'on');
  tA.log('info', 'half');
  await tA.flush();
  const namesA = sinkA.events.map(e => e.name);
  assert.ok(!namesA.includes('off'));
  assert.ok(namesA.includes('on'));
  const expectHalf = sampleAccepts(sid, 'half', 50);
  assert.equal(namesA.includes('half'), expectHalf);
  // 第二个实例（同 storage → 同 sid）对同名事件判定一致
  const sinkB = spySink('b');
  const tB = createTelemetry(host, cfg({ sampleRates: { default: 50, off: 0, on: 100 } }), [sinkB]);
  tB.log('info', 'half');
  await tB.flush();
  assert.equal(sinkB.events.some(e => e.name === 'half'), expectHalf);
  // 稳定哈希分布合理性：100 个名字 @50% 不应极端偏斜
  let accepted = 0;
  for (let i = 0; i < 100; i++) if (sampleAccepts(sid, 'name.' + i, 50)) accepted++;
  assert.ok(accepted > 20 && accepted < 80, `50% 采样接受数 ${accepted} 应在 (20,80)`);
});

test('session.boot 豁免采样与限流（spec §4.7）', async () => {
  const { t, sink } = setup({ sampleRates: { default: 0, 'session.boot': 0 }, rateLimit: { perNamePerMin: 1 } });
  t.log('info', 'session.boot', { phase: 'start' });
  t.log('info', 'session.boot');
  t.log('info', 'session.boot');
  t.log('info', 'other'); // default=0 → 被采样丢弃
  await t.flush();
  assert.equal(sink.events.filter(e => e.name === 'session.boot').length, 3);
  assert.ok(!sink.events.some(e => e.name === 'other'));
  assert.ok(!sink.events.some(e => e.name === 'telemetry.dropped'));
});

// ---------- 限流与字节预算（spec §3.3） ----------

test('按名 60s 窗口限流：超限丢弃并聚合 dropped{rate}，窗口翻转后恢复', async () => {
  const { t, sink, host } = setup({ rateLimit: { perNamePerMin: 2 } });
  t.log('info', 'r'); t.log('info', 'r'); t.log('info', 'r'); t.log('info', 'r');
  await t.flush();
  assert.equal(sink.events.filter(e => e.name === 'r').length, 2);
  const dropped = sink.events.filter(e => e.name === 'telemetry.dropped' && e.fields.reason === 'rate');
  assert.equal(dropped.length, 1); // 每窗口 ≤1 条
  assert.equal(dropped[0].fields.name, 'r');
  assert.equal(dropped[0].fields.count, 2); // 第 3、4 条聚合进同一条（就地更新）
  host.advance(60000);
  t.log('info', 'r');
  await t.flush();
  assert.equal(sink.events.filter(e => e.name === 'r').length, 3);
});

test('全局字节预算：超 maxBytesPerMin 丢弃并计 dropped{bytes}', async () => {
  const { t, sink, host } = setup({ rateLimit: { maxBytesPerMin: 1024 } });
  const pad = 'p'.repeat(500);
  t.log('info', 'b1', { pad });
  t.log('info', 'b2', { pad }); // 累计 >1024 → 丢
  await t.flush();
  assert.ok(sink.events.some(e => e.name === 'b1'));
  assert.ok(!sink.events.some(e => e.name === 'b2'));
  assert.ok(sink.events.some(e => e.name === 'telemetry.dropped' && e.fields.reason === 'bytes'));
  host.advance(60000);
  t.log('info', 'b3', { pad });
  await t.flush();
  assert.ok(sink.events.some(e => e.name === 'b3'));
});

// ---------- error 通道：去重窗（spec §3.3/§4.5/D14） ----------

test('error 指纹去重：窗口内收敛为 1 事件 + dupCount 快照；窗口过期重新放行', async () => {
  const { t, sink, host } = setup();
  const err = new Error('same crash');
  t.error(err);
  await tick(); // priority now → 立即成批
  assert.equal(sink.events.filter(e => e.name === 'crash.uncaught').length, 1);
  t.error(err); // 重复：原信封已发出 → 批末快照重发（dupCount=1）
  t.error(err); // 再重复：快照在队 → 就地更新 dupCount=2
  await t.flush();
  const crashes = sink.events.filter(e => e.name === 'crash.uncaught');
  assert.equal(crashes.length, 2); // 首发 + 1 条快照（不是 3 条）
  assert.equal(crashes[1].fields.dupCount, 2);
  assert.equal(crashes[0].fields.fingerprint, crashes[1].fields.fingerprint);
  t.error(err); // 快照已发出：窗口内后续重复仅本地计数（至多一次）
  await t.flush();
  assert.equal(sink.events.filter(e => e.name === 'crash.uncaught').length, 2);
  host.advance(61000); // 窗口过期 → 重新放行
  t.error(err);
  await tick();
  assert.equal(sink.events.filter(e => e.name === 'crash.uncaught').length, 3);
  t.error(new Error('other crash')); // 不同指纹不受影响
  await tick();
  assert.equal(sink.events.filter(e => e.fields.message === 'other crash').length, 1);
});

test('error.sample=0 应急总开关：全部丢弃且无 dropped 噪音', async () => {
  const { t, sink } = setup({ error: { sample: 0 } });
  t.error(new Error('x'));
  await t.flush();
  assert.equal(sink.events.filter(e => e.ch === 'error').length, 0);
});

test('error 事件名经 opts.name 分流（crash.rejection/crash.wxError），非 crash 名 → level error', async () => {
  const { t, sink } = setup();
  t.error('reason text', undefined, { name: 'crash.rejection' });
  t.error(new Error('biz'), { tag: 1 }, { name: 'biz.failed', priority: 'normal' });
  await t.flush();
  const rej = sink.events.find(e => e.name === 'crash.rejection');
  assert.equal(rej.level, 'fatal');
  assert.equal(rej.fields.message, 'reason text');
  assert.equal(rej.fields.reasonType, 'string');
  const biz = sink.events.find(e => e.name === 'biz.failed');
  assert.equal(biz.level, 'error');
  assert.equal(biz.fields.tag, 1);
});

// ---------- 批量刷写（spec §3.4） ----------

test('批量触发：条数达 maxEvents 自动刷；maxDelayMs 到时自动刷', async () => {
  const { t, sink } = setup({ batch: { maxEvents: 3, maxDelayMs: 0 } });
  t.log('info', 'x1'); t.log('info', 'x2');
  assert.equal(sink.sent.length, 0);
  t.log('info', 'x3'); // 第 3 条触发
  await tick();
  assert.equal(sink.sent.length, 1);
  assert.equal(sink.sent[0].length, 3);
  const host2 = makeHost();
  const sink2 = spySink();
  const t2 = createTelemetry(host2, cfg({ batch: { maxEvents: 100, maxDelayMs: 20 } }), [sink2]);
  t2.log('info', 'delayed');
  assert.equal(sink2.sent.length, 0);
  await new Promise(r => setTimeout(r, 60));
  assert.equal(sink2.sent.length, 1);
  t.destroy(); t2.destroy();
});

test('批量触发：字节达 maxBytesPerFlush 自动刷', async () => {
  const { t, sink } = setup({ batch: { maxEvents: 100, maxBytesPerFlush: 1024 } });
  const pad = 'p'.repeat(450);
  t.log('info', 'y1', { pad });
  t.log('info', 'y2', { pad });
  t.log('info', 'y3', { pad }); // 累计 ≥1024
  await tick();
  assert.ok(sink.sent.length >= 1);
  assert.ok(sink.events.some(e => e.name === 'y3') || sink.events.some(e => e.name === 'y2'));
});

test('onVisibility(hidden) 触发强刷；flushOnHide=false 不订阅', async () => {
  const { t, sink, host } = setup();
  t.log('info', 'vis');
  host.setHidden(true);
  await tick();
  assert.equal(sink.events.filter(e => e.name === 'vis').length, 1);
  const host2 = makeHost();
  const sink2 = spySink();
  const t2 = createTelemetry(host2, cfg({ batch: { flushOnHide: false } }), [sink2]);
  t2.log('info', 'vis2');
  host2.setHidden(true);
  await tick();
  assert.equal(sink2.sent.length, 0);
  t.destroy(); t2.destroy();
});

test('溢出：队列超 3 批丢最老 normal 并计 dropped{overflow}；now 批不可丢', async () => {
  let resolveSend;
  const deferred = new Promise(r => { resolveSend = r; });
  const { t, sink } = setup({ batch: { maxEvents: 2, maxDelayMs: 0 } }, { mode: 'hang', deferred });
  for (let i = 0; i < 12; i++) t.log('info', 'l');
  resolveSend(true); // 放行挂起的批
  for (let i = 0; i < 30; i++) await tick();
  const sentL = sink.events.filter(e => e.name === 'l');
  assert.ok(sentL.length < 12, `12 条应有一部分被溢出丢弃，实际发出 ${sentL.length}`);
  const overflow = sink.events.filter(e => e.name === 'telemetry.dropped' && e.fields.reason === 'overflow');
  assert.ok(overflow.length >= 1);
  assert.ok(overflow[0].fields.count >= 1);
  t.destroy();
});

test('传输失败：重试 batch.retry 次后丢弃并计 dropped{transport}，flush 自监控记录 ok=false', async () => {
  const { t, sink } = setup({ batch: { retry: 1, maxDelayMs: 0 } }, { mode: 'fail' });
  t.log('info', 'failcase');
  await t.flush(); // 含 1 次 2s 重试间隔（spec §3.4 固定值，本用例承担 2s）
  // sink 恒失败：dropped/flush 事件发不出去，但已入队并进环缓冲（recent 可查）
  const recent = t.recent(10);
  const drop = recent.find(e => e.name === 'telemetry.dropped' && e.fields.reason === 'transport');
  assert.ok(drop, 'dropped{transport} 应入队');
  assert.equal(drop.fields.count, 1);
  const flushEv = recent.find(e => e.name === 'telemetry.flush');
  assert.equal(flushEv.fields.ok, false);
  assert.equal(flushEv.fields.retry, 1);
  assert.equal(sink.sent.length, 2); // 首发 + 1 次重试
  t.destroy();
});

test('flush 自监控：telemetry.flush 事件只随批带出、不自激循环', async () => {
  const { t, sink } = setup();
  t.log('info', 'f1');
  await t.flush(); // 批1 = [f1]
  await t.flush(); // 批2 = [flush事件1]
  await t.flush(); // 批3 = [flush事件2]
  assert.equal(sink.sent.length, 3);
  const flushes = sink.events.filter(e => e.name === 'telemetry.flush');
  assert.equal(flushes.length, 2); // 第 3 条 flush 事件仍在队（有界，不无限增殖）
  assert.equal(flushes[0].kind, 'timer');
  assert.equal(flushes[0].fields.ok, true);
  assert.equal(flushes[0].fields.events, 1);
  t.destroy();
});

// ---------- 接口面：withScope / measure / recent / destroy / 公共维度 ----------

test('withScope：上下文并入 fields、可嵌套、不污染父句柄', async () => {
  const { t, sink } = setup();
  const scoped = t.withScope({ runId: 'r1' });
  const nested = scoped.withScope({ stage: 'run' });
  scoped.log('info', 's1');
  nested.log('info', 's2');
  t.log('info', 's3');
  await t.flush();
  const byName = Object.fromEntries(sink.events.filter(e => e.name.startsWith('s')).map(e => [e.name, e]));
  assert.equal(byName.s1.fields.runId, 'r1');
  assert.equal(byName.s1.fields.stage, undefined);
  assert.equal(byName.s2.fields.runId, 'r1');
  assert.equal(byName.s2.fields.stage, 'run');
  assert.equal(byName.s3.fields, undefined);
});

test('measure：记录 timer 毫秒并透传结果/异常', async () => {
  const { t, sink, host } = setup();
  const result = await t.measure('m.ok', async () => { host.advance(42); return 'v' });
  assert.equal(result, 'v');
  await assert.rejects(() => t.measure('m.err', () => { throw new Error('nope'); }), /nope/);
  await t.flush();
  const ok = sink.events.find(e => e.name === 'm.ok');
  assert.equal(ok.kind, 'timer');
  assert.equal(ok.val, 42);
  assert.ok(sink.events.some(e => e.name === 'm.err' && e.kind === 'timer'));
});

test('recent(n)：环缓冲返回最近 n 条，容量上限 RECENT_RING_SIZE', async () => {
  const { t } = setup({ rateLimit: { perNamePerMin: 100000 } });
  for (let i = 0; i < RECENT_RING_SIZE + 40; i++) t.log('info', 'ring');
  assert.equal(t.recent(10000).length, RECENT_RING_SIZE);
  assert.equal(t.recent(3).length, 3);
  t.destroy();
});

test('公共维度：common 注入 tags/fields，可变对象组装时读当前值（configHash 后回填）', async () => {
  const host = makeHost();
  const sink = spySink();
  const common = { tags: { env: 'web', quality: 'high' }, fields: { engineVersion: '0.1.0' } };
  const t = createTelemetry(host, cfg(), [sink], common);
  t.log('info', 'c1');
  common.fields.configHash = 'bundle:1.0.0';
  t.log('info', 'c2', { own: 1 });
  await t.flush();
  const c1 = sink.events.find(e => e.name === 'c1');
  const c2 = sink.events.find(e => e.name === 'c2');
  assert.deepEqual(c1.tags, { env: 'web', quality: 'high' });
  assert.equal(c1.fields.engineVersion, '0.1.0');
  assert.equal(c1.fields.configHash, undefined);
  assert.equal(c2.fields.configHash, 'bundle:1.0.0');
  assert.equal(c2.fields.own, 1); // 事件自身字段与公共维度合并
});

test('histogram val 数组为快照拷贝（入队后改源数组不影响信封）', async () => {
  const { t, sink } = setup();
  const buckets = new Array(12).fill(0);
  buckets[3] = 7;
  t.metric('perf.frameDist', 'histogram', buckets);
  buckets[3] = 999;
  await t.flush();
  const ev = sink.events.find(e => e.name === 'perf.frameDist');
  assert.equal(ev.val[3], 7);
});

test('destroy：最终刷写、后续事件忽略、计时器清理', async () => {
  const { t, sink } = setup();
  t.log('info', 'before');
  t.destroy();
  await tick();
  assert.equal(sink.events.filter(e => e.name === 'before').length, 1);
  t.log('info', 'after');
  await t.flush();
  assert.ok(!sink.events.some(e => e.name === 'after'));
});

// ---------- no-op 与 disabled（spec §1.5/§5/D13，任务 1「零开销」验收项） ----------

test('no-op 实现零开销：10 万次三通道调用近零耗时、零副作用、零分配 recent', async () => {
  const t = createNoopTelemetry();
  const fields = { k: 'v' };
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 100000; i++) {
    t.log('info', 'x', fields);
    t.metric('y', 'counter', 1);
    t.error('e');
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 300, `10 万次×3 通道应近零开销，实际 ${ms.toFixed(1)}ms`);
  assert.equal(t.recent(10).length, 0);
  assert.equal(t.recent(10), t.recent(10)); // 同一常量空数组（零分配）
  assert.equal(await t.measure('m', () => 42), 42);
  assert.equal(t.withScope({ a: 1 }).recent(1).length, 0);
  await t.flush();
  t.destroy();
});

test('enabled=false：只发一条 dropped{disabled} 确认，随后等效 noop', async () => {
  const host = makeHost();
  const sink = spySink();
  const t = createTelemetry(host, cfg({ enabled: false }), [sink]);
  await tick();
  assert.equal(sink.events.length, 1);
  assert.equal(sink.events[0].name, 'telemetry.dropped');
  assert.equal(sink.events[0].fields.reason, 'disabled');
  assert.equal(sink.events[0].seq, 1);
  for (let i = 0; i < 1000; i++) { t.log('info', 'x'); t.metric('y', 'counter', 1); t.error('e'); }
  await t.flush();
  assert.equal(sink.events.length, 1); // 不再产生任何事件/传输
  assert.equal(t.recent(10).length, 0);
});
