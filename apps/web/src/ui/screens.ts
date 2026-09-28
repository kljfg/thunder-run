/**
 * 页面层（ui，对应 docs/01 §11 的 P1/P2/P3 占位实现）
 * 职责：只画页面、收集用户操作并通过回调抛出去；不做任何游戏逻辑。
 * M0 阶段登录为「本地校验 + 游客进入」，真实账号接口在 M3（docs/04）接入。
 */
import type { GameContent } from '@tr/core/config/configTypes.js';
import type { FileSource } from '@tr/core/config/configLoader.js';
import { buildLoadout, playableCharacters, type Loadout } from '@tr/core/sim/character.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** 简易 DOM 构建：el('div', 'cls', '文本' | Node[]) */
function el(tag: string, cls: string, inner?: string | Node[]): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (typeof inner === 'string') node.textContent = inner;
  else if (inner) node.append(...inner);
  return node;
}

// ---------------- P1 启动页 ----------------
export function renderBoot(onProgress: (text: string) => void) {
  const screen = $('screen');
  screen.replaceChildren(
    el('div', 'boot', [
      el('h1', 'boot-title', '雷霆酷跑'),
      el('p', 'boot-sub', 'THUNDER RUN · 霓虹雷暴都市'),
      el('div', 'boot-bar', [el('i', 'boot-bar-fill')]),
      el('p', 'boot-status', '正在启动…'),
    ]),
  );
  return { setStatus: (text: string) => onProgress(text), statusEl: screen.querySelector('.boot-status') as HTMLElement };
}

// ---------------- P2 登录页 ----------------
export interface LoginActions { onGuest(): void }

export function renderLogin(actions: LoginActions): { showError(msg: string): void; submit(): void } {
  const user = document.createElement('input');
  user.placeholder = '用户名（4-20 位字母/数字/下划线）';
  user.id = 'in-user';
  const pass = document.createElement('input');
  pass.placeholder = '密码（8-32 位，含字母和数字）';
  pass.type = 'password';
  pass.id = 'in-pass';
  const err = el('p', 'form-error', '');
  const hint = el('p', 'form-hint', '提示：后端账号接口在 M3 里程碑接入（docs/04），当前仅做本地格式校验。');

  const btnLogin = el('button', 'btn btn-primary', '登录 / 注册');
  const btnGuest = el('button', 'btn', '游客进入（进度存本机）');

  /** 与 docs/04 §1 一致的格式规则（真实校验最终在服务端） */
  function validate(): string | null {
    const u = user.value.trim(), p = pass.value;
    if (!/^[A-Za-z0-9_]{4,20}$/.test(u)) return '用户名需为 4-20 位字母、数字或下划线';
    if (p.length < 8 || p.length > 32 || !/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) return '密码需 8-32 位且同时包含字母和数字';
    return null;
  }
  /** 登录/注册：回车键与主流程共用入口 */
  function submit() {
    const msg = validate();
    if (msg) { err.textContent = msg; return; }
    err.textContent = '';
    // M3 前没有后端：把用户名记到本地，直接进主菜单（演示流转）
    localStorage.setItem('thunderrun:lastUser', user.value.trim());
    actions.onGuest();
  }
  btnLogin.addEventListener('click', submit);
  btnGuest.addEventListener('click', () => actions.onGuest());

  $('screen').replaceChildren(
    el('div', 'card login', [
      el('h2', 'card-title', '进入新澪市'),
      el('p', 'card-desc', '用账号密码登录，或先以游客身份试玩（进度保存在本机）。'),
      user, pass, err,
      el('div', 'btn-row', [btnLogin, btnGuest]),
      hint,
    ]),
  );
  return { showError: (m: string) => { err.textContent = m; }, submit };
}

// ---------------- P3 主菜单 ----------------
export interface MenuActions {
  onStartRun(charId: string): void;
  onClearCache(): void;
}

/** 菜单技能行：能量攒满所需里程由配置推导（skills.json energy.perMeter），不写死文案 */
function skillLine(load: Loadout): string {
  const sk = load.skill;
  if (!sk) return `本局角色「${load.name}」：无主动技能`;
  const need = Number.isFinite(sk.energyPerMeter) && sk.energyPerMeter > 0
    ? `跑满 ${Math.ceil(sk.energyMax / sk.energyPerMeter)} 米攒满能量`
    : '开局即可释放';
  return `本局角色「${load.name}」：双击屏幕 / E 键释放「${sk.label}」（${sk.desc}；${need}，冷却 ${sk.cooldownS}s）`;
}

export function renderMenu(content: GameContent, sources: Record<string, FileSource>, actions: MenuActions, currentCharId: string) {
  const chars = playableCharacters(content);
  const rarityClass: Record<string, string> = { R: 'r-r', SR: 'r-sr', SSR: 'r-ssr' };
  let chosen = chars.some(c => c.id === currentCharId) ? currentCharId : (chars[0]?.id ?? '');

  const startBtn = el('button', 'btn btn-primary btn-big', '开始 · 跑酷！');
  const skillHint = el('p', 'card-desc', '');
  const charCards = chars.map(c => {
    const load = buildLoadout(content, c.id);
    const skinCount = ((c.skins as string[]) ?? []).length;
    const card = el('div', `char-card${c.id === chosen ? ' picked' : ''}`, [
      el('i', 'char-chip'),
      el('b', 'char-name', load.name),
      el('span', `char-rarity ${rarityClass[String(c.rarity)] ?? ''}`, String(c.rarity ?? '')),
      el('small', 'char-meta', `皮肤 ×${skinCount} · ${c.id}`),
      el('p', 'char-skill', load.skill ? `技能：${load.skill.label} — ${load.skill.desc}` : '技能：无'),
      el('p', 'char-skill', load.passive.length ? `被动：${load.talentLabel} — ${load.talentDesc}` : '被动：无'),
    ]);
    card.addEventListener('click', () => {
      chosen = c.id;
      try { localStorage.setItem('thunderrun:character', c.id); } catch { /* 无痕模式忽略 */ }
      charCards.forEach(x => x.classList.remove('picked'));
      card.classList.add('picked');
      skillHint.textContent = skillLine(load);
    });
    return card;
  });
  // 给角色色块上色（chip 在构建时拿不到引用，这里统一遍历）
  charCards.forEach((card, i) => {
    (card.children[0] as HTMLElement).style.background = buildLoadout(content, chars[i].id).tint;
  });

  const srcText = Object.entries(sources).map(([k, v]) => `${k}:${v === 'network' ? '网络' : v === 'cache' ? '缓存' : '失败'}`).join('  ');
  skillHint.textContent = skillLine(buildLoadout(content, chosen));

  startBtn.addEventListener('click', () => actions.onStartRun(chosen));
  const clearBtn = el('button', 'btn', '清除本机缓存');
  clearBtn.addEventListener('click', actions.onClearCache);
  try { localStorage.setItem('thunderrun:character', chosen); } catch { /* 同上 */ }

  const lastUser = localStorage.getItem('thunderrun:lastUser');

  $('screen').replaceChildren(
    el('div', 'menu', [
      el('div', 'menu-head', [
        el('h2', 'card-title', '主菜单'),
        el('span', 'menu-user', lastUser ? `账号：${lastUser}（本地演示）` : '游客模式'),
      ]),
      el('p', 'card-desc', '操作：← → 换道 · ↑/空格 跳 · ↓ 滑铲 · 双击或 E 放技能 · Esc 退出。点卡片换角色。'),
      el('div', 'char-row', charCards),
      skillHint,
      el('div', 'btn-row', [startBtn, clearBtn]),
      el('p', 'cfg-src', `配置来源 ${srcText} · characters v${content.characters.configVersion}`),
    ]),
  );
}

// ---------------- 跑酷 HUD（局内顶部状态条，由 bootstrap 挂在场景上） ----------------
export interface HudSkill { label: string; energy: number; cd: number; ready: boolean }
export interface HudData {
  score: number; coins: number; distance: number; hits: number; lives?: number;
  buffs?: { name: string; left: number }[];
  skill?: HudSkill | null;
}

export function createRunHud(): { el: HTMLElement; update(h: HudData): void } {
  const box = el('div', 'run-hud');
  const line = el('div', 'hud-line');
  const skillLine = el('div', 'hud-skill');
  box.append(line, skillLine);
  return {
    el: box,
    update(h) {
      const lives = h.lives ?? 1;
      const hearts = '❤'.repeat(Math.max(0, lives - h.hits)) + '♡'.repeat(Math.min(h.hits, lives));
      // 同一技能的多个原语共用一个名字（如雷神之翼=飞行+磁铁），按名称合并只显一次；
      // 永久被动（无 durationS，如莉娜的开局护盾）不显示倒计时。
      const merged = new Map<string, number>();
      for (const b of h.buffs ?? []) {
        const prev = merged.get(b.name);
        merged.set(b.name, prev === undefined ? b.left : Math.max(prev, b.left));
      }
      const buffs = [...merged].map(([name, left]) => `${name}${Number.isFinite(left) ? ` ${Math.ceil(left)}s` : ''}`).join(' · ');
      line.textContent = `${h.score.toLocaleString()} 分 · ${h.coins} 金币 · ${Math.floor(h.distance)} m · ${hearts}${buffs ? ' · ' + buffs : ''}`;
      const sk = h.skill;
      if (!sk) { skillLine.textContent = ''; return; }
      const pct = Math.round(Math.max(0, Math.min(1, sk.energy)) * 100);
      skillLine.textContent = sk.cd > 0
        ? `${sk.label}：冷却 ${sk.cd.toFixed(1)}s`
        : sk.ready ? `${sk.label}：就绪（双击 / E）` : `${sk.label}：能量 ${pct}%`;
      skillLine.classList.toggle('ready', sk.ready);
    },
  };
}

// ---------------- P6 结算页 ----------------
export interface RunSummary { distance: number; coins: number; nearMiss: number; hits: number; score: number; t: number; casts?: number; charId?: string }

export function renderResult(summary: RunSummary, best: number, actions: { onRetry(): void; onMenu(): void }) {
  const isNew = summary.score >= best && summary.score > 0;
  const row = (label: string, val: string) => el('div', 'result-row', [el('span', '', label), el('b', '', val)]);
  const retry = el('button', 'btn btn-primary btn-big', '再跑一次');
  retry.addEventListener('click', actions.onRetry);
  const menu = el('button', 'btn', '回主菜单');
  menu.addEventListener('click', actions.onMenu);
  $('screen').replaceChildren(
    el('div', 'card result', [
      el('h2', 'card-title', isNew ? '新纪录！' : '到站休息'),
      el('p', 'result-score', summary.score.toLocaleString()),
      row('里程', `${Math.floor(summary.distance)} m`),
      row('金币', String(summary.coins)),
      row('惊险擦身', `${summary.nearMiss} 次`),
      row('受击', `${summary.hits} 次`),
      row('技能释放', `${summary.casts ?? 0} 次${summary.charId ? ' · ' + summary.charId : ''}`),
      row('历史最佳', String(Math.max(best, summary.score).toLocaleString())),
      el('div', 'btn-row', [retry, menu]),
    ]),
  );
}

// ---------------- 通用小提示条 ----------------
export function toast(msg: string) {
  const t = el('div', 'toast', msg);
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2200);
}
