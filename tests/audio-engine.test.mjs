/**
 * AudioEngine 集成单测（S17）：mock AudioBackend + 假时钟，验证 池化/节流/抢占/淡变/双通道/状态机联动。
 * 后端契约要点在此同步校验：人工 stop 不触发 onEnded、loop 不触发 onEnded、play 可重触发。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioEngine } from '../packages/audio/dist/engine.js';
import { ACTION_SOUNDS, DEFAULT_SOUNDS, EVENT_SOUNDS } from '../packages/audio/dist/defaults.js';

class MockVoice {
  constructor(backend, asset) {
    this.backend = backend; this.asset = asset;
    this.log = []; this.playing = false; this.endedCb = null;
  }
  play(opts = {}) {
    this.log.push(['play', q(opts.volume ?? 1), opts.loop === true, q(opts.playbackRate ?? 1)]);
    this.playing = true;
  }
  stop() { this.log.push(['stop']); this.playing = false; }
  setVolume(v) { this.log.push(['vol', q(v)]); this.lastVol = v; }
  isPlaying() { return this.playing; }
  onEnded(cb) { this.endedCb = cb; }
  destroy() { this.log.push(['destroy']); this.playing = false; }
  emitEnded() { this.playing = false; this.endedCb?.(); } // 模拟自然播完（契约：仅此路径回调）
  eventsOf(kind) { return this.log.filter(e => e[0] === kind); }
}

const q = v => Number(v.toFixed(4));

function makeBackend() {
  const backend = {
    kind: 'web',
    voices: [], loads: [], loadDelayMs: 0, unlockCalls: 0, pauseLog: [], disposed: false,
    async load(src) {
      backend.loads.push(src);
      if (backend.loadDelayMs > 0) await new Promise(r => setTimeout(r, backend.loadDelayMs));
      return { src };
    },
    createVoice(asset) {
      const v = new MockVoice(backend, asset);
      backend.voices.push(v);
      return v;
    },
    unload() { backend.unloads = (backend.unloads ?? 0) + 1; },
    unlock() { backend.unlockCalls++; },
    setPaused(p) { backend.pauseLog.push(p); },
    dispose() { backend.disposed = true; },
  };
  return backend;
}

const memStorage = () => {
  const m = new Map();
  return { map: m, get: k => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, String(v)), remove: k => m.delete(k) };
};

const SFX = (id, extra = {}) => ({ id, src: `${id}.mp3`, kind: 'sfx', ...extra });
const BGM = id => ({ id, src: `${id}.mp3`, kind: 'bgm' });

function harness(sounds, engineOpts = {}) {
  let now = 0;
  const backend = makeBackend();
  const storage = memStorage();
  const engine = createAudioEngine({
    backend, storage, sounds, clock: () => now,
    sfxMaxLive: 8, bgmFadeMs: 100, ...engineOpts,
  });
  return {
    engine, backend, storage,
    at: v => { now = v; },
    advance: d => { now += d; },
    now: () => now,
  };
}

const voiceBySrc = (backend, src) => backend.voices.filter(v => v.asset.src === src);

// ---------- 预加载与注册 ----------

test('preload：全量加载/子集加载/未注册 id reject/isLoaded 联动', async () => {
  const h = harness([SFX('a'), BGM('m')]);
  assert.equal(h.engine.isLoaded('a'), false);
  await h.engine.preload(['a']);
  assert.deepEqual(h.backend.loads, ['a.mp3']);
  assert.equal(h.engine.isLoaded('a'), true);
  await assert.rejects(() => h.engine.preload(['zzz']), /zzz/);
  await h.engine.preload(); // 补齐未加载的（a 不重复 load）
  assert.deepEqual(h.backend.loads, ['a.mp3', 'm.mp3']);
});

test('register：未加载可新增；已加载换 src 抛错；同 src 覆盖放行', async () => {
  const h = harness([SFX('a')]);
  await h.engine.preload();
  h.engine.register(SFX('b'));
  await h.engine.preload(['b']);
  assert.throws(() => h.engine.register(SFX('a', { src: 'other.mp3' })), /已加载/);
  h.engine.register(SFX('a')); // 同 src 幂等覆盖
});

// ---------- SFX：节流 / 池化 / 抢占 ----------

test('playSfx：未加载直接丢弃（不隐式拉取）；加载后首播放参数正确', async () => {
  const h = harness([SFX('coin', { throttleMs: 0 })]);
  assert.equal(h.engine.playSfx('coin'), false);
  await h.engine.preload();
  assert.equal(h.engine.playSfx('coin'), true);
  assert.deepEqual(h.backend.voices[0].log[0], ['play', 1, false, 1]);
});

test('节流窗口：window 内 false，恰好出窗 true；不同 id 互不影响', async () => {
  const h = harness([SFX('a', { throttleMs: 100 }), SFX('b', { throttleMs: 100 })]);
  await h.engine.preload();
  h.at(0);
  assert.equal(h.engine.playSfx('a'), true);
  h.at(99);
  assert.equal(h.engine.playSfx('a'), false);
  assert.equal(h.engine.playSfx('b'), true);
  h.at(100);
  assert.equal(h.engine.playSfx('a'), true);
});

test('声部池：空闲复用（onEnded 回收）、池满重触发最旧（不新建原生声部）', async () => {
  const h = harness([SFX('a', { throttleMs: 0, maxVoices: 2 })]);
  await h.engine.preload();
  assert.equal(h.engine.playSfx('a'), true); // v0
  h.advance(1); assert.equal(h.engine.playSfx('a'), true); // v1
  h.advance(1); assert.equal(h.engine.playSfx('a'), true); // 池满 → 重触发最旧 v0
  assert.equal(h.backend.voices.length, 2);
  assert.equal(h.backend.voices[0].eventsOf('play').length, 2);
  h.backend.voices[0].emitEnded();
  h.advance(1);
  assert.equal(h.engine.playSfx('a'), true);
  assert.equal(h.backend.voices.length, 2); // 空闲 v0 回收复用，不新建
  assert.equal(h.backend.voices[0].eventsOf('play').length, 3);
});

test('并发上限与抢占：更高优先级顶掉最低·最旧；同级丢弃；被顶声部 stop+destroy', async () => {
  const h = harness([SFX('lo', { throttleMs: 0, priority: 1, maxVoices: 1 }), SFX('hi', { throttleMs: 0, priority: 3, maxVoices: 1 })], { sfxMaxLive: 1 });
  await h.engine.preload();
  assert.equal(h.engine.playSfx('lo'), true);
  const vLo = h.backend.voices[0];
  h.advance(1);
  assert.equal(h.engine.playSfx('hi'), true); // 抢占
  assert.deepEqual(vLo.log, [['play', 1, false, 1], ['stop'], ['destroy']]);
  const vHi = h.backend.voices[1];
  assert.equal(vHi.isPlaying(), true);
  h.advance(1);
  assert.equal(h.engine.playSfx('lo'), false); // 低优先级打不动 hi
  assert.equal(h.backend.voices.length, 2);
  h.advance(1);
  vHi.emitEnded(); // hi 自然结束 → lo 可再进
  assert.equal(h.engine.playSfx('lo'), true);
});

test('overrides：volume/playbackRate 透传后端 play 参数', async () => {
  const h = harness([SFX('a', { throttleMs: 0 })]);
  await h.engine.preload();
  h.engine.playSfx('a', { volume: 0.5, playbackRate: 2 });
  assert.deepEqual(h.backend.voices[0].log[0], ['play', 0.5, false, 2]);
});

// ---------- 音量状态机联动 ----------

test('增益合成：play 时即时相乘；在播声部随 setMaster/setMuted 刷新', async () => {
  const h = harness([SFX('a', { throttleMs: 0 })]);
  await h.engine.preload();
  h.engine.setMaster(0.5);
  assert.equal(h.engine.playSfx('a'), true);
  assert.equal(h.backend.voices[0].eventsOf('play')[0][1], 0.5);
  h.engine.setMuted(true);
  assert.deepEqual(h.backend.voices[0].eventsOf('vol').at(-1), ['vol', 0]);
  assert.equal(h.engine.playSfx('a'), false); // 静音期瞬态音效直接丢弃
  h.engine.setMuted(false);
  assert.deepEqual(h.backend.voices[0].eventsOf('vol').at(-1), ['vol', 0.5]);
});

test('通道独立：sfx 关闭不影响到 bgm 增益（setChannel* 别名）', async () => {
  const h = harness([SFX('a'), BGM('m')]);
  h.engine.setChannelEnabled('sfx', false);
  assert.equal(h.engine.settings().bgm.enabled, true);
  await h.engine.preload();
  assert.equal(h.engine.playSfx('a'), false);
});

test('音量持久化：引擎 setter 写入 thunderrun:audio:*，新引擎实例回读', async () => {
  const h = harness([SFX('a')]);
  h.engine.setMaster(0.3);
  h.engine.setChannelVolume('bgm', 0.6);
  assert.equal(h.storage.map.get('thunderrun:audio:master'), '0.3');
  const h3 = createAudioEngine({ backend: makeBackend(), storage: h.storage, sounds: [SFX('a')], clock: () => 0 });
  assert.equal(h3.settings().master, 0.3);
  assert.equal(h3.settings().bgm.volume, 0.6);
});

// ---------- BGM：淡入淡出 / 切换 / 竞态 ----------

test('playBgm：loop+0 起播+淡入；同 id 幂等；currentId', async () => {
  const h = harness([BGM('m')]);
  await h.engine.playBgm('m');
  const v = h.backend.voices[0];
  assert.deepEqual(v.eventsOf('play')[0], ['play', 0, true, 1]);
  h.at(50); h.engine.update();
  assert.deepEqual(v.eventsOf('vol').at(-1), ['vol', 0.5]);
  h.at(100); h.engine.update();
  assert.deepEqual(v.eventsOf('vol').at(-1), ['vol', 1]);
  await h.engine.playBgm('m'); // 幂等
  assert.equal(h.backend.voices.length, 1);
  assert.equal(v.eventsOf('play').length, 1);
});

test('场景切换交叉淡化：旧淡出至 0 后释放 ∥ 新淡入（双声部并行段）', async () => {
  const h = harness([BGM('a'), BGM('b')]);
  await h.engine.playBgm('a');
  h.at(200); h.engine.update(); // a 满音量
  const va = h.backend.voices[0];
  await h.engine.playBgm('b'); // 交叉淡化开始
  const vb = h.backend.voices[1];
  h.at(250); h.engine.update();
  assert.deepEqual(va.eventsOf('vol').at(-1), ['vol', 0.5]); // a 淡出中
  assert.deepEqual(vb.eventsOf('vol').at(-1), ['vol', 0.5]); // b 淡入中
  h.at(300); h.engine.update();
  assert.deepEqual(va.eventsOf('vol').at(-1), ['vol', 0]);
  assert.deepEqual(va.log.at(-2), ['stop']);
  assert.deepEqual(va.log.at(-1), ['destroy']); // 淡出完成即释放原生句柄（wx 实例数约束）
  assert.equal(vb.isPlaying(), true);
});

test('stopBgm：淡出后释放；在途补加载的 playBgm 被代数守卫作废（切换竞态）', async () => {
  const h = harness([BGM('a'), BGM('slow')]);
  await h.engine.preload(['a']);
  await h.engine.playBgm('a');
  h.engine.stopBgm(50);
  h.at(60); h.engine.update();
  const va = h.backend.voices[0];
  assert.deepEqual(va.log.at(-2), ['stop']); // 淡出完成
  assert.equal(h.backend.voices.length, 1);

  // slow 未预加载 → playBgm 走补加载路径；loadDelay 期间 stopBgm → 不应创建新声部
  h.backend.loadDelayMs = 10;
  const p = h.engine.playBgm('slow');
  h.engine.stopBgm(0);
  await p;
  assert.equal(h.backend.voices.length, 1);
});

// ---------- 暂停 / 解锁 / 销毁 ----------

test('setPaused：后端转发 + 暂停期 playSfx 丢弃；unlock 透传', async () => {
  const h = harness([SFX('a', { throttleMs: 0 })]);
  await h.engine.preload();
  h.engine.unlock();
  assert.equal(h.backend.unlockCalls, 1);
  h.engine.setPaused(true);
  assert.deepEqual(h.backend.pauseLog, [true]);
  assert.equal(h.engine.playSfx('a'), false);
  h.engine.setPaused(false);
  assert.equal(h.engine.playSfx('a'), true);
});

test('dispose：全部声部 destroy + 后端 dispose + 后续调用安全空转', async () => {
  const h = harness([SFX('a', { throttleMs: 0 }), BGM('m')]);
  await h.engine.preload();
  h.engine.playSfx('a');
  await h.engine.playBgm('m');
  const vs = [...h.backend.voices];
  h.engine.dispose();
  assert.ok(vs.every(v => v.log.some(e => e[0] === 'destroy')));
  assert.equal(h.backend.disposed, true);
  assert.equal(h.engine.playSfx('a'), false);
  await h.engine.playBgm('m'); // 不应抛错也不应新建声部
  assert.equal(h.backend.voices.length, vs.length);
});

// ---------- 注册表一致性（与挂点表/默认表联动） ----------

test('EVENT_SOUNDS / ACTION_SOUNDS 引用的 id 全部在 DEFAULT_SOUNDS 中且 kind 正确', () => {
  const byId = new Map(DEFAULT_SOUNDS.map(d => [d.id, d]));
  for (const [ev, id] of Object.entries(EVENT_SOUNDS)) {
    assert.ok(byId.has(id), `事件 ${ev} 映射到未定义声音 ${id}`);
  }
  for (const [act, id] of Object.entries(ACTION_SOUNDS)) {
    assert.ok(byId.has(id), `动作 ${act} 映射到未定义声音 ${id}`);
  }
  assert.ok(byId.get('bgm_menu').kind === 'bgm' && byId.get('sfx_coin').kind === 'sfx');
});

test('playSfx 指错通道（bgm id）/ playBgm 指错通道（sfx id）→ 丢弃并告警', async () => {
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    const h = harness([SFX('a', { throttleMs: 0 }), BGM('m')]);
    await h.engine.preload();
    assert.equal(h.engine.playSfx('m'), false);
    await h.engine.playBgm('a');
    assert.equal(warns.length, 2);
    assert.ok(warns[0].includes('非 sfx') && warns[1].includes('非 bgm'));
  } finally {
    console.warn = orig;
  }
});
