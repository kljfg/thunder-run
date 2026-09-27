/**
 * 角色本体与挂件（docs/05 §3 角色规格；正式模型在 M4 T4.2 替换占位方块）
 * 只读 sim 状态做表现，不反写玩法数据（docs/02 §5 单向数据流）。
 */
import * as THREE from 'three';
import type { RunnerState } from '../core/sim/simTypes.js';
import type { FxState } from '../core/effects/buffEngine.js';

/** 滑铲姿态的插值速度（每帧逼近目标的比例，越大越"硬"） */
const POSE_LERP = 0.35;
/** 无敌期自发光强度（闪烁高值 / 平时基线） */
const GLOW_ON = 1.2, GLOW_OFF = 0.55, GLOW_BLINK = 0.2;

export interface AvatarColors { tint: string; flashColor: string }

export function createAvatar(scene: THREE.Scene, laneWidth: number, colors: AvatarColors) {
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(colors.tint), emissive: new THREE.Color(colors.flashColor),
    emissiveIntensity: GLOW_OFF, roughness: 0.4,
  });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.6, 0.8), material);
  scene.add(mesh);

  // 喷气背包 + 火焰（飞行期）
  const jetGroup = new THREE.Group();
  const jetBody = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.5, 0.16), new THREE.MeshStandardMaterial({ color: 0x39476b, roughness: 0.4, metalness: 0.3 }));
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.42, 10), new THREE.MeshBasicMaterial({ color: 0x9fdcff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending }));
  flame.rotation.x = Math.PI;
  flame.position.y = -0.42;
  jetGroup.add(jetBody, flame);
  jetGroup.visible = false;
  scene.add(jetGroup);

  // 头盔罩（lifeAdd 原语）
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.5, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0xffd84d, metalness: 0.4, roughness: 0.3, transparent: true, opacity: 0.9 }));
  helmet.visible = false;
  scene.add(helmet);

  // 护盾罩（shieldAdd 原语；层数>0 时显示，破碎即隐藏）
  const shieldOrb = new THREE.Mesh(new THREE.SphereGeometry(1.15, 16, 12),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(colors.tint), transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending }));
  shieldOrb.visible = false;
  scene.add(shieldOrb);

  let poseBlend = 0; // 滑铲姿态的插值状态

  return {
    mesh,
    update(s: RunnerState, fx: FxState) {
      mesh.position.x = s.x;
      poseBlend += ((s.sliding ? 1 : 0) - poseBlend) * POSE_LERP;
      mesh.scale.y = 1 - 0.55 * poseBlend;
      mesh.position.y = 0.8 * mesh.scale.y + s.y;
      mesh.rotation.x = s.alive ? (fx.flyT > 0 ? 0.5 : s.gliding ? 0.32 : 0.55 * poseBlend) : s.topple;
      mesh.rotation.z = (s.lane * laneWidth - s.x) * -0.08;

      jetGroup.visible = fx.flyT > 0;
      if (jetGroup.visible) {
        jetGroup.position.set(mesh.position.x, mesh.position.y + 0.12, mesh.position.z + 0.5);
        const fs = 0.7 + Math.sin(s.t * 22) * 0.18;
        flame.scale.set(fs, 0.7 + fs * 0.35, fs);
      }
      helmet.visible = fx.helmetT > 0;
      if (helmet.visible) helmet.position.set(mesh.position.x, mesh.position.y + 0.72 * mesh.scale.y, mesh.position.z);

      shieldOrb.visible = fx.shieldLayers > 0;
      if (shieldOrb.visible) {
        shieldOrb.position.set(mesh.position.x, mesh.position.y, mesh.position.z);
        shieldOrb.scale.setScalar(1 + 0.04 * Math.sin(s.t * 6)); // 缓慢呼吸感
      }
      // 无敌期闪烁（受击反馈与 invincible 原语共用同一路表现）
      const glow = s.invulnT > 0 || fx.invincible;
      material.emissiveIntensity = glow ? (Math.sin(s.t * 30) > 0 ? GLOW_ON : GLOW_BLINK) : GLOW_OFF;
    },
  };
}
