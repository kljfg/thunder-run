# 雷霆酷跑 · 网页版（实现仓库）

> 实现仓库。设计与规范的唯一事实源在文档库 `D:\gpt-6\work\酷跑小游戏`（下称 docs 库），本仓库只放代码与可运行配置。
> 当前进度：**M2 数据驱动接入 4/5**（T2.1 参数外置 · T2.2 效果原语引擎 · T2.3 道具掉落 · T2.4 角色装配与技能）。
> 已延期/待办：T0.3 微信小游戏壳（按「网页先行」决策延后）、T2.5 配置热更新 manifest 客户端（需 CDN/服务端，随 M3 一起做）。

## 快速开始（小白版）

| 想做什么 | 操作 |
|----------|------|
| 玩/测试页面 | 双击 **`启动本地测试.bat`** → 浏览器自动打开 `http://127.0.0.1:8767/index.html` |
| 改了代码后重新构建 | 双击 **`编译代码.bat`**（生成 `dist/`），刷新浏览器即可 |
| 提交前的完整自检 | 双击 **`运行测试.bat`**（编译+单测+配置校验+架构禁令，全绿出 ALL PASS） |

页面流程：启动页（加载配置）→ 登录页（本地格式校验/游客进入）→ 主菜单（**点卡片选角色**，技能与被动文案来自 config）→ 跑酷局 → 结算页（含技能释放次数）。

局内操作：`← →` 换道 · `↑`/空格 跳 · `↓` 滑铲 · **双击屏幕 / `E` 放主动技能** · `Esc` 回主菜单。
能量靠跑动里程积攒（`skills.json` 的 `energy.perMeter`），冷却与效果时长也全部读配置。

## 目录结构（与 docs/02 §3 的映射）

```
thunder-run/
├── index.html / style.css      网页壳（对应 app-web）
├── src/
│   ├── core/                   纯逻辑层（禁止碰 DOM/three，见 tools/check-import-rules.mjs 强制）
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
│   ├── platform/               平台适配层（docs/02 §4）
│   ├── render/                 只读 sim 做表现，按概念拆模块（每个 ≤300 行，脚本强制）
│   │   ├── runnerScene.ts      总装：舞台/相机/固定步长循环/事件→反馈/HUD 推送
│   │   ├── trackVisuals.ts     道路·车道线·护栏·流动虚线
│   │   ├── avatarRig.ts        角色本体 + 喷气背包/头盔/护盾挂件与姿态
│   │   ├── coinField.ts        金币双 InstancedMesh + 最近优先名额选取
│   │   ├── entityLayers.ts     障碍池 / 道具箱池 / 云团池
│   │   ├── vfxBurst.ts         拾取爆点粒子池
│   │   └── runDebugProbe.ts    ?debug 自动化探针（__trRun.state / __trRun.probe）
│   ├── ui/screens.ts           启动/登录/主菜单/HUD/结算页（docs/01 §11）
│   └── game/bootstrap.ts       组装入口：适配层+场景机+配置+页面
├── config/                     8 个内容配置（与 docs 库 config/ 同源，改完两边要同步）
├── vendor/                     three.js 运行时 + @types 类型（本地内置，无网络依赖）
├── tools/                      tsc 编译器（vendor）+ 校验/禁令脚本
├── tests/                      node:test 单元测试（91 例）
└── dist/                       编译产物（不要手改，由 .bat 生成）
```

## 效果系统怎么运作（T2.2 摘要）

- **一条技能 = 若干效果原语的组合**，原语清单见 docs/03 §4.3；引擎注册表 `PRIMITIVES` 与 `schema` 的 primitive enum 由 `tests/effects.test.mjs` 强制一一对应。
- `BuffEngine.add(primitive, params, label, ctx, stackRule)` 施加；`tick(dt)` 推进；`fx` 是**派生视图**，每步整体重算，sim/render/HUD 只读。
- 瞬时原语（`dash`/`blink`/`scoreAdd`/`spawnCoinsRow`）通过 `EffectWorld` 回调直接改世界；`fly` 额外向赛道生成器申请空中段。
- `stackRule`：`refresh` 刷新时长 / `stack` 叠层（护盾）/ `replace` 整条重置（滑板）。同原语只有一个槽位，多来源不叠乘。
- 被动天赋登记为**永久槽位**（装配时丢掉 `durationS`），HUD 不显示倒计时。
- 配置若引用未注册原语，`configValidator` 直接报错并指出条目 id —— 不会出现「配了但没效果」的静默失败。

## 本机环境说明（与 docs 的偏差记录）

1. **没有安装 Node.js/npm**：借用 Qoder 自带 Electron（`ELECTRON_RUN_AS_NODE=1` 即变 Node v24），TypeScript 编译器与 three 类型已离线内置在 `vendor/`、`tools/vendor/`。日后装好正式 Node+pnpm 可按 docs/02 §3 拆 monorepo，代码结构不变。
2. **暂用自研检查脚本代替 ESLint**（`tools/check-import-rules.mjs` 实现 C2/C6 禁令）；正式 lint 规则待工具链补齐后迁移。
3. 配置校验是 schema 的运行时轻量版；CI 全量 ajv 校验在 T2.5 接入。
4. **本仓库不是 git 仓库**：docs/10 §7 的 PR 自检流程暂无法执行，改动靠 `运行测试.bat` 全绿 + 人工复核。
5. **原语实现集中在 `buffEngine.ts` 一张表**，未按 docs/10 §3.1 拆成 `effects/primitives/<name>.ts` 一原语一文件——单条原语只有 1-3 行合并规则，拆 20 个文件反而难改。
6. ~~`runnerSim.ts` / `runnerScene.ts` 超过 300 行~~ **已还（2026-09-25）**：按概念拆成 sim 7 模块 + render 7 模块，并在 `tools/check-import-rules.mjs` 加了 R3 规则，任何源文件超 300 行 `运行测试.bat` 直接失败。

## 修改指引（给后续智能体）

- 加内容（角色/道具/活动）：只改 `config/*.json`（规则见 docs/03 + docs/06），**docs 库与本仓库两份配置要同步**，跑 `运行测试.bat`。
- 加新玩法数值：先加进 `config/game.json`（并同步 schema + docs/03 的参数表），再在 sim 里读取；`tests/configValidator.test.mjs` 会盯住「用了但没写进 schema」的字段。
- 加新效果原语（[PRIMITIVE]）：`buffEngine.ts` 的 `PRIMITIVES` 加一项 + `recompute()` 或 `castInstant()` 加合并规则 + `schema` 的 primitive enum + docs/03 §4.3 表格 + `tests/effects.test.mjs` 矩阵用例，五处同一 PR 内改完。
- 加页面：`src/ui/screens.ts` 增加渲染函数，`src/game/bootstrap.ts` 场景机注册进入/退出。
- 平台差异：一律扩展 `platformAdapter.ts` 接口 + 在 `webPlatform.ts` 实现，别在业务层写 `window`。
- 自动化验证：URL 加 `?debug` → 控制台 `__trRun.state`（含 `fx` 快照、能量、冷却）与 `__trRun.probe`（前方障碍/道具箱/各车道金币数），`__trSeed()` 给出本局种子用于同赛道复现。
