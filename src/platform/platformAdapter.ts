/**
 * 平台适配层接口（唯一的平台边界，对应 docs/02 §4）
 * core / render / ui 只允许通过这里的接口访问宿主能力，
 * 禁止直接写 window / document / wx（由 tools/check-import-rules.mjs 强制检查）。
 */

/** 归一化后的手势：换道/跳跃/滑铲/点击都从这里出 */
export type Gesture =
  | { type: 'swipe'; dir: 'up' | 'down' | 'left' | 'right' }
  | { type: 'tap'; x: number; y: number }
  | { type: 'doubleTap'; x: number; y: number };

export interface CanvasHost {
  canvas: HTMLCanvasElement;
  /** CSS 像素尺寸（渲染尺寸 = 尺寸 × dpr） */
  width: number;
  height: number;
  dpr: number;
}

export interface PlatformAdapter {
  env: 'web' | 'wx';
  /** 在容器里创建画布（页面流转时由 UI 提供容器） */
  createCanvasHost(container: HTMLElement): CanvasHost;
  /** 订阅手势；返回取消订阅函数 */
  onGesture(cb: (g: Gesture) => void): () => void;
  /** 订阅键盘（按 KeyboardEvent.code，如 ArrowLeft/Space/Escape） */
  onKey(cb: (code: string) => void): () => void;
  storage: {
    get(key: string): string | null;
    set(key: string, value: string): void;
    remove(key: string): void;
  };
  fetchJson(url: string): Promise<unknown>;
  requestFrame(cb: (timeMs: number) => void): number;
  cancelFrame(handle: number): void;
  onVisibility(cb: (hidden: boolean) => void): () => void;
  now(): number;
}
