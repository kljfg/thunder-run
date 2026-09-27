/**
 * 路线 B 入口：自写最小垫片（shim-min.js），不注入任何 window/document 全局。
 * 纹理走 loadWxTexture（wx.createImage + THREE.Texture，main.js 默认路径）。
 */
import { installMinimalShim } from './shim-min.js';
import { boot } from './main.js';

const env = installMinimalShim();
boot({ routeName: 'B', ...env });
