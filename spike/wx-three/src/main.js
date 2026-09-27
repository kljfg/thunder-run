/**
 * 共享场景主体（两条路线唯一区别 = 垫片与纹理来源，其余 100% 同源）。
 * 内容：旋转立方体 + 纹理平面，固定步长 60fps 循环，触摸事件打日志，
 * 每秒输出 fps/sps/drawcall/内存计数（性能基线采集点）。
 */
import * as THREE from 'three';
import { createFixedStepLoop } from './fixedStep.js';
import { loadWxTexture } from './texture.js';

const DPR_CAP = 2; // 真机 dpr 常见 2.75~3.5，不封顶填充率会爆（见 README 坑 K3）

export function boot(env) {
  const { routeName, canvas, dpr, width, height, platform, benchmarkLevel } = env;
  const tag = '[spike:' + routeName + ']';

  const dprUsed = Math.min(dpr || 1, DPR_CAP);
  console.log(tag, 'boot', JSON.stringify({
    platform, dprRaw: dpr, dprUsed, width, height,
    benchmarkLevel, threeRevision: THREE.REVISION,
  }));

  // ---- renderer：只喂 canvas，不碰 DOM ----
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(dprUsed);
  renderer.setSize(width, height, false); // updateStyle=false：避开 canvas.style（wx 无 style）
  renderer.setClearColor(0x101828, 1);
  const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined'
    && renderer.getContext() instanceof WebGL2RenderingContext;
  console.log(tag, 'context:', isWebGL2 ? 'webgl2' : 'webgl1(降级路径)',
    'drawingBuffer:', renderer.getDrawingBufferSize(new THREE.Vector2()).x + 'x' +
    renderer.getDrawingBufferSize(new THREE.Vector2()).y);

  // ---- 场景：旋转立方体 + 纹理平面 ----
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 100);
  camera.position.set(0, 1.2, 4.2);
  camera.lookAt(0, 0.3, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const dir = new THREE.DirectionalLight(0xffffff, 1.6);
  dir.position.set(2, 4, 3);
  scene.add(dir);

  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 1.2, 1.2),
    new THREE.MeshStandardMaterial({ color: 0x3f7fff, roughness: 0.4, metalness: 0.1 })
  );
  cube.position.y = 0.9;
  scene.add(cube);

  const planeTex = env.makePlaneTexture
    ? env.makePlaneTexture()
    : loadWxTexture(THREE, 'assets/tex.png');
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(2.6, 2.6),
    new THREE.MeshBasicMaterial({ map: planeTex })
  );
  plane.rotation.x = -Math.PI / 2.4;
  plane.position.set(0, -0.35, -0.6);
  scene.add(plane);

  // ---- 触摸事件打日志 ----
  const fmtTouch = (t) => '(' + Math.round(t.clientX) + ',' + Math.round(t.clientY) + ') id=' + t.identifier;
  const bindTouch = (name, reg) => reg((ev) => {
    const ts = (ev.changedTouches || []).map(fmtTouch).join(' ');
    console.log(tag, 'touch', name, 'n=' + (ev.touches ? ev.touches.length : 0), ts);
  });
  bindTouch('start', wx.onTouchStart);
  bindTouch('move', wx.onTouchMove);
  bindTouch('end', wx.onTouchEnd);
  bindTouch('cancel', wx.onTouchCancel);

  // ---- 固定步长循环 ----
  let simTime = 0;
  const loop = createFixedStepLoop({
    step: 1 / 60,
    now: () => Date.now(),
    requestFrame: (cb) => wx.requestAnimationFrame(cb),
    update: (dt) => {
      simTime += dt; // 确定性：立方体角度只由步数决定，与真实帧率无关
      cube.rotation.y = simTime * Math.PI * 0.5;
      cube.rotation.x = Math.sin(simTime * 0.8) * 0.3;
      cube.position.y = 0.9 + Math.sin(simTime * 2) * 0.12;
    },
    render: () => renderer.render(scene, camera),
    onStats: (s) => {
      const info = renderer.info;
      console.log(tag, 'stats', JSON.stringify({
        fps: s.fps, sps: s.sps, clamped: s.clampedFrames,
        calls: info.render.calls, tris: info.render.triangles,
        geo: info.memory.geometries, tex: info.memory.textures,
        programs: info.programs ? info.programs.length : -1,
      }));
    },
  });
  loop.start();

  // ---- 探针：devtools Console 里可直接 poke ----
  const api = {
    route: routeName,
    renderer, scene, camera, loop, THREE,
    stats: () => loop.getStats(),
    info: () => JSON.parse(JSON.stringify(renderer.info.render)),
    simTime: () => simTime,
    setDpr: (d) => { renderer.setPixelRatio(d); renderer.setSize(width, height, false); },
  };
  (typeof GameGlobal !== 'undefined' ? GameGlobal : globalThis).__spike = api;
  console.log(tag, 'ready. Console 可用 __spike.stats() / __spike.info()');
  return api;
}
