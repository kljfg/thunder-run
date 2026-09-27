/**
 * 垫片/补丁/纹理加载的 node 单测（fake wx，无 GL）。
 * 覆盖：路线 B installMinimalShim、路线 A patchAdapterForThree（P1/P2 补丁语义）、
 * loadWxTexture 的 onload→needsUpdate 链路。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

function makeFakeImage() {
  return { width: 128, height: 128, src: '', onload: null, onerror: null, _loaded: false };
}

function installFakeWx() {
  const images = [];
  globalThis.wx = {
    getSystemInfoSync: () => ({
      platform: 'android', pixelRatio: 2.75, windowWidth: 360, windowHeight: 780,
      screenWidth: 360, screenHeight: 780, benchmarkLevel: 28,
    }),
    createCanvas: () => ({ width: 0, height: 0 }), // 裸对象：无 addEventListener（真机形态）
    createImage: () => { const img = makeFakeImage(); images.push(img); return img; },
    _images: images,
  };
  return images;
}

beforeEach(() => {
  delete globalThis.GameGlobal;
  delete globalThis.document;
  installFakeWx();
});

test('路线B：installMinimalShim 给裸 canvas 补 addEventListener 并返回环境信息', async () => {
  const { installMinimalShim } = await import('../src/shim-min.js?b1');
  const env = installMinimalShim();
  assert.equal(env.dpr, 2.75);
  assert.equal(env.width, 360);
  assert.equal(env.shimKind, 'minimal');
  assert.equal(typeof env.canvas.addEventListener, 'function');
  assert.equal(typeof env.canvas.removeEventListener, 'function');
  // three WebGLRenderer 会注册 3 个 webglcontext* 监听——收下不炸即可
  env.canvas.addEventListener('webglcontextlost', () => {}, false);
  env.canvas.addEventListener('webglcontextrestored', () => {}, false);
  env.canvas.addEventListener('webglcontextcreationerror', () => {}, false);
  assert.equal(env.canvas.__spikeListeners.get('webglcontextlost').length, 1);
});

test('路线B：installMinimalShim 不注入 window/document 全局', async () => {
  const { installMinimalShim } = await import('../src/shim-min.js?b2');
  installMinimalShim();
  assert.equal(globalThis.window, undefined);
  assert.equal(globalThis.document, undefined);
});

test('路线A：补丁提供 createElementNS，img 走 wx.createImage + 事件垫片（this===image）', async () => {
  const images = installFakeWx();
  // 模拟 adapter 注入后的形态：GameGlobal.document 只有 createElement
  const adapterDoc = { createElement: (tag) => ({ tag }) };
  globalThis.GameGlobal = { document: adapterDoc };
  const { patchAdapterForThree } = await import('../src/adapter-patch.js?a1');
  assert.equal(patchAdapterForThree(), true);
  assert.equal(typeof adapterDoc.createElementNS, 'function');

  const img = adapterDoc.createElementNS('http://www.w3.org/1999/xhtml', 'img');
  assert.equal(img, images[images.length - 1], 'img 必须来自 wx.createImage');
  assert.equal(typeof img.addEventListener, 'function');

  // three ImageLoader 语义：addEventListener('load', fn)，回调内 this === image
  let seen = null;
  img.addEventListener('load', function () { seen = this; }, false);
  img.src = 'assets/tex.png';
  assert.equal(img.src, 'assets/tex.png');
  img.onload(); // wx 运行时解码完成后触发
  assert.equal(seen, img, 'load 回调 this 必须是 image（Cache.add(url,this) 依赖）');
});

test('路线A：removeEventListener 生效；非 img 标签回落 createElement', async () => {
  const adapterDoc = { createElement: (tag) => ({ tag }) };
  globalThis.GameGlobal = { document: adapterDoc };
  const { patchAdapterForThree } = await import('../src/adapter-patch.js?a2');
  patchAdapterForThree();

  const img = adapterDoc.createElementNS(null, 'img');
  let hits = 0;
  const fn = () => { hits++; };
  img.addEventListener('load', fn);
  img.removeEventListener('load', fn);
  img.onload();
  assert.equal(hits, 0);

  const canvasEl = adapterDoc.createElementNS(null, 'canvas');
  assert.deepEqual(canvasEl, { tag: 'canvas' });
});

test('loadWxTexture：同步返回 Texture，onload 后置 needsUpdate 且 colorSpace=SRGB', async () => {
  const images = installFakeWx();
  const THREE = {
    Texture: class { constructor(image) { this.image = image; this.needsUpdate = false; this.colorSpace = ''; } },
    SRGBColorSpace: 'srgb',
  };
  const { loadWxTexture } = await import('../src/texture.js?t1');
  const tex = loadWxTexture(THREE, 'assets/tex.png');
  assert.equal(tex.image, images[0]);
  assert.equal(tex.colorSpace, 'srgb');
  assert.equal(tex.needsUpdate, false, '加载完成前不应标记上传');
  images[0].width = 128; images[0].height = 128;
  images[0].onload();
  assert.equal(tex.needsUpdate, true);
});

test('loadWxTexture：onerror 走 hooks.onError 且不置 needsUpdate', async () => {
  const images = installFakeWx();
  const THREE = {
    Texture: class { constructor(image) { this.image = image; this.needsUpdate = false; this.colorSpace = ''; } },
    SRGBColorSpace: 'srgb',
  };
  const { loadWxTexture } = await import('../src/texture.js?t2');
  let errSeen = null;
  const tex = loadWxTexture(THREE, 'assets/missing.png', { onError: (e) => { errSeen = e; } });
  images[0].onerror({ errMsg: 'fail' });
  assert.deepEqual(errSeen, { errMsg: 'fail' });
  assert.equal(tex.needsUpdate, false);
});
