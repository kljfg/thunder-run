/**
 * @tr/platform-wx —— PlatformAdapter v2 的微信小游戏实现（S3 落地）。
 * 禁令地位：全项目唯一允许触碰 `wx` 全局的包（apps/wx 入口垫片除外，check-import-rules R5）。
 * 垫片按 S11 路线 B（自写最小垫片）正式化：见 shim.ts 头注释与 docs/platform-adapter-v2.md §4。
 */
export { createWxAdapter } from './wxPlatform.js';
export type { WxAdapterOptions } from './wxPlatform.js';
export { installCanvasShim, getContext } from './shim.js';
export type { CanvasShimHandle } from './shim.js';
export { getWx } from './wxTypes.js';
export type { WxLike, WxRawCanvas, WxTouchEvent, WxTouch } from './wxTypes.js';
export { createWxStorage } from './storage.js';
export { wxFetchJson, wxReadJson, wxReadBinary } from './network.js';
export { createWxExtras } from './extras.js';
export { createWxCanvasFactory } from './canvasFactory.js';
export { createWxInput } from './input.js';
