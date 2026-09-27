/**
 * 路线 A 入口：官方 weapp-adapter + three 必需补丁（见 adapter-patch.js 的 P1/P2/P3）。
 */
import '../vendor/weapp-adapter.js'; // 注入 window/document/Image/canvas 等全局垫片
import * as THREE from 'three';
import { patchAdapterForThree } from './adapter-patch.js';
import { boot } from './main.js';

patchAdapterForThree();

const info = wx.getSystemInfoSync();
// adapter 注入后，全局 canvas 即上屏画布（adapter 内部 wx.createCanvas() 首调）
boot({
  routeName: 'A',
  canvas, // 全局 canvas（来自 weapp-adapter）
  dpr: info.pixelRatio,
  width: info.windowWidth,
  height: info.windowHeight,
  platform: info.platform,
  benchmarkLevel: info.benchmarkLevel,
  // 路线 A 卖点验证：打完补丁后官方 loader 链（TextureLoader→ImageLoader）应可用
  makePlaneTexture: () => {
    const loader = new THREE.TextureLoader();
    return loader.load(
      'assets/tex.png',
      (t) => console.log('[spike:A] TextureLoader onLoad ok', t.image.width + 'x' + t.image.height),
      undefined,
      (e) => console.error('[spike:A] TextureLoader onError（记录进坑清单）', e && e.message ? e.message : e)
    );
  },
});
