/**
 * 跑酷局渲染场景（render 层总装，docs/02 §5）
 * 本文件只做三件事：搭 Three.js 舞台、按固定步长推进 sim 并用插值 alpha 渲染、把事件翻成表现反馈。
 * 具体表现拆在同目录模块里：trackVisuals（道路）/ avatarRig（角色）/ coinField（金币）/
 * entityLayers（障碍·道具箱·云）/ vfxBurst（爆点）/ runDebugProbe（?debug 自动化探针）。
 * 铁律：只读 sim 状态，不反写玩法数据（单向数据流）。
 */
import * as THREE from 'three';
import { STEP_DT } from '../core/sim/simTypes.js';
import type { RunnerSim } from '../core/sim/runnerSim.js';
import type { GameContent } from '../core/config/configTypes.js';
import type { PlatformAdapter } from '../platform/platformAdapter.js';
import { createAvatar } from './avatarRig.js';
import { createCoinField } from './coinField.js';
import { createCloudLayer, createObstacleLayer, createPickupLayer } from './entityLayers.js';
import { installRunProbe } from './runDebugProbe.js';
import { createTrackVisuals } from './trackVisuals.js';
import { createBurstPool } from './vfxBurst.js';

export interface RunCallbacks {
  onHud(h: {
    score: number; coins: number; distance: number; hits: number; lives: number;
    buffs: { name: string; left: number }[];
    skill: { label: string; energy: number; cd: number; ready: boolean } | null;
  }): void;
  onEnd(summary: ReturnType<RunnerSim['summary']>): void;
  debug?: boolean;
}

/** 相机参数（docs/02 §8：跟随人物但不 1:1 抬高，否则近处地面会翻出画面下沿） */
const CAM_Z = 7.4, CAM_Y_BASE = 1.9, CAM_FOLLOW = 0.25, CAM_Y_RATIO = 0.8, LOOK_AHEAD_Z = -11;
const FOV_GROUND = 55, FOV_AIR = 60, FOV_LERP = 0.06;
/** 震屏：每帧衰减量与随机幅度 */
const SHAKE_DECAY = 1 / 60, SHAKE_AMP = 0.24;
/** 死亡后停留多久进结算页、HUD 刷新间隔（秒） */
const END_DELAY_S = 1.2, HUD_INTERVAL_S = 0.15;
/** 爆点的画面深度（角色身体前方 0.62m，胸口高度由 chestY 提供）；穿云用白色 */
const BURST_Z = -0.62, CLOUD_BURST_COLOR = 0xdfe9f5;
/** 雾视距：障碍在约 3 秒外可见（地铁酷跑式远望） */
const FOG_NEAR = 22, FOG_FAR = 120;

export function createRunnerScene(
  host: { canvas: HTMLCanvasElement; width: number; height: number; dpr: number },
  adapter: PlatformAdapter, sim: RunnerSim, content: GameContent, cb: RunCallbacks,
) {
  const runner = (content.game.params.runner ?? {}) as Record<string, number>;
  const laneWidth = runner.laneWidth ?? 2.2;
  const theme = (content.themes.items ?? []).find(t => t.id === 'theme_neon_city');
  const sky = (theme?.sky ?? { baseColor: '#0B1226', flashColor: '#9FD8FF' }) as { baseColor: string; flashColor: string };
  const tint = (theme?.vfxTint as string | undefined) ?? '#7FD1FF';
  /** buff 派生视图：引擎原地更新同一个对象，渲染层缓存引用安全（docs/09 T2.2） */
  const fx = sim.fx;

  // ---------- 舞台 ----------
  const renderer = new THREE.WebGLRenderer({ canvas: host.canvas, antialias: true });
  renderer.setPixelRatio(host.dpr);
  renderer.setSize(host.width, host.height, false);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(sky.baseColor);
  scene.fog = new THREE.Fog(sky.baseColor, FOG_NEAR, FOG_FAR);
  const camera = new THREE.PerspectiveCamera(FOV_GROUND, host.width / host.height, 0.1, 160);
  camera.position.set(0, CAM_Y_BASE, CAM_Z);
  camera.lookAt(0, 0, LOOK_AHEAD_Z);
  scene.add(new THREE.HemisphereLight(0x9fb8ff, 0x0c1020, 1.1));
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
  keyLight.position.set(3, 8, 4);
  scene.add(keyLight);

  const track = createTrackVisuals(scene, laneWidth, { baseColor: sky.baseColor, flashColor: sky.flashColor, tint });
  const avatar = createAvatar(scene, laneWidth, sim.loadout);
  const coinField = createCoinField(scene, laneWidth);
  const obstacleLayer = createObstacleLayer(scene, laneWidth);
  const pickupLayer = createPickupLayer(scene, laneWidth);
  const cloudLayer = createCloudLayer(scene);
  const bursts = createBurstPool(scene);
  /** 胸口位置缓存：爆点与吸入动画对齐到身体，而不是脚底原点 */
  let chestX = 0, chestY = avatar.chestY;
  const fireAtPlayer = () => bursts.fireAt(chestX, chestY, BURST_Z);

  // ---------- 输入 → sim ----------
  const offGesture = adapter.onGesture(g => {
    if (g.type === 'doubleTap') { sim.applyAction('skill'); return; } // 主动技能：双击屏幕（skills.json trigger=double_tap）
    if (g.type !== 'swipe') return;
    if (g.dir === 'left') sim.applyAction('laneL');
    else if (g.dir === 'right') sim.applyAction('laneR');
    else if (g.dir === 'up') sim.applyAction('jump');
    else if (g.dir === 'down') sim.applyAction('slide');
  });
  const offKey = adapter.onKey(code => {
    if (code === 'ArrowLeft') sim.applyAction('laneL');
    else if (code === 'ArrowRight') sim.applyAction('laneR');
    else if (code === 'ArrowUp' || code === 'Space') sim.applyAction('jump');
    else if (code === 'ArrowDown') sim.applyAction('slide');
    else if (code === 'KeyE' || code === 'ShiftLeft' || code === 'ShiftRight') sim.applyAction('skill');
  });

  // ---------- 主循环：固定步长推进 + 插值渲染 ----------
  let raf = 0, last = adapter.now(), acc = 0, hudTimer = 0, shakeT = 0, endTimer = -1, ended = false, running = true;
  let camY = CAM_Y_BASE, lookY = 0, camX = 0; // 相机平滑状态（初值=稳态，避免首帧俯仰跳动）

  function consumeEvents() {
    for (const ev of sim.drainEvents()) {
      if (ev.type === 'coin') fireAtPlayer();
      else if (ev.type === 'helmetSave') { fireAtPlayer(); shakeT = 0.2; } // 头盔挡刀是关键时刻，给一次反馈
      else if (ev.type === 'hit') shakeT = 0.25;
      else if (ev.type === 'death') endTimer = 0;
      // 施放技能：爆点 + 轻微震屏，拖尾/光环等完整表现在 M4 T4.4
      else if (ev.type === 'cast') { fireAtPlayer(); shakeT = 0.12; }
      else if (ev.type === 'shieldBreak' || ev.type === 'boardBreak') { fireAtPlayer(); shakeT = 0.18; }
      // pickup：按用户要求不加特效与震动，仅 HUD 显示 buff 倒计时
    }
  }

  function renderSim(alpha: number) {
    const s = sim.state;
    // 插值距离：消除固定步长与渲染帧率不同步的跳动
    const dist = s.prevDistance + (s.distance - s.prevDistance) * alpha;

    avatar.update(s, fx);
    chestX = s.x; chestY = s.y + avatar.chestY;
    coinField.update({ coins: sim.coinsArr, t: s.t, dist, magnetOn: fx.magnetT > 0, playerX: chestX, playerY: chestY });
    obstacleLayer.update(sim.obstacles, dist, s.t);
    pickupLayer.update(sim.pickupsArr, dist, s.t);
    cloudLayer.update(sim.cloudsArr, dist, s.t, s.prevDistance, chestX, fx.flyT > 0 || s.gliding,
      (x, y, z) => bursts.fireAt(x, y, z, CLOUD_BURST_COLOR));
    track.update(dist);

    // 相机：水平跟随人物，垂直只做 0.8 倍随动、注视点放远到 -11m。
    // 若 1:1 陪人物升得很高且平视近处，脚下 0~12m 的地面会整块翻出画面下沿，
    // 表现为「跳跃/飞行时看不到金币与地面障碍」；压低随动系数后近处地面始终留在画面下缘。
    shakeT = Math.max(0, shakeT - SHAKE_DECAY);
    const sk = shakeT > 0 ? (Math.random() - 0.5) * SHAKE_AMP : 0;
    camX += (s.x - camX) * CAM_FOLLOW;
    camY += (s.y * CAM_Y_RATIO + CAM_Y_BASE - camY) * CAM_FOLLOW;
    lookY += (s.y * CAM_Y_RATIO - lookY) * CAM_FOLLOW;
    camera.position.x = camX + sk;
    camera.position.y = camY + sk;
    camera.position.z = CAM_Z;
    camera.lookAt(camX, lookY, LOOK_AHEAD_Z);
    const targetFov = fx.flyT > 0 || s.gliding ? FOV_AIR : FOV_GROUND; // 空中视野略广，开阔感+速度感
    if (Math.abs(camera.fov - targetFov) > 0.1) {
      camera.fov += (targetFov - camera.fov) * FOV_LERP;
      camera.updateProjectionMatrix();
    }
    renderer.render(scene, camera);
  }

  function pushHud() {
    const s = sim.state;
    // buff 名称来自配置（items.json / skills.json 的 name），渲染层不硬编码文案
    const buffs = sim.buffList().map(b => ({ name: b.label, left: Math.ceil(b.left) }));
    if (s.gliding) buffs.push({ name: '滑翔降落', left: 1 });
    const sk = sim.loadout.skill;
    cb.onHud({
      score: s.score, coins: s.coins, distance: s.distance, hits: s.hits, lives: sim.lives, buffs,
      skill: sk ? {
        label: sk.label,
        energy: sk.energyMax > 0 ? Math.min(1, s.energy / sk.energyMax) : 1,
        cd: s.skillCd,
        ready: sim.canCastSkill(),
      } : null,
    });
  }

  function tick(nowMs: number) {
    if (!running) return;
    const dt = Math.min((nowMs - last) / 1000, 0.05);
    last = nowMs;
    acc += dt;
    while (acc >= STEP_DT) {
      sim.step();
      consumeEvents();
      acc -= STEP_DT;
    }
    bursts.update(dt, fx.magnetT > 0);
    renderSim(acc / STEP_DT);

    hudTimer += dt;
    if (hudTimer >= HUD_INTERVAL_S) { hudTimer = 0; pushHud(); }
    if (endTimer >= 0 && !ended) {
      endTimer += dt;
      if (endTimer > END_DELAY_S) { ended = true; cb.onEnd(sim.summary()); }
    }
    raf = adapter.requestFrame(tick);
  }
  raf = adapter.requestFrame(tick);

  if (cb.debug) installRunProbe(sim, () => ({ x: +camX.toFixed(2), y: +camY.toFixed(2) }), bursts,
    () => ({ calls: renderer.info.render.calls, triangles: renderer.info.render.triangles }));

  function dispose() {
    running = false;
    adapter.cancelFrame(raf);
    offGesture(); offKey();
    renderer.dispose();
    scene.traverse(o => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach(mat => mat.dispose());
    });
  }
  return { dispose };
}
