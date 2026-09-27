/**
 * 固定步长循环单测（纯 node，无 wx/three）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFixedStepLoop } from '../src/fixedStep.js';

function makeClock(startMs = 0) {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
    get: () => t,
  };
}

test('60fps 节奏：每帧恰好一个 1/60 步', () => {
  const clock = makeClock();
  let updates = 0;
  const loop = createFixedStepLoop({
    now: clock.now,
    requestFrame: () => 0,
    update: (dt) => { updates++; assert.ok(Math.abs(dt - 1 / 60) < 1e-12); },
    render: () => {},
  });
  loop.start(); // 时间基准建立；fake requestFrame 不自动执行帧
  for (let i = 0; i < 60; i++) {
    clock.advance(1000 / 60);
    loop.tick();
  }
  // 浮点累加残差：acc 可能差 ~1e-16 不够第 60 步（残差留在累加器，长跑必然补回），
  // 不变量是「误差不超过 1 步、绝不超发」
  assert.ok(updates === 59 || updates === 60, 'steps=' + updates);
  assert.equal(loop.getStats().steps, updates);
  assert.equal(loop.getStats().frames, 60);
  // 长跑：600 帧后平均步长收敛到 1/60（残差 ≤ 1 步）
  for (let i = 0; i < 540; i++) {
    clock.advance(1000 / 60);
    loop.tick();
  }
  const long = loop.getStats().steps;
  assert.ok(Math.abs(long - 600) <= 1, 'long-run steps=' + long);
});

test('低帧率追步：50ms 节奏每帧补 3 步', () => {
  const clock = makeClock();
  const loop = createFixedStepLoop({
    now: clock.now,
    requestFrame: () => 0,
    update: () => {},
    render: () => {},
  });
  loop.start();
  for (let i = 0; i < 10; i++) {
    clock.advance(50);
    loop.tick();
  }
  assert.equal(loop.getStats().steps, 30);
});

test('大跳帧被 maxFrameDt 钳制（切后台回来不追帧）', () => {
  const clock = makeClock();
  const loop = createFixedStepLoop({
    now: clock.now,
    requestFrame: () => 0,
    update: () => {},
    render: () => {},
  });
  loop.start();
  clock.advance(5000); // 5 秒大跳
  loop.tick();
  const s = loop.getStats();
  assert.equal(s.steps, 15); // 0.25s * 60 = 15，且 = maxStepsPerFrame
  assert.equal(s.clampedFrames, 1);
});

test('确定性：不同帧节奏下模拟时间一致', () => {
  const run = (frameMs, frames) => {
    const clock = makeClock();
    let simTime = 0;
    const loop = createFixedStepLoop({
      now: clock.now,
      requestFrame: () => 0,
      update: (dt) => { simTime += dt; },
      render: () => {},
    });
    loop.start();
    for (let i = 0; i < frames; i++) {
      clock.advance(frameMs);
      loop.tick();
    }
    return simTime;
  };
  const a = run(10, 100);  // 1000ms
  const b = run(25, 40);   // 1000ms
  assert.ok(Math.abs(a - b) < 1e-9, `simTime 应一致: ${a} vs ${b}`);
  assert.ok(Math.abs(a - 1.0) < 1 / 60, '1 秒 ≈ 60 步');
});

test('onStats 每秒回调并给出 fps/sps', () => {
  const clock = makeClock();
  const statSnaps = [];
  const loop = createFixedStepLoop({
    now: clock.now,
    requestFrame: () => 0,
    update: () => {},
    render: () => {},
    onStats: (s) => statSnaps.push(s),
  });
  loop.start();
  for (let i = 0; i < 60; i++) {
    clock.advance(17); // 整数毫秒，避开 1000/60 浮点累计误差影响窗口判定
    loop.tick();
  }
  assert.ok(statSnaps.length >= 1, '应至少回调一次');
  const last = statSnaps[statSnaps.length - 1];
  assert.ok(last.fps >= 55 && last.fps <= 65, 'fps≈60，实际 ' + last.fps);
  assert.ok(last.sps >= 55 && last.sps <= 65, 'sps≈60，实际 ' + last.sps);
});

test('start/stop：stop 后 requestFrame 不再续帧', () => {
  const clock = makeClock();
  let pending = null;
  let rafCount = 0;
  const loop = createFixedStepLoop({
    now: clock.now,
    requestFrame: (cb) => { rafCount++; pending = cb; return rafCount; },
    cancelFrame: (h) => { assert.equal(h, rafCount); },
    update: () => {},
    render: () => {},
  });
  loop.start();
  assert.ok(loop.isRunning());
  loop.stop();
  assert.ok(!loop.isRunning());
  const before = rafCount;
  clock.advance(16);
  if (pending) pending(); // stop 前排队的帧仍可执行一次，但不再续帧
  assert.equal(rafCount, before, 'stop 后不应再 requestFrame');
});
