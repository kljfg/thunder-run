/**
 * EffectWorld 的 sim 侧实现（docs/03 §4.3 瞬时原语与飞行对世界的作用面）
 * 单独成文件的原因：这些操作要直接改动赛道实体（撞碎障碍、开空中段、插金币排），
 * 属于「引擎 → 世界」的适配层，与逐帧玩法推进（runnerSim.step）不是同一个概念。
 * deps 由 sim 构造时建一次并复用（热路径零分配）。
 */
import type { EffectWorld } from '../effects/buffEngine.js';
import type { CloudEntity, CoinEntity, ObstacleEntity, PickupEntity, TrackGen } from './trackGen.js';
import type { RunnerState, SimEvent } from './simTypes.js';

export interface FlightParams { heightM: number; speedMul: number; glideSpeedMul: number; glideS: number }

export interface SimWorldDeps {
  state: RunnerState;
  obstacles: ObstacleEntity[];
  coins: CoinEntity[];
  pickups: PickupEntity[];
  clouds: CloudEntity[];
  events: SimEvent[];
  gen: TrackGen;
  fly: FlightParams;
  /** game.json coins.spacingM：spawnCoinsRow 未显式给间距时使用 */
  coinSpacing: number;
  /** scoreAdd 原语的加分入口 */
  addBonus(points: number): void;
  /** fly 原语触发瞬间：sim 需要知道「已进入飞行」以正确衔接滑翔降落 */
  onFlightStart(): void;
}

/** 空中段长度估算系数：飞行期实际巡航速度 ≈ 30 m/s（2.5 × 地面基础速），再加滑翔距离 */
const SKY_METERS_PER_SECOND = 30;
const SKY_GLIDE_TAIL_M = 70;
/** 空中段起点对障碍的向后清扫余量（米） */
const SKY_CLEAR_SLACK_M = 4;

export function createSimWorld(d: SimWorldDeps): EffectWorld {
  let coinChainSeq = 0; // 奖励技金币排的链号，只需本局唯一
  return {
    advance: (distanceM: number) => { d.state.distance += Math.max(0, distanceM); },

    destroyObstacles: (lane, fromD, toD) => {
      let n = 0;
      for (const o of d.obstacles) {
        if (o.done || o.lane !== lane) continue;
        if (o.worldZ + o.d / 2 < fromD || o.worldZ - o.d / 2 > toD) continue;
        o.done = true;
        o.passed = true;
        d.state.nearMiss++;
        d.events.push({ type: 'nearMiss' });
        n++;
      }
      return n;
    },

    firstBlocker: (lane, fromD, toD) => {
      let best: number | null = null;
      for (const o of d.obstacles) {
        if (o.done || o.lane !== lane) continue;
        const front = o.worldZ - o.d / 2;
        if (front < fromD || front > toD) continue;
        if (best === null || front < best) best = front;
      }
      return best;
    },

    grantCoinRow: (lanes, startM, lengthM, spacingM, y) => {
      const spacing = spacingM > 0 ? spacingM : d.coinSpacing;
      const count = Math.max(0, Math.floor(lengthM / spacing));
      const id = ++coinChainSeq;
      for (const lane of lanes) {
        for (let i = 0; i < count; i++) {
          d.coins.push({ lane, worldZ: d.state.distance + startM + i * spacing, y, chain: id });
        }
      }
    },

    addBonusScore: (points: number) => { d.addBonus(Math.max(0, points)); },

    startFlight: (durationS, heightM) => {
      const s = d.state;
      s.gliding = false;
      d.onFlightStart();
      const height = heightM ?? d.fly.heightM;
      const from = s.distance + 8;
      const to = s.distance + durationS * SKY_METERS_PER_SECOND + SKY_GLIDE_TAIL_M;
      d.gen.openSky(from, to);
      // 空中段内不能有地面内容：清掉已生成的障碍与道具箱（swap-pop 保序无关）
      for (let i = d.obstacles.length - 1; i >= 0; i--) {
        const o = d.obstacles[i];
        if (o.worldZ > from - SKY_CLEAR_SLACK_M && o.worldZ < to) { d.obstacles[i] = d.obstacles[d.obstacles.length - 1]; d.obstacles.pop(); }
      }
      for (let i = d.pickups.length - 1; i >= 0; i--) {
        const p = d.pickups[i];
        if (p.worldZ > from - SKY_CLEAR_SLACK_M && p.worldZ < to) { d.pickups[i] = d.pickups[d.pickups.length - 1]; d.pickups.pop(); }
      }
      d.gen.spawnSky(from, to, height, d.coins, d.clouds);
    },
  };
}
