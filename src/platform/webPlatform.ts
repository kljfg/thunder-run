/**
 * 网页端平台适配实现（对应 docs/02 §4 PlatformAdapter 的 web 实现）
 * 这是全项目唯一允许直接接触 DOM/BOM API 的输入/存储出口（UI 层除外）。
 */
import type { CanvasHost, Gesture, PlatformAdapter } from './platformAdapter.js';

/** 判定为滑动的最小位移（CSS 像素）；双击窗口参数来自 game.json，先给保守默认 */
const SWIPE_MIN_PX = 24;
const DOUBLE_TAP_WINDOW_MS = 280;
const DOUBLE_TAP_MAX_DIST_PX = 40;

export function createWebPlatform(): PlatformAdapter {
  // ---------- 手势：pointerdown/up 计算位移方向；tap 与 doubleTap 叠加判定 ----------
  function bindGesture(el: HTMLElement, cb: (g: Gesture) => void): () => void {
    let downX = 0, downY = 0, downT = 0, active = false;
    let lastTapT = 0, lastTapX = 0, lastTapY = 0;

    const onDown = (e: PointerEvent) => {
      active = true; downX = e.clientX; downY = e.clientY; downT = performance.now();
    };
    const onUp = (e: PointerEvent) => {
      if (!active) return;
      active = false;
      const dx = e.clientX - downX, dy = e.clientY - downY;
      const dt = performance.now() - downT;
      if (Math.abs(dx) > SWIPE_MIN_PX || Math.abs(dy) > SWIPE_MIN_PX) {
        const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
        cb({ type: 'swipe', dir });
        return;
      }
      if (dt < 350) {
        // 先判双击（两次 tap 距离/间隔达标），否则上报单击
        const t = performance.now();
        if (t - lastTapT < DOUBLE_TAP_WINDOW_MS && Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) < DOUBLE_TAP_MAX_DIST_PX) {
          cb({ type: 'doubleTap', x: e.clientX, y: e.clientY });
          lastTapT = 0; // 消耗掉，避免三连击
        } else {
          cb({ type: 'tap', x: e.clientX, y: e.clientY });
          lastTapT = t; lastTapX = e.clientX; lastTapY = e.clientY;
        }
      }
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    return () => { el.removeEventListener('pointerdown', onDown); el.removeEventListener('pointerup', onUp); };
  }

  let gestureTarget: HTMLElement | null = null;

  return {
    env: 'web',

    createCanvasHost(container: HTMLElement): CanvasHost {
      const canvas = document.createElement('canvas');
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.display = 'block';
      container.replaceChildren(canvas);
      const rect = container.getBoundingClientRect();
      gestureTarget = container;
      return { canvas, width: Math.max(rect.width, 1), height: Math.max(rect.height, 1), dpr: Math.min(window.devicePixelRatio, 2) };
    },

    /** 手势订阅发生在画布创建之后（demo 场景）；未创建画布时订阅视为用法错误 */
    onGesture(cb) {
      if (!gestureTarget) throw new Error('先调用 createCanvasHost 再订阅手势');
      return bindGesture(gestureTarget, cb);
    },

    onKey(cb) {
      const handler = (e: KeyboardEvent) => {
        // 输入框聚焦时不拦截按键（登录页表单可正常打字）
        if ((e.target as HTMLElement | null)?.tagName === 'INPUT') return;
        cb(e.code);
      };
      window.addEventListener('keydown', handler);
      return () => window.removeEventListener('keydown', handler);
    },

    storage: {
      get: k => { try { return localStorage.getItem(k); } catch { return null; } },
      set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* 无痕模式等场景静默失败 */ } },
      remove: k => { try { localStorage.removeItem(k); } catch { /* 同上 */ } },
    },

    async fetchJson(url) {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return res.json();
    },

    requestFrame: cb => requestAnimationFrame(cb),
    cancelFrame: h => cancelAnimationFrame(h),

    onVisibility(cb) {
      const handler = () => cb(document.hidden);
      document.addEventListener('visibilitychange', handler);
      return () => document.removeEventListener('visibilitychange', handler);
    },

    now: () => performance.now(),
  };
}
