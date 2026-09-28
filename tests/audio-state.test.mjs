/**
 * 音量状态机 + 淡变调度单测（S17）。
 * 覆盖：默认值/钳制/损坏回退、thunderrun:audio:* 键持久化与回读、mute×master×通道增益合成、
 *       fade 步进/终点吸附/eps 合并/零时长直达/cancel 语义。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createVolumeState, MASTER_KEY, MUTED_KEY, CHANNEL_KEYS } from '../packages/audio/dist/volumeState.js';
import { createFadeRunner } from '../packages/audio/dist/fade.js';

const memStorage = (init = {}) => {
  const m = new Map(Object.entries(init));
  return {
    map: m,
    get: k => (m.has(k) ? m.get(k) : null),
    set: (k, v) => { m.set(k, String(v)); },
    remove: k => { m.delete(k); },
  };
};

test('无存档 → 默认状态；gainFor = master×通道', () => {
  const vs = createVolumeState(memStorage());
  const s = vs.get();
  assert.equal(s.master, 1);
  assert.equal(s.muted, false);
  assert.deepEqual(s.bgm, { enabled: true, volume: 1 });
  assert.equal(vs.gainFor('bgm'), 1);
  assert.equal(vs.gainFor('sfx'), 1);
});

test('setter 写穿存档且键符合 thunderrun:audio:* 约定', () => {
  const st = memStorage();
  const vs = createVolumeState(st);
  vs.setMaster(0.5);
  vs.setMuted(true);
  vs.setChannelVolume('sfx', 0.3);
  vs.setChannelEnabled('bgm', false);
  assert.equal(st.map.get(MASTER_KEY), '0.5');
  assert.equal(st.map.get(MUTED_KEY), '1');
  assert.deepEqual(st.map.get(CHANNEL_KEYS.sfx), JSON.stringify([true, 0.3]));
  assert.deepEqual(st.map.get(CHANNEL_KEYS.bgm), JSON.stringify([false, 1]));
});

test('新状态机从同一存档恢复（跨会话持久化）', () => {
  const st = memStorage();
  const a = createVolumeState(st);
  a.setMaster(0.4);
  a.setChannelVolume('bgm', 0.8);
  a.setMuted(true);
  const b = createVolumeState(st);
  assert.equal(b.get().master, 0.4);
  assert.equal(b.get().bgm.volume, 0.8);
  assert.equal(b.get().muted, true);
});

test('损坏存档逐项回默认，不整档重置也不 throw', () => {
  const vs = createVolumeState(memStorage({
    [MASTER_KEY]: 'abc',                       // 坏 → 默认 1
    [MUTED_KEY]: 'maybe',                      // 非 '1' → false
    [CHANNEL_KEYS.bgm]: '{oops',                // 坏 JSON → 默认
    [CHANNEL_KEYS.sfx]: '[true,"x"]',           // volume NaN → 该项回默认音量，enabled 保留
  }));
  const s = vs.get();
  assert.equal(s.master, 1);
  assert.equal(s.muted, false);
  assert.deepEqual(s.bgm, { enabled: true, volume: 1 });
  assert.deepEqual(s.sfx, { enabled: true, volume: 1 });
});

test('钳制与非法值：越界夹到 0..1，NaN 保持原值', () => {
  const vs = createVolumeState(memStorage());
  vs.setMaster(2); assert.equal(vs.get().master, 1);
  vs.setMaster(-5); assert.equal(vs.get().master, 0);
  vs.setMaster(NaN); assert.equal(vs.get().master, 0); // 非法 → 不改
  vs.setChannelVolume('bgm', 9); assert.equal(vs.get().bgm.volume, 1);
  vs.setChannelVolume('sfx', NaN); assert.equal(vs.get().sfx.volume, 1); // 非法 → 不改
});

test('增益合成优先级：muted > master > 通道开关/音量', () => {
  const vs = createVolumeState(memStorage());
  vs.setMaster(0.5);
  vs.setChannelVolume('bgm', 0.5);
  assert.equal(vs.gainFor('bgm'), 0.25);
  vs.setChannelEnabled('bgm', false);
  assert.equal(vs.gainFor('bgm'), 0);
  assert.equal(vs.gainFor('sfx'), 0.5); // sfx 通道不受 bgm 影响
  vs.setChannelEnabled('bgm', true);
  vs.setMuted(true);
  assert.equal(vs.gainFor('bgm'), 0);
  assert.equal(vs.gainFor('sfx'), 0);
});

test('fade：线性步进 + 尾帧吸附 + 终点回调', () => {
  const fr = createFadeRunner();
  const seen = [];
  let done = 0;
  fr.start({ from: 0, to: 1, durationMs: 100, apply: v => seen.push(v), onDone: () => done++ }, 0);
  fr.update(50);
  assert.ok(Math.abs(seen.at(-1) - 0.5) < 1e-9);
  fr.update(90); // 步进差 < eps 时合并跳过？0.5→0.9 变化大，应记录
  assert.ok(Math.abs(seen.at(-1) - 0.9) < 1e-9);
  fr.update(100);
  assert.equal(seen.at(-1), 1); // 精确吸附到 to
  assert.equal(done, 1);
  assert.equal(fr.count(), 0);
});

test('fade：eps 合并（微小变化不回调，wx setVolume 桥省调用）', () => {
  const fr = createFadeRunner();
  const seen = [];
  fr.start({ from: 0, to: 1, durationMs: 10000, apply: v => seen.push(v) }, 0);
  fr.update(1); // Δ=0.0001 < 0.002 → 不回调
  assert.equal(seen.length, 0);
  fr.update(100); // Δ=0.01 ≥ eps → 回调
  assert.equal(seen.length, 1);
});

test('fade：零时长/同值直达（立即 apply+onDone，不进活动集）', () => {
  const fr = createFadeRunner();
  const seen = [];
  fr.start({ from: 0.3, to: 0.9, durationMs: 0, apply: v => seen.push(v) }, 0);
  assert.deepEqual(seen, [0.9]);
  assert.equal(fr.count(), 0);
  fr.start({ from: 0.5, to: 0.5, durationMs: 100, apply: v => seen.push(v) }, 0);
  assert.deepEqual(seen, [0.9, 0.5]);
});

test('fade：cancel(jumpTo) 跳值不回调 onDone；cancel(null) 静默移除', () => {
  const fr = createFadeRunner();
  const seen = [];
  let done = 0;
  const h = fr.start({ from: 0, to: 1, durationMs: 100, apply: v => seen.push(v), onDone: () => done++ }, 0);
  h.cancel(0.7);
  assert.deepEqual(seen, [0.7]);
  assert.equal(done, 0);
  assert.equal(fr.count(), 0);
  fr.update(1000); // 已取消：不再有任何动作
  assert.deepEqual(seen, [0.7]);
  const h2 = fr.start({ from: 0, to: 1, durationMs: 100, apply: v => seen.push(v) }, 0);
  h2.cancel(null);
  fr.update(1000);
  assert.deepEqual(seen, [0.7]);
});

test('persist() 全量写回四键（设置面板“保存”兜底路径）', () => {
  const st = memStorage();
  const vs = createVolumeState(st);
  vs.setMaster(0.6); vs.setMuted(true); vs.setChannelEnabled('sfx', false);
  st.map.clear();
  assert.equal(vs.persist(), true);
  assert.equal(st.map.get(MASTER_KEY), '0.6');
  assert.equal(st.map.get(MUTED_KEY), '1');
  assert.deepEqual(st.map.get(CHANNEL_KEYS.sfx), JSON.stringify([false, 1]));
});
