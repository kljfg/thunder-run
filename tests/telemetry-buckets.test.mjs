/**
 * 帧分桶与百分位测试（spec §4.2/D6 规范定义；S19b perf bench 复用同一常量与函数）。
 * 桶定义：桶0=负值/NaN 哨兵；桶1..10=[EDGES[i-1],EDGES[i])；桶11=[200,∞) 溢出（400ms 封顶插值）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FRAME_BUCKET_COUNT, FRAME_BUCKET_EDGES_MS, FRAME_OVERFLOW_CAP_MS, LONG_FRAME_MS,
  accumulateFrameBucket, bucketIndexOf, newFrameBuckets, percentileFromBuckets, percentileNearestRank,
  createFrameDistTracker, frameDistFields,
} from '../packages/telemetry/dist/index.js';

test('规范常量：12 桶、11 个有限边界、400ms 封顶、50ms 长帧线', () => {
  assert.equal(FRAME_BUCKET_COUNT, 12);
  assert.deepEqual([...FRAME_BUCKET_EDGES_MS], [0, 4, 8, 12, 16, 20, 25, 33, 50, 100, 200]);
  assert.equal(FRAME_OVERFLOW_CAP_MS, 400);
  assert.equal(LONG_FRAME_MS, 50);
  assert.equal(newFrameBuckets().length, FRAME_BUCKET_COUNT);
});

test('bucketIndexOf：边界左闭右开、哨兵桶、溢出桶', () => {
  assert.equal(bucketIndexOf(-1), 0);        // 负值 → 异常哨兵
  assert.equal(bucketIndexOf(NaN), 0);
  assert.equal(bucketIndexOf(0), 1);         // [0,4) → 桶1
  assert.equal(bucketIndexOf(3.99), 1);
  assert.equal(bucketIndexOf(4), 2);         // [4,8) → 桶2
  assert.equal(bucketIndexOf(7.999), 2);
  assert.equal(bucketIndexOf(8), 3);
  assert.equal(bucketIndexOf(16.666666), 5); // 60fps 典型帧 → [16,20) 桶5
  assert.equal(bucketIndexOf(33), 8);
  assert.equal(bucketIndexOf(49.9), 8);      // [33,50) → 桶8
  assert.equal(bucketIndexOf(50), 9);
  assert.equal(bucketIndexOf(99.9), 9);
  assert.equal(bucketIndexOf(100), 10);
  assert.equal(bucketIndexOf(199.9), 10);
  assert.equal(bucketIndexOf(200), 11);      // 溢出桶
  assert.equal(bucketIndexOf(1000), 11);
});

test('accumulateFrameBucket：就地累加零分配', () => {
  const buckets = newFrameBuckets();
  for (const dt of [16.7, 16.7, 16.7, 35, 250, -2]) accumulateFrameBucket(buckets, dt);
  assert.equal(buckets[0], 1);   // 负值 → 异常哨兵桶
  assert.equal(buckets[5], 3);   // [16,20)
  assert.equal(buckets[8], 1);   // [33,50)
  assert.equal(buckets[11], 1);  // [200,∞)
  assert.equal(buckets.reduce((a, b) => a + b, 0), 6);
});

test('percentileNearestRank：ceil(q·frames)-1，钳制边界', () => {
  assert.equal(percentileNearestRank(50, 10), 4);
  assert.equal(percentileNearestRank(95, 100), 94);
  assert.equal(percentileNearestRank(95, 20), 18);
  assert.equal(percentileNearestRank(100, 7), 6);
  assert.equal(percentileNearestRank(50, 1), 0);
  assert.equal(percentileNearestRank(50, 0), 0);
});

test('percentileFromBuckets：桶内均匀线性插值（中点法）、∞ 桶封顶并置 approx', () => {
  // 全部 120 帧落 [16,20)（桶5）：p50 位次 59 → 16 + 4·(59.5/120) ≈ 17.98
  const b = newFrameBuckets();
  b[5] = 120;
  const p50 = percentileFromBuckets(50, 120, b);
  assert.ok(Math.abs(p50.ms - (16 + 4 * (59.5 / 120))) < 1e-9);
  assert.equal(p50.approx, false);
  // 跨桶：10 帧 [0,4) + 10 帧 [100,200)：p50 位次 9 → 仍在桶1 → [0,4) 内插值
  const b2 = newFrameBuckets();
  b2[1] = 10; b2[10] = 10;
  const p50b = percentileFromBuckets(50, 20, b2);
  assert.ok(p50b.ms >= 0 && p50b.ms < 4);
  // p95 位次 18 → 桶10 [100,200)
  const p95b = percentileFromBuckets(95, 20, b2);
  assert.ok(p95b.ms >= 100 && p95b.ms < 200);
  assert.equal(p95b.approx, false);
  // ∞ 桶：p95 落桶11 → [200,400] 封顶插值，approx=true
  const b3 = newFrameBuckets();
  b3[1] = 90; b3[11] = 10;
  const p95c = percentileFromBuckets(95, 100, b3);
  assert.equal(p95c.approx, true);
  assert.ok(p95c.ms >= 200 && p95c.ms <= FRAME_OVERFLOW_CAP_MS);
  // 空/零帧
  assert.deepEqual(percentileFromBuckets(50, 0, newFrameBuckets()), { ms: 0, approx: false });
  // 哨兵桶（不可达防御）：ms=0
  const b4 = newFrameBuckets();
  b4[0] = 5;
  assert.deepEqual(percentileFromBuckets(50, 5, b4), { ms: 0, approx: false });
});

test('FrameDistTracker：逐帧入桶、longCount/worst、payload 规范形状、reset', () => {
  const tr = createFrameDistTracker();
  assert.equal(tr.frames(), 0);
  for (const dt of [10, 20, 60, 16.7]) tr.add(dt);
  assert.equal(tr.frames(), 4);
  const p = tr.payload('r1', 'run');
  assert.equal(p.runId, 'r1');
  assert.equal(p.scene, 'run');
  assert.equal(p.frames, 4);
  assert.equal(p.buckets.length, FRAME_BUCKET_COUNT);
  assert.equal(p.longCount, 1);           // 仅 60 > 50
  assert.equal(p.worstMs, 60);
  assert.ok(p.p50Ms > 0 && p.p95Ms >= p.p50Ms);
  assert.equal(p.p95Approx, undefined);
  assert.equal(p.cumulative, undefined);
  const cum = tr.payload('r1', 'run', true);
  assert.equal(cum.cumulative, true);
  tr.reset();
  assert.equal(tr.frames(), 0);
  assert.deepEqual(tr.payload('', 'menu').buckets, newFrameBuckets());
  assert.equal(tr.payload('', 'menu').worstMs, 0);
});

test('frameDistFields：只收标量（buckets 走 metric val），可选键缺省不出现', () => {
  const tr = createFrameDistTracker();
  tr.add(300); // 溢出桶 → p95Approx=true
  const f = frameDistFields(tr.payload('r2', 'run'));
  assert.equal(f.buckets, undefined);
  assert.equal(f.runId, 'r2');
  assert.equal(f.scene, 'run');
  assert.equal(f.frames, 1);
  assert.equal(f.longCount, 1);
  assert.equal(f.p95Approx, true);
  assert.equal(f.cumulative, undefined);
  for (const v of Object.values(f)) assert.ok(['string', 'number', 'boolean'].includes(typeof v));
});
