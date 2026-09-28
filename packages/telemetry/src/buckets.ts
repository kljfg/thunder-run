/**
 * 帧时间分桶规范常量与百分位（spec §4.2/D6；S19b perf bench 只 import 本文件）。
 *
 * 桶定义（12 桶，FRAME_BUCKET_COUNT）：
 * - 桶 0        = frameMs < 0（异常哨兵，正常计时恒空；NaN 也归此桶）
 * - 桶 1..10    = [EDGES[i-1], EDGES[i])，即 [0,4) [4,8) [8,12) [12,16) [16,20) [20,25) [25,33) [33,50) [50,100) [100,200)
 * - 桶 11       = [200, ∞) 溢出桶（卡顿/冻结；百分位插值按 FRAME_OVERFLOW_CAP_MS 封顶）
 * 注：spec §4.2 的边界列表字面上是 11 个区间，与草案钉死的 FRAME_BUCKET_COUNT=12 差一；
 * 定稿按「12 桶 + 末桶 >200ms 溢出」的双重硬约束取哨兵桶方案（偏差清单 #6，服务端/S19b 以本注释为准）。
 *
 * p50/p95 规范定义（spec §4.2）：桶计数展开，nearest-rank 取 ceil(q·frames)-1 位；
 * 值 = 所在桶 [下界,上界) 按桶内均匀假设线性插值（桶内第 k 个（0 起）取 (k+0.5)/count 中点法）；
 * ∞ 桶按 400ms 封顶插值并置 approx=true。
 */

/** 桶边界（左闭右开下界，ms）：11 个有限边界；桶 11 的下界是最后一个（200），上界 ∞。 */
export const FRAME_BUCKET_EDGES_MS: readonly number[] = [0, 4, 8, 12, 16, 20, 25, 33, 50, 100, 200];
/** 桶数（含桶 0 异常哨兵与末位 ∞ 溢出桶）。 */
export const FRAME_BUCKET_COUNT = 12;
/** ∞ 桶百分位插值封顶（approx=true 时使用的近似上界）。 */
export const FRAME_OVERFLOW_CAP_MS = 400;
/** 长帧阈值（ms）：FrameDistPayload.longCount 统计 > 该值的帧（spec §4.2）。 */
export const LONG_FRAME_MS = 50;

/** 帧时长 → 桶下标（O(边界数) 线性查找，12 桶规模下快于二分且零分支预测开销）。 */
export function bucketIndexOf(frameMs: number): number {
  if (!(frameMs >= 0)) return 0; // 负数/NaN → 异常哨兵桶
  let idx = 0; // 最后一个满足 EDGES[i] <= frameMs 的 i
  for (let i = 0; i < FRAME_BUCKET_EDGES_MS.length; i++) {
    if (frameMs >= FRAME_BUCKET_EDGES_MS[i]) idx = i;
    else break;
  }
  return idx + 1; // 桶 0 留给负值：[EDGES[i], EDGES[i+1]) → 桶 i+1
}

/** 就地累加一帧（run 主循环逐帧调用，O(1)、零分配复用数组）。 */
export function accumulateFrameBucket(buckets: number[], frameMs: number): void {
  buckets[bucketIndexOf(frameMs)]++;
}

/** 新建全零桶计数数组（FRAME_BUCKET_COUNT 长度）。 */
export function newFrameBuckets(): number[] {
  return new Array<number>(FRAME_BUCKET_COUNT).fill(0);
}

/** nearest-rank 位次（0 起）：ceil(q·frames/100)-1，钳制到 [0, frames-1]；frames=0 → 0。 */
export function percentileNearestRank(qPercent: number, frames: number): number {
  if (frames <= 0) return 0;
  return Math.min(frames - 1, Math.max(0, Math.ceil((qPercent / 100) * frames) - 1));
}

/**
 * 桶计数 → 百分位毫秒值（规范定义见文件头）。
 * @param frames 总帧数（= sum(buckets)，调用方保证一致）
 * @returns ms 与 approx（∞ 桶封顶插值时 true）
 */
export function percentileFromBuckets(
  qPercent: number, frames: number, buckets: readonly number[],
): { ms: number; approx: boolean } {
  if (frames <= 0) return { ms: 0, approx: false };
  const rank = percentileNearestRank(qPercent, frames);
  let cum = 0;
  for (let b = 0; b < buckets.length; b++) {
    const count = buckets[b];
    if (count <= 0) continue;
    if (rank < cum + count) {
      if (b === 0) return { ms: 0, approx: false }; // 异常哨兵桶：无时长语义
      const lower = b <= FRAME_BUCKET_EDGES_MS.length ? FRAME_BUCKET_EDGES_MS[b - 1] : FRAME_OVERFLOW_CAP_MS;
      const isOverflow = b === FRAME_BUCKET_COUNT - 1;
      const upper = isOverflow ? FRAME_OVERFLOW_CAP_MS : FRAME_BUCKET_EDGES_MS[b];
      const pos = rank - cum; // 桶内位次（0 起）
      const ms = lower + (upper - lower) * ((pos + 0.5) / count);
      return { ms, approx: isOverflow };
    }
    cum += count;
  }
  return { ms: 0, approx: false }; // buckets 总和 < frames 的防御分支（契约上不可达）
}
