/**
 * 固定步长 60fps 循环（纯逻辑，无 wx/three 依赖，可 node 单测）。
 *
 * 设计：累加器（accumulator）模式——渲染帧率与逻辑步长解耦：
 * - 每帧把真实经过时间累加进 acc，按固定 step 消费，保证模拟确定性；
 * - maxFrameDt 钳制单帧最大时间（切后台回来/卡顿后不追帧，防"死亡螺旋"）；
 * - maxStepsPerFrame 是第二道保险；
 * - onStats 每秒回调一次，携带 fps/sps（steps per second）快照，用于性能基线打点。
 */
export function createFixedStepLoop(options) {
  const {
    step = 1 / 60,
    maxFrameDt = 0.25,
    maxStepsPerFrame = 15,
    now,
    requestFrame,
    cancelFrame,
    update,
    render,
    onStats,
  } = options;

  let running = false;
  let frameHandle = null;
  let lastMs = null; // null = 未初始化（0 是合法时间戳，不能当哨兵）
  let acc = 0;
  let clampedFrames = 0;

  const stats = {
    frames: 0,
    steps: 0,
    startedAt: 0,
    windowStart: 0,
    windowFrames: 0,
    windowSteps: 0,
    fps: 0,
    sps: 0,
    clampedFrames: 0,
  };

  function emitStats(t) {
    const elapsed = t - stats.windowStart;
    if (elapsed >= 1000) {
      stats.fps = Math.round((stats.windowFrames * 1000) / elapsed);
      stats.sps = Math.round((stats.windowSteps * 1000) / elapsed);
      stats.windowStart = t;
      stats.windowFrames = 0;
      stats.windowSteps = 0;
      if (onStats) onStats({ ...stats });
    }
  }

  function frame() {
    const t = now();
    if (lastMs === null) lastMs = t;
    let dtSec = (t - lastMs) / 1000;
    lastMs = t;
    if (!(dtSec > 0)) dtSec = 0;
    if (dtSec > maxFrameDt) {
      dtSec = maxFrameDt;
      clampedFrames++;
      stats.clampedFrames = clampedFrames;
    }
    acc += dtSec;

    let guard = 0;
    while (acc >= step && guard < maxStepsPerFrame) {
      update(step, stats.steps);
      acc -= step;
      stats.steps++;
      guard++;
    }
    if (acc > step * maxStepsPerFrame) acc = 0; // 保险丝后丢弃积压

    render(dtSec, stats);
    stats.frames++;
    stats.windowFrames++;
    stats.windowSteps += guard;
    emitStats(t);

    if (running) frameHandle = requestFrame(frame);
  }

  return {
    start() {
      if (running) return;
      running = true;
      acc = 0;
      stats.startedAt = now();
      lastMs = stats.startedAt; // 时间基准在 start 建立，首帧不丢时间
      stats.windowStart = stats.startedAt;
      frameHandle = requestFrame(frame);
    },
    stop() {
      running = false;
      if (frameHandle != null && cancelFrame) cancelFrame(frameHandle);
      frameHandle = null;
    },
    getStats() {
      return { ...stats };
    },
    // 暴露给测试/探针：手动驱动一帧（不经过 requestFrame）
    tick() {
      frame();
    },
    isRunning() {
      return running;
    },
  };
}
