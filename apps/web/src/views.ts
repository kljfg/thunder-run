/**
 * GameViews 的网页 DOM 实现（过渡层：S5 packages/ui 落地后整体退役）。
 * screens.ts 保持纯 DOM；这里只做接口适配与句柄保管，不加逻辑。
 */
import type { GameViews, LoginHandle } from '@tr/game/views.js';
import { renderBoot, renderLogin, renderMenu, renderResult, createRunHud, toast } from './ui/screens.js';

export function createWebViews(): GameViews & { submitLogin(): void } {
  /** 当前登录页句柄（回车快捷键用；离开页面后即使残留也只触发同场景忽略） */
  let loginHandle: LoginHandle | null = null;

  return {
    renderBoot() {
      const ui = renderBoot(() => {});
      return {
        setStatus(text, isError) {
          ui.statusEl.textContent = text;
          ui.statusEl.style.whiteSpace = isError ? 'pre-wrap' : 'normal';
          ui.statusEl.style.color = isError ? '#ff8f8f' : '';
        },
      };
    },
    renderLogin(actions) {
      const h = renderLogin(actions);
      loginHandle = h;
      return h;
    },
    submitLogin() { loginHandle?.submit(); },
    renderMenu: (content, sources, actions, currentCharId) => {
      renderMenu(content, sources, actions, currentCharId);
    },
    mountHud() {
      const hud = createRunHud();
      document.body.appendChild(hud.el);
      return { update: h => hud.update(h), dispose: () => hud.el.remove() };
    },
    renderResult: (summary, best, actions) => {
      renderResult(summary, best, actions);
    },
    toast,
  };
}
