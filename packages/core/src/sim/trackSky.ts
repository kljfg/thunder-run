/**
 * 空中段（飞行器）登记与生成线闸门（trackGen 专用）：
 *   1. 飞行期间 ensure 的推进目标不得越过未关闭空段末端——越过后落地回拨会与已生成内容重叠；
 *   2. 落地收尾把空段截断并把生成线回拨，回拨只能落入「尚无内容」的区间。
 */
interface SkyZone { from: number; to: number; genZAtOpen: number; closed: boolean }

export class SkyGate {
  private readonly zones: SkyZone[] = [];

  /** 登记空中段；genZAtOpen=开段时的生成前沿（用于判断回拨安全下限） */
  open(from: number, to: number, genZAtOpen: number) {
    this.zones.push({ from, to, genZAtOpen, closed: false });
  }

  /** genZ 是否落在空段内（含起段前的清扫余量） */
  inSky(z: number): boolean { return this.zones.some(s => z >= s.from - 4 && z <= s.to); }

  /** 未关闭空中段的末端：生成推进目标不得越过（空段内本就不该有地面障碍） */
  cap(target: number): number {
    let c = target;
    for (const s of this.zones) if (!s.closed) c = Math.min(c, s.to);
    return c;
  }

  /**
   * 落地收尾：截断覆盖 z 的空段并返回回拨后的生成线。
   * 若开段时生成线已越过原定段尾，说明再远处已有障碍，回拨不能越过该前沿。
   */
  close(z: number, genZ: number): number {
    let next = genZ;
    for (const s of this.zones) {
      if (s.closed || z <= s.from) continue;
      const origTo = s.to;
      s.to = Math.min(s.to, z);
      s.closed = true;
      const safeFloor = s.genZAtOpen > origTo ? s.genZAtOpen : 0;
      next = Math.max(Math.min(next, z + 5), safeFloor);
    }
    return next;
  }
}