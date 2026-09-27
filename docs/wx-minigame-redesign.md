# 技术栈重设计：微信小游戏为主目标

> 状态：提案（待评审）。决策基线（2026-09-27 与负责人确认）：
> ① 渲染保留 three.js + 适配层；② UI 抽象成自绘层两端共用；③ 允许引入 npm/Vite；④ 小游戏为主，网页降级为开发调试壳。

## 1. 目标与硬约束

- **最终交付**：微信小游戏（game.json + game.js 入口，`wx.*` 运行时）。小游戏环境**没有 DOM/BOM**，只有 canvas（WebGL/2D）、`wx` API 和 CommonJS 模块加载。
- **包体**（官方现行限制）：主包 ≤ 4MB；整包（主包+分包）≤ 30MB；单个普通分包不限大小；支持 `wx.loadSubpackage` 按需加载与 `wx.preDownloadSubpackage` 预下载。
- **合规**（上架前置，与设计无关但影响排期）：国内小游戏上架需软著 + 微信《游戏自审自查报告》；接入虚拟支付需版号。纯 IAA（广告变现）门槛较低。目标账号主体需提前准备。
- **保留资产**：`src/core/`（sim/效果引擎/配置校验/rng，确定性可单测）与 `src/render/` 的 three.js 场景组织逻辑。

## 2. 目标架构（单仓多包）

```
thunder-run/
├── packages/
│   ├── core/          # 现 src/core 原样迁移，零平台依赖（现状已达成）
│   ├── render/        # three.js 场景层：只依赖 WebGL canvas 抽象，不摸 DOM
│   ├── ui/            # ★ 新：自绘 UI 框架（替代 screens.ts 的 DOM 页面）
│   ├── platform/      # PlatformAdapter 接口（泛化后）+ 类型
│   ├── platform-web/  # 调试壳实现（现 webPlatform.ts 收敛于此）
│   └── platform-wx/   # ★ 新：wx 实现（canvas/storage/frame/手势/网络/登录/分享）
├── apps/
│   ├── web/           # 开发调试壳：vite dev + ?debug 探针 + node 测试入口
│   └── wx/            # 小游戏工程：game.js/game.json/project.config.json 壳
├── config/            # 8 个内容配置（保持与 docs 库同源同步）
├── tools/             # 构建脚本、校验/禁令脚本（保留并扩展）
└── tests/             # node:test 迁移到各包，命令统一
```

- 包管理：pnpm workspaces（或 npm workspaces，取网络可达者）。
- import 禁令升级：`tools/check-import-rules.mjs` 增加规则——`packages/(core|render|ui)` 禁止 import `platform-web`/`wx` 全局；只有 `platform-*` 与 `apps/*` 可触平台 API；300 行/文件上限保留。

## 3. 各层改造方案

### 3.1 platform 接口泛化（第一步，解锁后续所有工作）

现有 `PlatformAdapter` 签名泄漏了 `HTMLElement`/`HTMLCanvasElement`，改为结构化最小类型：

```ts
export interface CanvasFactory {
  /** 创建 WebGL 画布（web: document.createElement；wx: 首次调用返回屏幕画布，后续为离屏） */
  createWebGLCanvas(): { width: number; height: number; getContext(t: 'webgl2', a?: unknown): WebGL2RenderingContext | null; ... };
  windowSize(): { w: number; h: number; dpr: number };
}
// Gesture/onKey → 合并为 onInput(cb: InputEvent)，wx 无键盘时只发手势与「虚拟按键」
// storage/fetchJson/requestFrame/onVisibility/now → 签名不变，wx 实现分别映射
//   wx.getStorageSync / wx.request / 主循环 requestAnimationFrame / wx.onShow+onHide / Date.now+performance
```

新增 wx 侧专属能力接口（不进 PlatformAdapter，独立可选注入，网页壳给 no-op 实现）：
`login()`（wx.login → openid，替换现在的"本地格式校验登录页"）、`share()`、`cloud`（排行/存档，见 §6）。

### 3.2 render：three.js 上小游戏

- three 版本锁定当前 vendor 版本起步，构建时按需裁剪（Tree-shaking 后 three.module 约 ~600KB min，主包 4MB 无压力）。
- 小游戏「自研引擎适配」路线：官方模板的 `weapp-adapter`（window/document/navigator/Image/HTMLElement 垫片）作为兜底；**目标是让 render 层不依赖 adapter**——three 的 `WebGLRenderer` 只需 `canvas + getContext + addEventListener（可选）`，通过 `platform-wx` 提供的最小垫片喂给它。
- iOS 开「高性能模式」，确认 WebGL2 支持矩阵；`?debug` 探针 `runDebugProbe.ts` 改为经 platform 注入，两端都能挂。
- 验收：devtools + 低端安卓真机 60fps、内存 <400MB（用真机性能监控）。

### 3.3 ui：自绘 UI 层（screens.ts 的替代）

- 方案：**three.js OrthographicScene 图层**（与主场景同 renderer，两 pass 渲染）。控件：Button/Panel/List/Label/ScrollView，文本用 **SDF 位图字体**（预生成图集，中英文各一），布局用轻量 flex 子集（自写 ~200 行，无新依赖）。
  - 不选「离屏 2D canvas 贴图」：文字模糊与合成开销不可控；不选小游戏引入 DOM 库：与"两端共用"目标背道而驰。
- 现有 5 个页面（boot/login/menu/hud/result）全部迁移为该框架的界面；HUD 本就在 runnerScene 里推送，一并改为 ui 层组件。
- 输入命中：ui 层订阅 `onInput`，按控件矩形分发，menu 的卡片选角色改为可滑动列表。

### 3.4 apps/web（调试壳）

- Vite 起 dev server，保留 `?debug`（`__trRun.*` / `__trSeed()`）与 Playwright 自动化验证路径。
- 登录页退化为「选游客/输入测试 openid」，与 wx 实现同一套 UI 组件——**两端 UI 代码 100% 同源**是验收标准。

### 3.5 apps/wx（小游戏工程）

```
apps/wx/dist/
├── game.js            # 入口：加载 platform-wx → bootstrap（共用主流程，从 apps/web 提取到 packages/game）
├── game.json          # 窗口/方向/分包配置
├── project.config.json
├── js/                # 构建产物（cjs bundle）
└── pkg-assets/        # 分包：角色模型、主题贴图、字体图集（wx.loadSubpackage 按需拉）
```

- 构建：Vite lib mode 产出 iife/cjs + 本仓 `tools/build-wx.mjs` 组装目录、生成 game.json（配置随包走：`config/*.json` 进分包，运行时 `wx.getFileSystemManager` 读或走 CDN）。
- 主包内容 = 引擎 + 启动首屏 + 默认角色/主题；其余进分包。T2.5「配置热更新 manifest」升级为**CDN + wx.downloadFile** 方案，随 M8 落地（不再依赖外部服务端时，用微信云开发存储起步）。

## 4. 工程链路（替换 .bat + Electron 方案）

- 本机已有 Node v24：`pnpm i` 后全用标准脚本，README「本机环境说明」的 Electron 借壳条目退役（保留给无网环境的 fallback 说明或删除）。
  - `pnpm build` = tsc -b + vite build；`pnpm test` = node --test（glob 收敛进 package script，绕开目录参数坑）；`pnpm check` = 4 步验证聚合（等价 运行测试.bat）。
  - `pnpm dev:wx` = 构建到 apps/wx/dist 并提示用微信开发者工具打开；CLI 可用开发者工具的 `cli upload` 做体验版自动化。
- 配置校验脚本修掉中文路径 bug（fileURLToPath），docs 库同步流程不变。
- vendor/three 改为 npm `three` 依赖；tools/vendor/tsc 退役（网络受限时保留为 fallback）。

## 5. 里程碑（对应改造量排序）

| # | 里程碑 | 内容 | 验收 |
|---|--------|------|------|
| M5 | 工程化切换 | pnpm+Vite+tsc -b，src→packages 拆包，check-import-rules 升级，修 validate-config | web 壳功能不回退，4 步验证全绿 |
| M6 | 平台层泛化 | platform 接口重设计、platform-wx 骨架、three 在 devtools/真机跑通**空场景** | 小游戏 canvas 出三色道，60fps |
| M7 | UI 自绘化 | ui 包（控件+SDF 文字）+ 5 页面迁移，screens.ts 删除 | web 与 wx 同一套 UI 截图 diff 通过 |
| M8 | 内容管线 | 分包/CDN 资源部署、config 热更新 manifest（T2.5 复活）、登录接 wx.login | 主包 ≤4MB，弱网首屏 ≤3s |
| M9 | 平台能力 | 好友排行（开放数据域）、分享、订阅消息、云开发存档、IAA 位预留 | 真机端到端 + 提审材料齐 |

数据依赖：M6/M7 可并行；M8 依赖 M6；合规材料（软著 30-40 个工作日）建议**立即启动**，与 M5-M7 并行。

## 6. 平台能力映射（替换现有伪实现）

| 现有 web 假实现 | 小游戏真实现 |
|---|---|
| 登录页本地格式校验 | `wx.login` + code2session（云开发/自建，M9 定） |
| localStorage 存 bestScore/角色 | `wx.setStorage`；云端存档用云开发 DB（换机不丢） |
| 无社交 | 开放数据域好友排行榜（跑酷品类的核心留存钩子）+ 定向分享 |
| fetchJson 本地 config | 分包内置 + CDN manifest（热更新数值不动版本） |
| 键盘调试输入 | 全走手势；`onKey` 仅 web 壳保留 |

## 7. 风险清单

1. **three.js 在低端安卓的 WebGL 表现**（最大技术风险）→ M6 提前用真机+云测验证，不达标则降级预案：材质/灯光简化、粒子减半、30fps 锁定。
2. **UI 自绘工作量**：菜单/结算信息密度高，SDF 中文图集生成要进构建脚本 → M7 预留双人周。
3. **合规与主体**：软著/自审报告周期长；个人主体不能接支付与部分能力，确认主体类型。
4. **docs 库不同步**：设计库在 `D:\gpt-6\work\酷跑小游戏`（作者机），本机不可达 → 本文档先落在实现仓，待 docs 库可同步时并入；本仓 `config/` 修改仍需知会作者手动双向同步。
5. **开放数据域是独立沙箱**（另一次 canvas + 受限 API），排行榜 UI 需单独小入口代码，纳入 M9 工作量。

## 8. 本仓库需要立即处理的前置项

- [ ] 装 pnpm，工程从「tsc 直出 dist + 手写 import 相对路径」切到 workspace（M5 起点）
- [ ] `platformAdapter.ts` 去 DOM 类型（M5/M6 边界，先出接口 v2 评审）
- [ ] 修 `validate-config.mjs` 中文路径 bug（小 PR，先行）
- [ ] 注册/确认小游戏 AppID 与主体类型；启动软著申请
- [ ] 与仓库 owner（kljfg）对齐：本文档方向 + docs 库同步机制 + 分支模型（本提案在 `dev` 分支）
