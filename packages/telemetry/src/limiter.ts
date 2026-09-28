/**
 * 限流与自监控丢弃聚合（spec §3.3/§4.7）：固定 60s 窗口、按 name 计数 + 全局字节预算。
 * dropped 事件自身豁免限流、每 (reason,name) 每窗口 ≤1 条：重复丢弃只累加已入队信封的 count
 * （信封在 flush 前可变——「更新同一条」语义；flush 后至窗口结束的计数随窗口清零，至多一次哲学）。
 * 纯逻辑：时钟经 now() 注入，无定时器（窗口惰性翻转）。
 */
import type { DropReason, Fields } from './types.js';

/** 固定窗口长度（ms，spec §3.3）。 */
export const RATE_WINDOW_MS = 60000;

interface NameWindow { start: number; count: number }
interface BytesWindow { start: number; bytes: number }
interface DropEntry { start: number; count: number; live: { count: number } | null }

export interface RateLimiter {
  /** 按 name 计数窗口：超限返回 false（调用方随后调 recordDrop('rate', name)）。 */
  allowName(name: string, now: number): boolean;
  /** 全局字节预算：本窗口累计超 maxBytesPerMin 返回 false（→ recordDrop('bytes')）。 */
  allowBytes(bytes: number, now: number): boolean;
  /**
   * 聚合一次丢弃：返回需要新入队的 dropped fields（本窗口首条），
   * 或 null（已有在队/已发的本窗口 dropped 事件，计数已就地并入）。
   */
  recordDrop(reason: DropReason, name: string | undefined, count: number, now: number): Fields | null;
  /** 把一个在队 dropped 信封的活引用登记进聚合表（供后续 recordDrop 就地更新 count）。 */
  attachLive(reason: DropReason, name: string | undefined, live: { count: number }): void;
  /** 信封离队（已序列化发出/被丢）后解除活引用，避免改动已发数据与环缓冲快照。 */
  detachLive(reason: DropReason, name: string | undefined): void;
  /** 窗口翻转检查（测试断言用）。 */
  windowMs(): number;
}

export function createRateLimiter(perNamePerMin: number, maxBytesPerMin: number): RateLimiter {
  const names = new Map<string, NameWindow>();
  let bytesWin: BytesWindow = { start: 0, bytes: 0 };
  const drops = new Map<string, DropEntry>();

  const dropKey = (reason: DropReason, name: string | undefined) => `${reason}\u0000${name ?? ''}`;

  return {
    allowName(name, now) {
      let w = names.get(name);
      if (!w || now - w.start >= RATE_WINDOW_MS) {
        w = { start: now, count: 0 };
        names.set(name, w);
      }
      w.count++;
      return w.count <= perNamePerMin;
    },
    allowBytes(bytes, now) {
      if (bytesWin.start === 0 || now - bytesWin.start >= RATE_WINDOW_MS) bytesWin = { start: now, bytes: 0 };
      bytesWin.bytes += bytes;
      return bytesWin.bytes <= maxBytesPerMin;
    },
    recordDrop(reason, name, count, now) {
      const key = dropKey(reason, name);
      let e = drops.get(key);
      if (!e || now - e.start >= RATE_WINDOW_MS) {
        // 新窗口：产出首条 dropped fields（调用方入队后 attachLive）
        drops.set(key, { start: now, count, live: null });
        const f: Fields = { reason, count };
        if (name !== undefined) f.name = name;
        return f;
      }
      e.count += count;
      if (e.live) e.live.count = e.count; // 就地更新在队信封
      return null;
    },
    attachLive(reason, name, live) {
      const e = drops.get(dropKey(reason, name));
      if (e) e.live = live;
    },
    detachLive(reason, name) {
      const e = drops.get(dropKey(reason, name));
      if (e) e.live = null;
    },
    windowMs: () => RATE_WINDOW_MS,
  };
}
