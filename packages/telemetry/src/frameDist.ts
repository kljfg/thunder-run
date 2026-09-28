/**
 * 局内帧分布收集器（spec §4.2）：run 主循环逐帧 frameTime(dt) 入桶、零逐帧事件，
 * 收尾/快照时产出 FrameDistPayload。常驻 O(1) 内存（number[12] + 4 个标量）。
 */
import type { FrameDistPayload } from './types.js';
import {
  FRAME_BUCKET_COUNT, LONG_FRAME_MS, accumulateFrameBucket, newFrameBuckets, percentileFromBuckets,
} from './buckets.js';

export interface FrameDistTracker {
  /** 逐帧调用（rAF 时间戳差分 ms）；O(1) 零分配。 */
  add(frameMs: number): void;
  /** 当前帧数。 */
  frames(): number;
  /** 产出规范 payload（buckets 为快照拷贝，可安全入信封）；frames=0 时 p50/p95/worst 均 0。 */
  payload(runId: string, scene: FrameDistPayload['scene'], cumulative?: boolean): FrameDistPayload;
  /** 清零（新一局/新快照周期开始）。 */
  reset(): void;
}

export function createFrameDistTracker(): FrameDistTracker {
  const buckets = newFrameBuckets();
  let frames = 0;
  let longCount = 0;
  let worstMs = 0;

  return {
    add(frameMs: number): void {
      accumulateFrameBucket(buckets, frameMs);
      frames++;
      if (frameMs > LONG_FRAME_MS) longCount++;
      if (frameMs > worstMs) worstMs = frameMs;
    },
    frames: () => frames,
    payload(runId, scene, cumulative) {
      const p50 = percentileFromBuckets(50, frames, buckets);
      const p95 = percentileFromBuckets(95, frames, buckets);
      const r2 = (v: number) => +v.toFixed(2);
      const out: FrameDistPayload = {
        runId,
        scene,
        frames,
        buckets: buckets.slice(),
        p50Ms: r2(p50.ms),
        p95Ms: r2(p95.ms),
        longCount,
        worstMs: r2(worstMs),
      };
      if (p95.approx) out.p95Approx = true;
      if (cumulative) out.cumulative = true;
      return out;
    },
    reset(): void {
      buckets.fill(0);
      frames = 0;
      longCount = 0;
      worstMs = 0;
    },
  };
}

/** FrameDistPayload → perf.frameDist 事件 fields（buckets 走 metric val，fields 只收标量，spec §2）。 */
export function frameDistFields(p: FrameDistPayload): Record<string, string | number | boolean> {
  const f: Record<string, string | number | boolean> = {
    runId: p.runId, scene: p.scene, frames: p.frames,
    p50Ms: p.p50Ms, p95Ms: p.p95Ms, longCount: p.longCount, worstMs: p.worstMs,
  };
  if (p.p95Approx !== undefined) f.p95Approx = p.p95Approx;
  if (p.cumulative !== undefined) f.cumulative = p.cumulative;
  return f;
}

/** 桶计数总长度自检（测试/服务端对拍用）。 */
export const FRAME_DIST_BUCKET_LEN = FRAME_BUCKET_COUNT;
