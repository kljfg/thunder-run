# 雷霆酷跑 · 网页版（实现仓库）

[![CI](https://github.com/kljfg/thunder-run/actions/workflows/ci.yml/badge.svg?branch=dev)](https://github.com/kljfg/thunder-run/actions/workflows/ci.yml)

> 实现仓库。设计与规范的唯一事实源在文档库 `D:\gpt-6\work\酷跑小游戏`（下称 docs 库），本仓库只放代码与可运行配置。
> 当前进度：**M2 数据驱动接入 4/5**（T2.1 参数外置 · T2.2 效果原语引擎 · T2.3 道具掉落 · T2.4 角色装配与技能）；
> **M5 工程化切换已完成**（npm workspaces 拆包 `src/` → `packages/* + apps/web`，tsc -b + Vite 构建链，three/tsc 切 npm 依赖，见 `docs/wx-minigame-redesign.md` §2/§4）。
> 后续：M6 平台层泛化（S3 接 `@tr/platform` v2 接口）→ M7 UI 自绘（`@tr/ui` 现为空壳）→ M8/M9。
> 已延期/待办：T0.3 微信小游戏壳（随 M6 复活）、T2.5 配置热更新 manifest 客户端（需 CDN/服务端，随 M3 一起做）。

## 快速开始（小白版）

> 前置（一次性）：本机需 Node ≥ 20.19（当前机器 v24），项目根目录执行 `npm install`。

| 想做什么 | 双击 .bat | 等价命令 |
|----------|-----------|----------|
| 玩/测试页面 | **`启动本地测试.bat`** | `npm run dev`（Vite，自动开浏览器 → `http://127.0.0.1:8767/`；地址加 `?debug` 开探针；改代码热更新） |
| 改了代码后类型/产物重建 | **`编译代码.bat`** | `npm run build`（tsc -b，增量，产物在各包 `dist/`） |
| 提交前的完整自检 | **`运行测试.bat`** | `npm run check`（编译+单测+配置校验+架构禁令，全绿出 ALL PASS） |
| 构建可部署的网页包 | — | `npm run build:web`（Vite 产物在 `apps/web/dist`，含拷入的 `config/*.json`；`python tools/serve.py` 可静态起服预览） |

页面流程：启动页（加载配置）→ 登录页（本地格式校验/游客进入）→ 主菜单（**点卡片选角色**，技能与被动文案来自 config）→ 跑酷局 → 结算页（含技能释放次数）。

局内操作：`← →` 换道 · `↑`/空格 跳 · `↓` 滑铲 · **双击屏幕 / `E` 放主动技能** · `Esc` 回主菜单。
能量靠跑动里程积攒（`skills.json` 的 `energy.perMeter`），冷却与效果时长也全部读配置。

## 目录结构（npm workspaces 单仓多包，对应重设计文档 §2）

```
thunder-run/
├── packages/                   各包：src/ 源码 → tsc -b 增量编译到本包 dist/（imports 走 @tr/<包>/…）
│   ├── core/                   纯逻辑层 @tr/core（禁止碰 DOM/three，见 tools/check-import-rules.mjs 强制）
│   │   ├── rng.ts              确定性随机（docs/02 §6）
│   │   ├── config/             配置类型/校验器/装载器（docs/03、T0.4）
│   │   ├── effects/            ★ 效果原语引擎（docs/03 §4.3、T2.2）
│   │   │   ├── effectTypes.ts  FxState / EffectWorld 等公共类型
│   │   │   └── buffEngine.ts   原语注册表 PRIMITIVES + buff 槽位调度
│   │   ├── scene/              场景状态机（docs/02 §5、T0.5）
│   │   └── sim/
│   │       ├── character.ts    ★ 角色装配：characters.json → 主动技能+被动天赋（T2.4）
│   │       ├── runnerSim.ts    输入路由 + 逐帧推进 + 结算（不再自己管 buff）
│   │       ├── simTypes.ts     状态/事件类型与物理常量
│   │       ├── movement.ts     运动学：跳、铲、换道、飞行/滑翔降落
│   │       ├── collision.ts    碰撞几何与判定谓词（含 laneAutoAvoid 选道）
│   │       ├── collect.ts      金币与道具箱拾取判定
│   │       ├── simWorld.ts     EffectWorld 实现：瞬时原语/飞行如何改动赛道实体
│   │       └── trackGen.ts     赛道/金币/道具箱生成
│   ├── platform/               @tr/platform：PlatformAdapter 接口 v1（docs/02 §4；DOM 类型泄漏，S3 泛化为 v2）
│   ├── render/                 @tr/render：three.js 场景层（npm 依赖 three@0.160），只读 sim 做表现
│   │   ├── runnerScene.ts      总装：舞台/相机/固定步长循环/事件→反馈/HUD 推送
│   │   ├── trackVisuals.ts     道路·车道线·护栏·流动虚线
│   │   ├── avatarRig.ts        角色本体 + 喷气背包/头盔/护盾挂件与姿态
│   │   ├── runnerModel.ts      程序化低多边形角色模型（M4 T4.2）
│   │   ├── coinField.ts        金币双 InstancedMesh + 最近优先名额选取
│   │   ├── entityLayers.ts     障碍池 / 道具箱池 / 云团池
│   │   ├── vfxBurst.ts         拾取爆点粒子池
│   │   └── runDebugProbe.ts    ?debug 自动化探针（__trRun.state / __trRun.probe）
│   ├── ui/                     ★ @tr/ui 空壳占位（M7/S4 落地自绘 UI 框架）
│   ├── platform-web/           @tr/platform-web：webPlatform.ts（调试壳实现，DOM/BOM 唯一入口）
│   └── platform-wx/            ★ @tr/platform-wx 空壳占位（M6/S3 落地 wx 实现）
├── apps/
│   └── web/                    @tr/web：开发调试壳（Vite）
│       ├── index.html          入口页（#screen 容器）
│       ├── style.css           页面样式
│       ├── vite.config.ts      Vite 配置（config/ 经 publicDir 挂载到站点根路径）
│       └── src/
│           ├── bootstrap.ts    组装入口：适配层+场景机+配置+页面（原 src/game；M6 接口 v2 后提取「两端共用主流程」到 packages/game）
│           └── ui/screens.ts   启动/登录/主菜单/HUD/结算页（docs/01 §11；M7 由 @tr/ui 替换后删除）
├── config/                     8 个内容配置（与 docs 库 config/ 同源，改完两边要同步；Vite publicDir 挂载）
├── vendor/                     three.js r160 运行时 + 类型（M5 起仅作回滚/离线兜底，构建链已切 npm 依赖）
├── tools/                      check.mjs 四步聚合 / 禁令脚本 / tsc vendor 兜底 / serve.py 静态兜底
├── tests/                      node:test 单元测试（92 例，import 各包 dist/ 产物）
└── <各包>/dist/                编译产物（不入库，tsc -b 生成）
```

## 效果系统怎么运作（T2.2 摘要）

- **一条技能 = 若干效果原语的组合**，原语清单见 docs/03 §4.3；引擎注册表 `PRIMITIVES` 与 `schema` 的 primitive enum 由 `tests/effects.test.mjs` 强制一一对应。
- `BuffEngine.add(primitive, params, label, ctx, stackRule)` 施加；`tick(dt)` 推进；`fx` 是**派生视图**，每步整体重算，sim/render/HUD 只读。
- 瞬时原语（`dash`/`blink`/`scoreAdd`/`spawnCoinsRow`）通过 `EffectWorld` 回调直接改世界；`fly` 额外向赛道生成器申请空中段。
- `stackRule`：`refresh` 刷新时长 / `stack` 叠层（护盾）/ `replace` 整条重置（滑板）。同原语只有一个槽位，多来源不叠乘。
- 被动天赋登记为**永久槽位**（装配时丢掉 `durationS`），HUD 不显示倒计时。
- 配置若引用未注册原语，`configValidator` 直接报错并指出条目 id —— 不会出现「配了但没效果」的静默失败。

## 本机环境说明（与 docs 的偏差记录）

1. ~~没有安装 Node.js/npm，借 Qoder 自带 Electron~~ **已退役（M5，2026-09-27）**：本机已有正式 Node v24 + npm。工程切到 npm workspaces：TypeScript 5.5.4、Vite 7、three 0.160.1 均由 `node_modules` 提供（`npm install` 恢复）。`vendor/`（three r160）与 `tools/vendor/`（tsc 5.5.4）保留为回滚保险与离线兜底，构建链不再引用它们。
2. **暂用自研检查脚本代替 ESLint**（`tools/check-import-rules.mjs` 实现 C2/C6 禁令）；正式 lint 规则待工具链补齐后迁移。
3. 配置校验是 schema 的运行时轻量版；CI 全量 ajv 校验在 T2.5 接入。
4. ~~本仓库不是 git 仓库~~ **已还（2026-09-25）**：两个目录各自 `git init`（默认分支 `main`）并打了基线提交；提交信息按 docs/02 §9 的 `feat|fix|content|art|perf|docs(scope): 摘要` 格式。各包 `dist/`、`apps/web/build/`、`node_modules/` 已 gitignore；`vendor/` 与 `tools/vendor/` 仍故意入库，作 three/tsc 的回滚保险（M5 起正常构建走 npm，克隆后需 `npm install`）。
5. **原语实现集中在 `buffEngine.ts` 一张表**，未按 docs/10 §3.1 拆成 `effects/primitives/<name>.ts` 一原语一文件——单条原语只有 1-3 行合并规则，拆 20 个文件反而难改。
6. ~~`runnerSim.ts` / `runnerScene.ts` 超过 300 行~~ **已还（2026-09-25）**：按概念拆成 sim 7 模块 + render 7 模块，并在 `tools/check-import-rules.mjs` 加了 R3 规则，任何源文件超 300 行 `运行测试.bat` 直接失败。

## 修改指引（给后续智能体）

- 加内容（角色/道具/活动）：只改 `config/*.json`（规则见 docs/03 + docs/06），**docs 库与本仓库两份配置要同步**，跑 `运行测试.bat`。
- 加新玩法数值：先加进 `config/game.json`（并同步 schema + docs/03 的参数表），再在 sim 里读取；`tests/configValidator.test.mjs` 会盯住「用了但没写进 schema」的字段。
- 加新效果原语（[PRIMITIVE]）：`buffEngine.ts` 的 `PRIMITIVES` 加一项 + `recompute()` 或 `castInstant()` 加合并规则 + `schema` 的 primitive enum + docs/03 §4.3 表格 + `tests/effects.test.mjs` 矩阵用例，五处同一 PR 内改完。
- 加页面：`apps/web/src/ui/screens.ts` 增加渲染函数，`apps/web/src/bootstrap.ts` 场景机注册进入/退出（M7 起页面迁到 `@tr/ui`）。
- 平台差异：一律扩展 `packages/platform/src/platformAdapter.ts` 接口 + 在 `packages/platform-web/src/webPlatform.ts` 实现，别在业务层写 `window`（M6 起接口去 DOM 类型 + 新增 `@tr/platform-wx`）。
- 跨包 import 约定：一律 `@tr/<包>/<模块路径>.js`（如 `@tr/core/sim/runnerSim.js`），经各包 `package.json` 的 `"./*": "./dist/*"` 解析；包内仍用相对路径。禁令：`packages/core|render|ui|game` 不得 import `@tr/platform-web` / `@tr/platform-wx` 或触碰 DOM 全局。
- 自动化验证：URL 加 `?debug` → 控制台 `__trRun.state`（含 `fx` 快照、能量、冷却）与 `__trRun.probe`（前方障碍/道具箱/各车道金币数），`__trSeed()` 给出本局种子用于同赛道复现。
