/**
 * web 遥测通道测试（platform-web/src/telemetryChannel.ts，spec §6/D9）。
 * DOM/BOM 用桩注入（window/navigator/console/fetch），node 下直测：
 * console sink（echo+环缓冲）、beacon sink（sendBeacon 主 + fetch keepalive 兜底 + 空端点不注册）、
 * crash 捕获安装/退订、readWebMemory 三档、createWebTelemetry 装配面（noop 兜底/pagehide/debug）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createConsoleSink, createBeaconSink, installWebErrorCapture, readWebMemory, createWebTelemetry,
} from '../packages/platform-web/dist/telemetryChannel.js';
import { canonicalJson, createTelemetry, TELEMETRY_CONFIG_DEFAULTS } from '../packages/telemetry/dist/index.js';

// ---------- 环境桩 ----------

const origNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

function makeWindowStub() {
  const listeners = new Map();
  const win = {
    onerror: null,
    addEventListener(type, cb) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(cb);
    },
    removeEventListener(type, cb) {
      const l = listeners.get(type) ?? [];
      const i = l.indexOf(cb);
      if (i >= 0) l.splice(i, 1);
    },
    _fire(type, ev) { for (const cb of [...(listeners.get(type) ?? [])]) cb(ev); },
    _count(type) { return (listeners.get(type) ?? []).length; },
  };
  globalThis.window = win;
  return win;
}

function setNavigator(stub) {
  Object.defineProperty(globalThis, 'navigator', { value: stub, configurable: true, writable: true });
}

function captureConsole() {
  const calls = [];
  const orig = {};
  for (const m of ['debug', 'info', 'warn', 'error']) {
    orig[m] = console[m];
    console[m] = (...args) => calls.push([m, ...args]);
  }
  return { calls, restore() { Object.assign(console, orig); } };
}

function makeHost() {
  const store = new Map();
  let t = 100;
  return {
    now: () => t,
    advance(ms) { t += ms; },
    storage: { get: k => store.get(k) ?? null, set: (k, v) => store.set(k, v), remove: k => store.delete(k) },
  };
}

const sampleEnv = {
  v: 1, ch: 'log', ts: 5, epochMs: 1700000000000, seq: 1,
  bootId: 'b'.repeat(12), sid: 's'.repeat(16),
  name: 'boot.summary', level: 'info', fields: { total: 123, navOffsetMs: 2 },
};

// ---------- console sink ----------

test('console sink：mirror 即时 echo（[tr.<level>] 前缀）+ 环缓冲 recent(n)', () => {
  const cap = captureConsole();
  try {
    const sink = createConsoleSink({ ringSize: 3 });
    assert.equal(sink.id, 'web-console');
    assert.equal(sink.send([sampleEnv]), undefined); // void = 成功（echo 走 mirror，无传输语义）
    sink.mirror(sampleEnv);
    assert.deepEqual(cap.calls[0], ['info', '[tr.info]', 'boot.summary', { fields: sampleEnv.fields }]);
    for (const [level, method] of [['warn', 'warn'], ['error', 'error'], ['fatal', 'error'], ['debug', 'debug'], ['trace', 'debug']]) {
      cap.calls.length = 0;
      sink.mirror({ ...sampleEnv, level, name: 'l.' + level });
      assert.equal(cap.calls[0][0], method, `${level} → console.${method}`);
      assert.equal(cap.calls[0][1], `[tr.${level}]`);
    }
    // error 通道（无 level 时按 fatal 处理走 error；管线实际会带 level）
    cap.calls.length = 0;
    sink.mirror({ ...sampleEnv, ch: 'error', level: undefined, name: 'crash.x' });
    assert.equal(cap.calls[0][0], 'info'); // level 缺省且 ch≠metric → info 前缀（防御分支）
    // 环缓冲：容量 3，recent 取尾
    const sink2 = createConsoleSink({ ringSize: 3, echoMetrics: false });
    const cap2 = captureConsole();
    for (let i = 0; i < 5; i++) sink2.mirror({ ...sampleEnv, seq: i + 1, name: 'n' + i });
    for (let i = 0; i < 3; i++) sink2.mirror({ ...sampleEnv, ch: 'metric', kind: 'counter', val: i, level: undefined, name: 'm' + i });
    assert.equal(sink2.recent(100).length, 3); // 环容量 3
    assert.deepEqual(sink2.recent(2).map(e => e.name), ['m1', 'm2']);
    assert.equal(cap2.calls.filter(c => c[2]?.startsWith?.('m')).length, 0); // echoMetrics=false：metric 不进控制台
    cap2.restore();
  } finally { cap.restore(); }
});

test('console sink：echoMetrics=false 时 metric 仍入环、log 照常 echo', () => {
  const cap = captureConsole();
  try {
    const sink = createConsoleSink({ echoMetrics: false });
    sink.mirror({ ...sampleEnv, ch: 'metric', kind: 'counter', val: 1, level: undefined, name: 'm.x' });
    assert.equal(cap.calls.length, 0);
    assert.equal(sink.recent(10).length, 1); // 环缓冲照常收
    sink.mirror(sampleEnv);
    assert.equal(cap.calls.length, 1);
  } finally { cap.restore(); }
});

// ---------- beacon sink ----------

test('beacon sink：空端点 → null（不注册，调试壳零网络噪音）', () => {
  assert.equal(createBeaconSink(''), null);
});

test('beacon sink：sendBeacon 主通道，payload = 信封数组 canonicalJson', async () => {
  const beacons = [];
  setNavigator({ userAgent: 'UA', sendBeacon: (url, blob) => { beacons.push({ url, blob }); return true; } });
  try {
    const sink = createBeaconSink('/telemetry');
    const ok = await sink.send([sampleEnv, { ...sampleEnv, seq: 2 }]);
    assert.equal(ok, true);
    assert.equal(beacons.length, 1);
    assert.equal(beacons[0].url, '/telemetry');
    assert.equal(await beacons[0].blob.text(), canonicalJson([sampleEnv, { ...sampleEnv, seq: 2 }]));
    assert.equal(beacons[0].blob.type, 'application/json');
  } finally {
    if (origNavigatorDesc) Object.defineProperty(globalThis, 'navigator', origNavigatorDesc);
  }
});

test('beacon sink：sendBeacon false/缺失/抛错 → fetch keepalive 兜底；失败 → false', async () => {
  const fetches = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { fetches.push({ url, init }); return { ok: true }; };
  try {
    setNavigator({ userAgent: 'UA', sendBeacon: () => false });
    const sink = createBeaconSink('/t');
    assert.equal(await sink.send([sampleEnv]), true); // sendBeacon false → fetch 兜底成功
    assert.equal(fetches.length, 1);
    assert.equal(fetches[0].init.method, 'POST');
    assert.equal(fetches[0].init.keepalive, true);
    assert.equal(fetches[0].init.body, canonicalJson([sampleEnv]));
    // sendBeacon 抛错 → 仍走 fetch
    setNavigator({ userAgent: 'UA', sendBeacon: () => { throw new Error('quota'); } });
    assert.equal(await sink.send([sampleEnv]), true);
    assert.equal(fetches.length, 2);
    // navigator 无 sendBeacon → 直接 fetch
    setNavigator({ userAgent: 'UA' });
    assert.equal(await sink.send([sampleEnv]), true);
    assert.equal(fetches.length, 3);
    // fetch 非 2xx → false；fetch 抛错 → false（管线计 dropped{transport}）
    globalThis.fetch = async () => ({ ok: false });
    assert.equal(await sink.send([sampleEnv]), false);
    globalThis.fetch = async () => { throw new Error('network down'); };
    assert.equal(await sink.send([sampleEnv]), false);
  } finally {
    globalThis.fetch = origFetch;
    if (origNavigatorDesc) Object.defineProperty(globalThis, 'navigator', origNavigatorDesc);
  }
});

// ---------- crash 捕获（spec §4.5） ----------

test('installWebErrorCapture：onerror/unhandledrejection → error 通道（now），跨域净化标记，退订还原', () => {
  const win = makeWindowStub();
  const host = makeHost();
  const t = createTelemetry(host, structuredClone(TELEMETRY_CONFIG_DEFAULTS), []);
  const prevHandler = () => 'prev-called';
  win.onerror = prevHandler;
  const uninstall = installWebErrorCapture(t);
  assert.equal(win._count('unhandledrejection'), 1);
  // window.onerror：ErrorEvent 五参形态
  const err = new Error('boom');
  const ret = win.onerror('Uncaught Error: boom', 'http://x/app.js', 12, 34, err);
  assert.equal(ret, 'prev-called'); // 既有 handler 回放（多捕获器并存互不吞并）
  let recent = t.recent(5);
  let crash = recent.find(e => e.name === 'crash.uncaught');
  assert.equal(crash.level, 'fatal');
  assert.equal(crash.fields.file, 'http://x/app.js');
  assert.equal(crash.fields.line, 12);
  assert.equal(crash.fields.col, 34);
  assert.equal(crash.fields.message, 'boom');
  // 跨域净化：无 error 对象且 message='Script error.'
  win.onerror('Script error.', '', 0, 0, null);
  crash = t.recent(5).find(e => e.fields?.src === 'crossorigin');
  assert.ok(crash, '跨域脚本应标 src=crossorigin');
  assert.equal(crash.name, 'crash.uncaught');
  // unhandledrejection
  win._fire('unhandledrejection', { reason: 'plain string reason' });
  const rej = t.recent(5).find(e => e.name === 'crash.rejection');
  assert.equal(rej.fields.message, 'plain string reason');
  assert.equal(rej.fields.reasonType, 'string');
  // 退订：onerror 还原、rejection 监听移除
  uninstall();
  assert.equal(win.onerror, prevHandler);
  assert.equal(win._count('unhandledrejection'), 0);
  const before = t.recent(100).length;
  win._fire('unhandledrejection', { reason: 'after uninstall' });
  assert.equal(t.recent(100).length, before);
  delete globalThis.window;
  t.destroy();
});

test('installWebErrorCapture：无 window 环境（node 直测）静默不装', () => {
  delete globalThis.window;
  const host = makeHost();
  const t = createTelemetry(host, structuredClone(TELEMETRY_CONFIG_DEFAULTS), []);
  const off = installWebErrorCapture(t);
  assert.equal(typeof off, 'function');
  off();
  t.destroy();
});

// ---------- 内存三档（web 档） ----------

test('readWebMemory：performance.memory 缺失 → src unavailable（诚实标注，不静默）', () => {
  const m = readWebMemory();
  if (typeof performance !== 'undefined' && 'memory' in performance) {
    assert.equal(m.src, 'performance.memory');
    assert.equal(typeof m.usedMB, 'number');
  } else {
    assert.deepEqual(m, { src: 'unavailable' });
  }
});

// ---------- 装配面 createWebTelemetry ----------

test('createWebTelemetry：params 缺 telemetry 节 → noop 管线（cfg undefined、consoleSink null、零副作用）', () => {
  makeWindowStub();
  const cap = captureConsole();
  try {
    const h = createWebTelemetry(makeHost(), { params: {} });
    assert.equal(h.cfg, undefined);
    assert.equal(h.consoleSink, null);
    h.sdk.bootStart({ launchMode: 'web' });
    h.sdk.markBoot('entry', 1);
    h.sdk.frameTime(16);
    h.sdk.memory(null, { src: 'unavailable' });
    h.sdk.unhandledError(new Error('x'));
    assert.equal(h.telemetry.recent(10).length, 0);
    assert.equal(cap.calls.length, 0); // noop：连 console 都没有
    h.uninstall();
  } finally { cap.restore(); delete globalThis.window; }
});

test('createWebTelemetry：装配 → session.boot echo、common 维度、debug 钳 trace、pagehide 强刷、uninstall 清理', async () => {
  const win = makeWindowStub();
  const beacons = [];
  setNavigator({ userAgent: 'UA-test-browser', sendBeacon: (url, blob) => { beacons.push({ url, blob }); return true; } });
  const cap = captureConsole();
  let h;
  try {
    const host = makeHost();
    host.onVisibility = () => () => {};
    h = createWebTelemetry(host, {
      cfg: { ...structuredClone(TELEMETRY_CONFIG_DEFAULTS), transport: { ...TELEMETRY_CONFIG_DEFAULTS.transport, webEndpoint: '/telemetry' } },
      debug: true,
      t0: 50,
      navOffsetMs: 50,
      engineVersion: '0.1.0',
      quality: 'high',
    });
    assert.equal(h.cfg.minLevel, 'trace'); // ?debug 钳制
    assert.equal(h.consoleSink.id, 'web-console');
    assert.equal(h.common.tags.env, 'web');
    assert.equal(h.common.tags.quality, 'high');
    assert.equal(h.common.fields.engineVersion, '0.1.0');
    assert.equal(h.common.fields.device, 'UA-test-browser'); // UA 截断 64
    // crash 捕获缺省自动安装
    assert.equal(typeof win.onerror, 'function');
    // SDK 打点 → console echo + 环缓冲
    h.sdk.bootStart({ launchMode: 'web' });
    h.sdk.markBoot('entry');
    assert.ok(cap.calls.some(c => c[1] === '[tr.info]' && c[2] === 'session.boot'));
    const names = h.telemetry.recent(10).map(e => e.name);
    assert.ok(names.includes('session.boot') && names.includes('boot.phase'));
    // trace 级通过（debug 钳制生效）
    h.telemetry.log('trace', 'dbg.trace', { a: 1 });
    assert.ok(h.telemetry.recent(5).some(e => e.name === 'dbg.trace'));
    // common 可变：回填 configHash 后新事件携带
    h.common.fields.configHash = 'bundle:1.0.0';
    h.telemetry.log('info', 'cfg.after');
    const after = h.telemetry.recent(5).find(e => e.name === 'cfg.after');
    assert.equal(after.fields.configHash, 'bundle:1.0.0');
    // pagehide → 强刷 → beacon 发出
    assert.equal(beacons.length, 0);
    win._fire('pagehide', {});
    await new Promise(r => setTimeout(r, 5));
    assert.ok(beacons.length >= 1);
    assert.equal(beacons[0].url, '/telemetry');
    const batch = JSON.parse(await beacons[0].blob.text());
    assert.ok(Array.isArray(batch) && batch[0].v === 1);
    // uninstall：pagehide 监听移除、onerror 还原、管线销毁（destroy 的最终刷写允许再发一批余量）
    h.uninstall();
    assert.equal(win._count('pagehide'), 0);
    assert.equal(win.onerror, null);
    await new Promise(r => setTimeout(r, 5));
    const beaconsAfterUninstall = beacons.length;
    h.telemetry.log('info', 'after.uninstall');
    await new Promise(r => setTimeout(r, 5));
    assert.equal(beacons.length, beaconsAfterUninstall); // destroy 后事件被忽略，不再有新批
  } finally {
    cap.restore();
    h?.uninstall();
    delete globalThis.window;
    if (origNavigatorDesc) Object.defineProperty(globalThis, 'navigator', origNavigatorDesc);
  }
});

test('createWebTelemetry：配置钳制 warn 走 console.warn（[tr.telemetry-config] 前缀）', () => {
  makeWindowStub();
  const cap = captureConsole();
  try {
    const h = createWebTelemetry(makeHost(), { params: { telemetry: { batch: { maxEvents: 9999 } } }, installErrorCapture: false });
    assert.equal(h.cfg.batch.maxEvents, 200);
    assert.ok(cap.calls.some(c => c[0] === 'warn' && String(c[1]).includes('[tr.telemetry-config]')));
    assert.equal(globalThis.window.onerror, null); // installErrorCapture:false → 不装
    h.uninstall();
  } finally { cap.restore(); delete globalThis.window; }
});
