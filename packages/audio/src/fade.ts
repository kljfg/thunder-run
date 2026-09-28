/**
 * 线性淡变调度器（S17）：引擎 update() 手动泵（宿主接 adapter.requestFrame 或定时器；
 * 单测用假时钟推演）。淡变操作的是声部**原始电平**（0..1），最终音量=原始电平×通道增益，
 * 所以静音/音量滑杆改变时无需重建淡变，refresh 即可正确合成。
 * 步进合并：仅当电平变化 ≥ FADE_EPS 或淡变收尾时回调 apply，避免每帧无谓的 setVolume
 * （wx 侧 setVolume 是 JS→native 桥调用，省一步是一步）。
 */

export interface FadeSpec {
  from: number;
  to: number;
  durationMs: number;
  /** 每个有效步进回调（含终点值）。 */
  apply(v: number): void;
  /** 自然到达 to 后回调（被 cancel 则不回调）。 */
  onDone?(): void;
}

export interface FadeHandle {
  cancel(jumpTo: number | null): void;
}

const FADE_EPS = 0.002;

interface ActiveFade extends FadeSpec { startMs: number; last: number; cancelled: boolean; }

export interface FadeRunner {
  /** 同一声部重复 start：先取消旧淡变（跳变语义由调用方定，这里只保证唯一生效）。 */
  start(spec: FadeSpec, nowMs: number): FadeHandle;
  update(nowMs: number): void;
  count(): number;
}

export function createFadeRunner(): FadeRunner {
  const fades = new Set<ActiveFade>();

  return {
    start(spec, nowMs) {
      const dur = Math.max(0, spec.durationMs);
      const f: ActiveFade = { ...spec, startMs: nowMs, last: spec.from, cancelled: false };
      if (dur === 0 || spec.from === spec.to) { // 无时长：直接到位（不等下一拍）
        f.apply(f.to);
        f.onDone?.();
        return { cancel: () => {} };
      }
      fades.add(f);
      return {
        cancel(jumpTo) {
          if (f.cancelled) return;
          f.cancelled = true;
          fades.delete(f);
          if (jumpTo !== null) f.apply(jumpTo);
        },
      };
    },

    update(nowMs) {
      for (const f of [...fades]) {
        const t = Math.min(1, (nowMs - f.startMs) / Math.max(1, f.durationMs));
        const v = f.from + (f.to - f.from) * t;
        if (t >= 1 || Math.abs(v - f.last) >= FADE_EPS) {
          f.last = v;
          f.apply(t >= 1 ? f.to : v); // 尾帧吸附到精确终点值
        }
        if (t >= 1) {
          fades.delete(f);
          f.onDone?.();
        }
      }
    },

    count: () => fades.size,
  };
}
