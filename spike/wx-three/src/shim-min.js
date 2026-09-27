/**
 * 路线 B：自写最小垫片。
 *
 * 原则：**不造假 window/document/navigator 全局**。three r160 对这些全部有
 * typeof 守卫（vendor/three/build/three.module.js 实测）：
 * - window.__THREE__      → typeof window 守卫（:53027）
 * - navigator.userAgent   → typeof navigator 守卫（:24000）
 * - performance.now       → typeof performance 守卫（:47162，Clock 用）
 * - WebGLRenderingContext → typeof 守卫（:28680 附近）
 * - AudioContext          → 仅音频模块，typeof window 守卫
 *
 * WebGLRenderer 对传入 canvas 的真实要求（:28644-28652）：
 * 1. canvas.getContext('webgl2'|'webgl'|'experimental-webgl', attrs)
 * 2. canvas.addEventListener/removeEventListener（webglcontextlost 等 3 个事件）
 * 3. canvas.width/height 可写
 * 4. 'setAttribute' in canvas === false 时自动跳过（:28647）
 * 5. setSize(w,h,updateStyle=false) 可完全避开 canvas.style（:28834）
 *
 * 因此最小垫片只需要：给 wx 主画布补 addEventListener/removeEventListener。
 * wx 没有 webglcontextlost 事件源，监听器收下但永不触发（见 README 坑清单 K5）。
 */
export function installMinimalShim() {
  const info = wx.getSystemInfoSync();
  const canvas = wx.createCanvas(); // 首次调用 = 上屏画布（全屏）

  if (typeof canvas.addEventListener !== 'function') {
    const listeners = new Map();
    canvas.addEventListener = (type, fn) => {
      console.log('[spike:shim] canvas.addEventListener 登记（wx 无此事件源）:', type);
      const arr = listeners.get(type) || [];
      arr.push(fn);
      listeners.set(type, arr);
    };
    canvas.removeEventListener = (type, fn) => {
      const arr = listeners.get(type);
      if (arr) listeners.set(type, arr.filter((f) => f !== fn));
    };
    canvas.__spikeListeners = listeners; // 调试用
  }

  return {
    canvas,
    dpr: info.pixelRatio,
    width: info.windowWidth,
    height: info.windowHeight,
    platform: info.platform,
    benchmarkLevel: info.benchmarkLevel,
    shimKind: 'minimal',
  };
}
