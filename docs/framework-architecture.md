# 框架架构总览（Framework Architecture）

> 框架团队的顶层设计文档：包地图、契约注册表、数据流、边界与所有权、整合清单、遗留决策点。
> 里程碑背景见 `docs/wx-minigame-redesign.md`，任务与状态见 `docs/session-plan.md`，内容侧边界见 `docs/content-track.md`。
> 维护规则：任何跨包契约变更（新增/改签名/废弃）必须同步本文档 §3 注册表，PR 评审以本文档为准绳。

## 1. 设计原则

1. **core 确定性**：sim/效果引擎纯函数化推进，同 seed 同输入必同结果——单测、golden-master 回归、云端复跑防作弊（S18）三处复用同一性质。
2. **平台纯度单向依赖**：业务包（core/render/ui/game）零 DOM、零 wx、零 three 之外的宿主 API；平台能力一律经 `@tr/platform` 契约注入。`tools/check-import-rules.mjs` 机器强制。
3. **一套代码两端跑**：web 是调试壳与自动化测试载体，wx 是发行目标；页面/主流程/渲染/UI 完全同源，差异只存在于 `platform-*` 实现与 `apps/*` 装配层。
4. **配置驱动 + 契约稳定**：玩法内容全部经 `config/*.json`（schema 校验拦截静默失败）；框架对内容侧只暴露 schema 与原语注册表两个接口面。
5. **文件级并行**：多会话并发开发靠「文件所有权矩阵」隔离（§5），整合接线集中在短任务（S20）里做，避免长线分支互相等待。
6. **≤300 行/文件**：强制拆模块，保证任何会话可整读单文件。

## 2. 包地图与依赖方向

```
apps/web（调试壳）  apps/wx（小游戏壳）        ← 装配层：允许 DOM/wx
      │                    │
      ▼                    ▼
packages/game（主流程：GameViews 接口 + mainFlow 场景机）
      │           │            │           │
      ▼           ▼            ▼           ▼
packages/ui   packages/render  packages/audio  packages/telemetry
（自绘UI）     （three 场景层）  （音频引擎）     （遥测三通道）
      │           │            │           │
      └───────────┴─────┬──────┴───────────┘
                        ▼
              packages/platform（契约：Adapter v2 + AudioBackend + WxExtras + Telemetry 挂载点）
                 ▲                          ▲
    packages/platform-web            packages/platform-wx
    （DOM/BOM 唯一入口）              （wx 全局唯一入口，含路线B最小垫片）
                        │
                        ▼
              packages/core（sim/effects/config/rng/scene——零平台依赖）
```

依赖只许向下；`platform-web/wx` 只被 `apps/*` 装配层 import；`core` 谁都可依赖但不依赖任何包。

## 3. 契约注册表（跨包接口的唯一事实源）

| 契约 | 文档/代码位置 | 提供方 | 消费方 | 状态 |
|------|--------------|--------|--------|------|
| PlatformAdapter v2 | docs/platform-adapter-v2.md + packages/platform/src/{platformAdapter,canvas,input,extras}.ts | platform | game/render/apps | ✅ S3 落地 |
| 手势共享内核 | packages/platform/src/gestureClassifier.ts | platform | platform-web/wx | ✅ S3 |
| WxExtras（login/share/cloud/readJson/readBinary） | packages/platform/src/extras.ts | platform-wx / platform-web(no-op) | game、S8/S9 | ✅ 占位，S8/S9 实装 |
| GameViews（五页面视图接口） | packages/game/src/views.ts（接口）+ packages/game/src/ui/overlayViews.ts（实现） | game | apps/web（已用）、apps/wx（S20 接线） | ✅ S5 落地：两端同源 overlay 版，DOM screens.ts 退役 |
| UiHost（自绘页面宿主） | packages/game/src/ui/host.ts | game | apps/*（经 OverlayHost 注入 renderer） | ✅ S5；⚠ web 侧暂为独立第二块 canvas/renderer，单 renderer 两 pass 待 S20 |
| UI 控件契约 | packages/ui/API.md | ui | game/src/ui、apps | ✅ S4，S5 起正式消费 |
| SDF 字体规格 | assets/fonts/README.md（latin+cjk 图集/metrics） | tools/fontgen | ui | ✅ S12+S4 修复 |
| AudioBackend | packages/platform/src/audio.ts + docs/audio-events.md 挂点表 | platform-web/wx | packages/audio → game（S20 接线） | ✅ S17，接线待 S20 |
| Telemetry 三通道 | docs/telemetry-spec.md + drafts/telemetry.ts | packages/telemetry（S16b 实现中） | game/render/platform（S20 接线） | 🔨 S16b |
| 输入重放格式 v1 | docs/replay-format.md | tools/replay | tests/golden、S18 云复跑 | ✅ S19a |
| golden-master | tests/golden/（15 组 seed×角色） | tools/replay/golden-gen.mjs | CI/内容侧协议 | ✅ S19a |
| 热更新 manifest | docs/manifest-schema.md + tools/publish-content.mjs | S8 客户端接线 | configLoader、platform-wx | ✅ 原型，S8 实装 |
| wx 构建产物结构 | docs/wx-minigame-redesign.md §3.5 + tools/build-wx.mjs | S6 | apps/wx、CI wx-build | ✅ S6（4MB 门禁已激活） |
| EffectWorld（效果→世界回调） | packages/core/src/effects/effectTypes.ts | core/simWorld | buffEngine | ✅ M2 审计后含 `extendFlight`（飞行续时补铺空中内容） |
| TrackGen 清障口 | packages/core/src/sim/trackGen.ts `clearObstacles(obs,fromZ,toZ,lane?)` | core | movement/landing、simWorld | ✅ M2 审计后取代 `openSky/closeSky`（飞行不再清场，改着陆走廊清道） |
| RunSummary.charName / BEST_KEY | packages/game/src/views.ts + mainFlow.ts | game | apps/* 结算页 | ✅ M2 审计：结算显示角色名；最佳分键修正为 `thunderrun:best` 并迁移旧笔误键 |

## 4. 关键数据流

- **输入**：wx.onTouch*/DOM pointer → gestureClassifier（共享纯函数）→ onInput → mainFlow 路由 → RunnerSim.applyAction / ui.handleInput。
- **模拟→表现**：RunnerSim.step(dt) 固定步长 → 事件队列 drainEvents → render（three 场景更新）+ ui（HUD 推送）+ telemetry（frameTime 埋点，S20 接）。
- **配置**：boot → configLoader(FileSource) → web: fetch / wx: extras.readJson(分包) → S8 后：manifest→CDN→包内兜底 → configValidator 全量校验 → GameContent。
- **防作弊（S18 设计）**：客户端录 {seed, charId, inputs[]} → 上报 {engineVersion, configHash, replay, result} → 云函数以 core dist 复跑 → eventsSha256/score 一致才入榜。
- **遥测（S16b→S20）**：业务代码 → Telemetry.log/metric/error → 采样/限流/批量 → web: sendBeacon / wx: 实时日志+云队列。

## 5. 边界与所有权矩阵

**团队边界**（详见 content-track.md）：框架团队拥有 packages/*、apps/*、tools/*、.github/*、tests/*、config 技术段；内容侧拥有 config 玩法段 + assets 资源投放 + docs 库设计。跨界通道只有 issue。

**框架会话文件所有权**（当前波次3 在飞）：
| 会话 | 拥有 | 禁碰 |
|------|------|------|
| （S5 ✅ 已合并@cd9008b） | — | — |
| S16b | packages/telemetry、platform-web/src/telemetryChannel.ts（新文件） | game、apps/web/src、platform-wx、audio |
| （S17 ✅ 已合并） | — | — |
| S20（整合） | 接线专属：bootstrap/mainFlow/runnerScene 的埋点与音频挂点、platform-wx 通道注册、UI 与主场景 renderer 合并 | 不做新功能 |

**S5 合并评审记录（cd9008b）**：
1. **越界项已核准**：`tools/fontgen/charset.mjs` 扫描源随 `screens.ts` 退役改为 `packages/game/src/**/*.ts`（必要连带）。
2. **架构偏离（重要）**：web 端 UI 层用独立透明 canvas + 独立 `WebGLRenderer`，与主场景由浏览器合成器叠加，
   而非 S4 设计的「共享 renderer + 独立正交 pass」。原因：`runnerScene` 自建 renderer 且不外露，`packages/render` 属 S5 禁碰范围。
   代价：两个 GL 上下文（内存/上下文切换），**wx 侧不可接受**（小游戏单 canvas 语义 + 内存预算）→ 列为 S20 第一优先项：
   `packages/render` 增 renderer 注入口，UI overlay 与主场景共用一个 renderer 与一个帧循环。
3. `packages/game` 新增 `three` 直接依赖（host.ts 用 `THREE.Color`/`overlay.scene.background`）：属可接受的向下依赖，
   但 renderer 合并后应收敛为只依赖 `@tr/ui` 的 OverlayHost 抽象。
4. 已吸收 f2d1948 交接项：结算页新纪录严格 `>`、显示 `charName`、`style.css` 保留 `overscroll-behavior: none`；
   窄屏角色卡可达性由横向虚拟 List 天然满足。
5. 根 `package-lock.json` 已同步 `packages/game` 的 `@tr/ui`/`three` 依赖边（否则 CI `npm ci` 会红，同 81d2b06 类型问题）。

**已合并的越轨提交收编**：`fix/m2-runtime-bugs`（mostny，M2 运行时审计 7 项 + 飞行链路回合二 + render 表现修复，6 提交）
经协调者裁决全量接受，合并于 `f2d1948`。遗留交接项：
1. **S5 须复刻的语义**（原改动落在退役中的 DOM `screens.ts`/`style.css`）：结算页「新纪录」用严格 `>`（同分不算）、
   显示 `charName` 而非 charId、窄屏下角色卡全部可达、`body { overscroll-behavior: none }`（触屏下拉刷新）。
   `webPlatform.ts` 的 `touchAction: none` 与 keydown `e.repeat` 过滤是持久实现，已保留。
2. **golden 基线已重生成**（`986e2a4`）：生存曲线明显变化（如 g-777-char_volt 609m→196m），需按 content-track §1.3
   知会内容侧确认难度体感；config 玩法段未被改动。
3. 后续改 core 飞行/清障逻辑者注意：`TrackGen.openSky/closeSky` 已删除，改用 `clearObstacles` + `landing.ts` 清道。

**分支模型**：`main` = 里程碑快照（默认分支，克隆即得稳定态）；`dev` = 集成分支（PR 目标）；`feat/sN-*` 框架任务分支；`content/*` 内容分支。评审合并由协调者执行，CI 双平台门禁强制。

## 6. S20 整合接线清单（波次3.5，协调者执行）

1. telemetry：按 S16b 的 docs/telemetry-wiring.md 在 mainFlow/bootstrap/runnerScene 接 markBoot/frameTime/memory/configSource/unhandledError。
2. audio：按 docs/audio-events.md 挂点表在 runnerScene 事件流/mainFlow 页面切换接 AudioEngine；apps/* 装配 AudioBackend。
3. platform-wx：注册 telemetry 通道与 audio 后端（S16b/S17 留的 TODO 位）。
4. config：game.json 技术段合并核对（params.ui/telemetry/audio 三节共存 + schema/validator 一致）。
5. **UI 与主场景 renderer 合并（S5 遗留，优先级最高）**：packages/render 增 renderer/canvas 注入口，
   runnerScene 不再自建；UiHost 的 OrthoOverlay 作为主 renderer 的第二个 pass（`autoClear=false`）串接；
   apps/web 撤掉第二块 UI canvas；apps/wx 按同一装配接线（小游戏不接受双 GL 上下文）。
6. 全量回归：npm run check + web 壳手测 + wx devtools 空场景/可跑内容确认。

## 7. 遗留设计决策点（按波次排）

| 波次 | 决策点 | 责任 |
|------|--------|------|
| S20（整合） | UI overlay 与主场景共用 renderer 的串接方式（render 侧注入口形态：构造参数 vs 工厂）；wx 单 canvas 下的 pass 顺序与 clear 策略 | 框架提案 |
| S7（真机性能） | 画质分级默认档位策略；30fps 锁帧触发条件；云测设备矩阵选择 | 框架+用户提供真机 |
| S8（内容分发） | CDN 选型：微信云开发存储 vs 外部 CDN（需备案域名）；manifest 发布审批流 | 用户拍板 |
| S9（社交） | 云后端：微信云开发 vs 自建（code2session 落点）；主体类型确认 | 用户拍板 |
| S18（防作弊） | 复跑校验的采样率与算力预算；校验失败的处置策略（影子榜/拒绝） | 框架提案 |
| S19b（测试基建） | UI 快照阈值与基线更新流程；perf bench 进 CI 的门禁线；**golden 覆盖补飞行链路**（现 15 组重放均不含飞行道具，飞行/滑翔回归只有 coreFlightFix 白盒覆盖） | 框架提案 |
| 上架 | 软著/自审报告/隐私接口声明——与开发并行推进 | 用户 |

## 8. 当前完成度快照（2026-09-28）

- 已合并：S1-S6、S10-S15、S16a、S17、S19a + M2 运行时审计修复（`f2d1948`）；364 测试例（0 fail），check ALL PASS
- 在飞：S16b（遥测实现，已提交未 push，需 rebase 到 dev）
- 内容轨道：C1/C2 已派发（issue #7/#8），可与框架波次并行
- 下一波：S20 整合（含 renderer 合并）→ S7/S8/S19b → S9/S18 → 上架材料
- 待手测：web 壳全流程（启动→登录→选角→跑一局→结算→重开）与 `?ui=demo`、`?debug` 探针不回退
