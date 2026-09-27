/**
 * 浏览器端 wx API mock（仅供 preview/ 冒烟：在无微信开发者工具时用 Edge/Chrome
 * 验证 场景+循环+纹理+触摸 代码路径；wx 真机行为差异不在此验证范围）。
 *
 * 只保证路线 B（最小垫片）忠实运行；路线 A 的 weapp-adapter 假设可重定义的
 * window 全局（真机 GameGlobal），浏览器无法忠实模拟，勿用于路线 A。
 */
(function () {
  // 先捕获原生实现，防止后续被覆盖造成递归
  const NativeImage = window.Image;
  const nativeRaf = window.requestAnimationFrame.bind(window);
  const nativeCancel = window.cancelAnimationFrame.bind(window);

  const touchRegistry = { start: [], move: [], end: [], cancel: [] };
  let mainCanvas = null;

  const dpr = 2;
  const w = window.innerWidth;
  const h = window.innerHeight;

  function makeTouch(x, y, id) {
    return { identifier: id, clientX: x, clientY: y, pageX: x, pageY: y };
  }

  window.GameGlobal = window; // 供 main.js 探针挂载 __spike

  window.wx = {
    getSystemInfoSync: () => ({
      platform: 'devtools', // 仅标识；预览环境按 devtools 行为对待
      pixelRatio: dpr,
      windowWidth: w,
      windowHeight: h,
      screenWidth: w,
      screenHeight: h,
      benchmarkLevel: 20,
      SDKVersion: '0.0.0-browser-mock',
    }),
    createCanvas: () => {
      if (mainCanvas) return document.createElement('canvas'); // 后续 = 离屏
      mainCanvas = document.createElement('canvas');
      mainCanvas.id = 'wxmain';
      mainCanvas.width = Math.floor(w * dpr);
      mainCanvas.height = Math.floor(h * dpr);
      mainCanvas.style.width = w + 'px';
      mainCanvas.style.height = h + 'px';
      document.body.appendChild(mainCanvas);
      return mainCanvas;
    },
    createImage: () => new NativeImage(),
    requestAnimationFrame: (cb) => nativeRaf(() => cb(Date.now())),
    cancelAnimationFrame: (id) => nativeCancel(id),
    onTouchStart: (fn) => touchRegistry.start.push(fn),
    onTouchMove: (fn) => touchRegistry.move.push(fn),
    onTouchEnd: (fn) => touchRegistry.end.push(fn),
    onTouchCancel: (fn) => touchRegistry.cancel.push(fn),
    onShow: () => {},
    onHide: () => {},
    onError: () => {},
    triggerGC: () => {},
    // 存储（adapter/正式 platform-wx 用；spike 主体不依赖）
    getStorageSync: () => '',
    setStorageSync: () => {},
    removeStorageSync: () => {},
    getStorageInfoSync: () => ({ keys: [], currentSize: 0, limitSize: 10240 }),
  };

  // 测试钩子：合成一次触摸（verify-browser.mjs 调用）
  window.__mockFireTouch = function (kind, x, y) {
    const ev = {
      type: 'touch' + kind,
      touches: [makeTouch(x, y, 0)],
      changedTouches: [makeTouch(x, y, 0)],
      timeStamp: Date.now(),
    };
    (touchRegistry[kind] || []).forEach((fn) => fn(ev));
  };
  window.__mockTouchCount = () =>
    Object.keys(touchRegistry).reduce((n, k) => n + touchRegistry[k].length, 0);
})();
