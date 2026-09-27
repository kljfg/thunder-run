/**
 * wx 纹理加载（两条路线共用的稳妥路径）。
 *
 * 为什么不直接用 THREE.TextureLoader：
 * - TextureLoader → ImageLoader → document.createElementNS('img')（three.module.js:43916）
 *   + image.addEventListener('load')。wx 原生 wx.createImage() 只有 onload/onerror 属性，
 *   没有 addEventListener；官方 weapp-adapter 也没有 document.createElementNS。
 * - 所以路线 B（无 document）必须走本函数；路线 A 打了补丁后 TextureLoader 可用，
 *   但本函数在 A 下同样工作，作为兜底/对照。
 *
 * 用法：loadWxTexture(THREE, 'assets/tex.png')，同步返回 THREE.Texture，
 * 图片解码完成后自动 needsUpdate=true（首帧可能短暂无贴图，属预期）。
 */
export function loadWxTexture(THREE, path, hooks = {}) {
  const img = wx.createImage();
  const tex = new THREE.Texture(img);
  tex.colorSpace = THREE.SRGBColorSpace;

  img.onload = () => {
    tex.needsUpdate = true;
    console.log('[spike:tex] loaded', path, img.width + 'x' + img.height);
    if (hooks.onLoad) hooks.onLoad(tex);
  };
  img.onerror = (err) => {
    console.error('[spike:tex] load FAILED', path, err);
    if (hooks.onError) hooks.onError(err);
  };
  img.src = path; // 代码包内相对路径；也支持网络 URL（需 downloadFile 域名白名单）
  return tex;
}
