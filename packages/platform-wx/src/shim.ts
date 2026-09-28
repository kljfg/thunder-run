/**
 * 小游戏画布垫片（S11 路线 B「自写最小垫片」的正式化，spike/wx-three/src/shim-min.js 蓝本）。
 * 原则：**不造假 window/document/navigator 全局**——three r160 的 WebGLRenderer 显式传 canvas 时
 * 对宿主全局全部有 typeof 守卫，真实要求只有四条（spike README §1）：
 *   getContext / width·height 可写 / addEventListener+removeEventListener / 无 setAttribute。
 * 因此垫片只补两件事：
 *   1. canvas 的 addEventListener/removeEventListener（wx 无 webglcontext* 事件源，登记即可，K5）；
 *   2. style 可写空对象兜底（three 某些路径写 canvas.style，S10 D13）。
 * weapp-adapter 仅当第三方库硬依赖 DOM（如 TextureLoader：K1/K2/K3）时局部兜底引入子集，不进主链路。
 * 模块化 + 纯函数化：只接收原生画布对象返回 GLCanvas，可在 node:test 下直测。
 */
import type { ContextHandle, GLCanvas, GLContextAttributes } from '@tr/platform/platformAdapter.js';
import type { WxRawCanvas } from './wxTypes.js';

type Listener = (ev?: unknown) => void;

/** 垫片句柄：附带内部 listeners，供 K5 上下文恢复钩子未来触发/测试断言。 */
export interface CanvasShimHandle {
  gl: GLCanvas;
  /** wx 无 webglcontext* 事件源；本表登记的监听器由未来的 onHide/onShow 恢复逻辑手动 dispatch（K5 预留） */
  listeners(): ReadonlyMap<string, Listener[]>;
  dispatch(type: string, ev?: unknown): void;
}

export function installCanvasShim(raw: WxRawCanvas): CanvasShimHandle {
  const listeners = new Map<string, Listener[]>();

  if (!raw.addEventListener) {
    raw.addEventListener = (type: string, fn: Listener) => {
      const arr = listeners.get(type) ?? [];
      arr.push(fn);
      listeners.set(type, arr);
    };
  }
  if (!raw.removeEventListener) {
    raw.removeEventListener = (type: string, fn: Listener) => {
      const arr = listeners.get(type);
      if (arr) listeners.set(type, arr.filter(f => f !== fn));
    };
  }
  // three 会写 canvas.style（setSize updateStyle 分支等）；给可写空对象吞掉写入（D13）
  if (!raw.style) raw.style = {};

  const gl = raw as unknown as GLCanvas; // getContext 签名结构化兼容（string id 覆盖三个重载）
  return {
    gl,
    listeners: () => listeners,
    dispatch(type, ev) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn(ev);
    },
  };
}

/** 语义糖：从垫片取 WebGL 上下文（保留 ContextHandle 不透明性，D3）。 */
export function getContext(
  handle: CanvasShimHandle, id: 'webgl2' | 'webgl' | '2d', attrs?: GLContextAttributes,
): ContextHandle | null {
  return (handle.gl.getContext as (i: string, a?: unknown) => ContextHandle | null)(id, attrs);
}
