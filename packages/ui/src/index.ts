/**
 * @tr/ui 公共出口（S13 内核 + S4 渲染框架）。
 * 内核契约见 packages/ui/API.md；模块划分与 spike/ui-layout 原样一致（types/layout/hit/router/scroll/button/virtualList）。
 * 禁令：本包不得 import platform-web/platform-wx，不得触碰 DOM 全局（tools/check-import-rules.mjs 强制）。
 */

// ---- S13 纯逻辑内核 ----
export * from './types.js';
export * from './layout.js';
export * from './hit.js';
export * from './router.js';
export * from './scroll.js';
export * from './button.js';
export * from './virtualList.js';

// ---- 配置 / 资源 / 主题 ----
export * from './uiConfig.js';
export * from './resources.js';
export * from './theme.js';
export * from './paint.js';

// ---- 文本栈 ----
export * from './text/metrics.js';
export * from './text/layoutText.js';
export * from './text/sdf.js';
export * from './text/textMesh.js';

// ---- 渲染基元 ----
export * from './render/skinTexture.js';
export * from './render/ninePatch.js';
export * from './render/clip.js';

// ---- 控件与装配 ----
export * from './widget.js';
export * from './widgets/box.js';
export * from './widgets/panel.js';
export * from './widgets/label.js';
export * from './widgets/button.js';
export * from './widgets/scrollView.js';
export * from './widgets/list.js';
export * from './view.js';
export * from './overlay.js';
export * from './input/gestureAdapter.js';
