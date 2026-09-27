/**
 * 路线 A 补丁：让官方 weapp-adapter 能喂饱 three r160 的 TextureLoader。
 *
 * 官方 adapter（vendor/weapp-adapter.js，源自 wechat-miniprogram/minigame-demo）实测缺口：
 *
 * P1. adapter 的 document 只有 createElement，没有 createElementNS。
 *     three 的 ImageLoader 走 document.createElementNS('img')（three.module.js:43916
 *     → :1543），直接 TypeError: document.createElementNS is not a function。
 *
 * P2. adapter 的 Image() 直接 return wx.createImage()（vendor 内 module 11），
 *     裸 wx Image 只有 onload/onerror 属性，没有 addEventListener/removeEventListener。
 *     three r160 ImageLoader 用 image.addEventListener('load'/'error')（:43944-43945），
 *     且回调依赖 this === image（Cache.add(url, this)）。
 *
 * P3.（devtools 特有）开发者工具模拟器里存在真 DOM window/document，adapter 走
 *     defineProperty 分支且只覆盖"可配置"的属性；three 里的裸标识符 document 会解析到
 *     **真 DOM document** 而不是 adapter 的假 document。所以补丁必须直接改"运行时
 *     实际解析到的那个 document"，并对 img 强制返回 wx.createImage() 包装，
 *     否则 devtools 里会创建真 DOM <img>，其相对路径 src 指向不了代码包文件。
 *
 * 真机上 adapter 走 GameGlobal 注入分支，裸 document === adapter document，
 * 本补丁同样生效（改的是同一个对象）。
 */

function addImageEventShim(img) {
  const handlers = { load: [], error: [] };
  img.addEventListener = (type, fn) => {
    if (handlers[type]) handlers[type].push(fn);
  };
  img.removeEventListener = (type, fn) => {
    if (handlers[type]) handlers[type] = handlers[type].filter((f) => f !== fn);
  };
  const fire = (type, ev) => {
    const e = ev || { type, target: img };
    // three 的回调依赖 this === image，必须 call(img)
    handlers[type].forEach((fn) => fn.call(img, e));
  };
  img.onload = (ev) => fire('load', ev);
  img.onerror = (ev) => fire('error', ev);
  return img;
}

function createShimImage() {
  return addImageEventShim(wx.createImage());
}

export function patchAdapterForThree() {
  const g = typeof GameGlobal !== 'undefined' ? GameGlobal : globalThis;
  const doc = g.document || (typeof document !== 'undefined' ? document : null);
  if (!doc) {
    console.warn('[spike:patchA] 找不到 document，补丁未生效');
    return false;
  }

  const origCreateElement = doc.createElement ? doc.createElement.bind(doc) : null;
  doc.createElementNS = function (ns, tag) {
    if (tag === 'img') return createShimImage(); // P2+P3：强制走 wx.createImage 包装
    if (origCreateElement) return origCreateElement(tag);
    throw new Error('[spike:patchA] createElement 不可用: ' + tag);
  };
  // 真 DOM document 场景下 createElement('img') 也会被 three 之外的代码用到，
  // 统一收口到 shim（spike 范围内可接受；platform-wx 正式实现见 README §5）
  if (origCreateElement) {
    doc.createElement = function (tag, opts) {
      if (tag === 'img') return createShimImage();
      return origCreateElement(tag, opts);
    };
  }

  console.log('[spike:patchA] weapp-adapter 补丁已生效（createElementNS + img 事件垫片）');
  return true;
}
