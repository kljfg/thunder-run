# 框架与技术栈路线图（团队职责范围）

> 本团队职责：**框架与技术栈**——引擎、平台层、UI 框架、构建/CI、测试基建、性能、网络与存档框架。
> **不负责**游戏本体内容：玩法数值、关卡/赛道设计、角色与道具定义、经济系统、文案。这些以作者侧设计库（docs 库）为唯一事实源。
> 里程碑背景见 `docs/wx-minigame-redesign.md`，任务派发见 `docs/session-plan.md`。

## 1. 与内容侧的边界契约

框架侧为内容侧提供**稳定接口**，内容侧不碰框架代码：

| 契约 | 载体 | 规则 |
|------|------|------|
| 数值配置 | `config/*.json` + schema（configValidator） | 内容侧改**玩法段**（obstacles/characters/skills/economy/events/themes 的数值与条目）；框架侧只改**技术段**（quality 画质分级、ui 手感参数、audio 音量、perf 采样），并在 schema 中分区标注 |
| 效果原语 | `buffEngine.ts` PRIMITIVES 注册表 | 新原语=框架侧实现+测试，内容侧只在 schema enum 内组合使用 |
| 资源 | `assets/`（字体图集、纹理、模型、音频） | 框架侧定目录规范与格式约束（尺寸/压缩/命名），内容侧按规范投放 |
| 热更新 | manifest（docs/manifest-schema.md） | 框架侧建管线与校验，内容侧只发布经 configValidator 的配置 |
| 防作弊 | 确定性 sim + 输入重放格式（§3 S19） | 框架侧提供录制/重放/服务端复跑校验，排行榜分数可信 |

**PR 纪律**：本团队 PR 不得修改玩法段数值；发现数值问题只开 issue 知会作者侧。

## 2. 框架域地图（现状 → 目标）

| 域 | 现状 | 目标态 | 任务 |
|----|------|--------|------|
| 工程结构 | npm workspaces + tsc -b + Vite（M5 完成） | 不变，按需加包 | - |
| 平台抽象 | v1 接口 + web 实现；v2 规格已出（S10） | v2 落地，wx 实现完整 | S3 |
| 渲染 | three.js web 跑通；wx 路线 B 垫片已验证（S11） | 双端同一 render 包 | S3/S6/S7 |
| UI | DOM（screens.ts）；布局内核+SDF 字体已备（S12/S13） | 自绘 UI 框架，双端共用 | S4/S5 |
| 构建发布 | web 构建可用；wx 构建管线未建 | 双端产物 + 分包 + 体积门禁 | S6 |
| CI/CD | 无（本地 npm run check） | GitHub Actions：PR 门禁 + 产物构建 | S15 |
| 测试 | node:test 123 例（逻辑层） | + golden-master 回归、输入重放、UI 快照、perf bench | S19 |
| 性能 | 未测 | 真机基线 + 画质分级 + 遥测 | S7/S16 |
| 遥测日志 | console + ?debug 探针 | 统一 log/metric/error 上报（wx 实时日志+云） | S16 |
| 音频 | **无音频框架** | PlatformAdapter 音频接口 + 资源池 + 静音策略 | S17 |
| 存档 | localStorage 两项 | 本地+云统一存档 API（版本化/迁移/多端） | S9/S18 |
| 内容分发 | 包内 config | CDN manifest 热更新（管线，不改数值） | S8 |
| 社交/账号 | 假登录 | wx.login/开放数据域排行/分享 | S9 |

## 3. 新增框架任务（S15–S19）

### S15 · CI/CD（可立即派发，零依赖）
- GitHub Actions：PR→dev 门禁（npm ci → tsc -b → 123+ 用例 → validate-config → import 禁令 → build:web）；
- dev/main push 时额外构建 wx 产物（S6 落地后接入）并上传 artifact；
- 体积门禁：主包 >4MB 即 fail（S6 后启用）；
- 缓存 node_modules，跑 Windows 或 Ubuntu（字体工具依赖系统字体，矩阵里标注差异）。

### S16 · 遥测与日志框架（依赖 S3 的 v2 接口）
- packages/telemetry：log/metric/error 三通道抽象；web→console+缓冲，wx→实时日志+云数据库；
- 关键指标埋点：首屏耗时、局内帧时间分布、内存水位（wx.getPerformance）、配置热更新命中率、崩溃栈；
- 采样与限流策略进 config 技术段；?debug 探针并入统一通道。

### S17 · 音频框架（依赖 S3；资源由内容侧投放）
- PlatformAdapter 扩展 audio 接口：web AudioContext / wx.createInnerAudioContext 双实现；
- packages/audio：加载/解码/池化、BGM 与 SFX 通道、音量与静音（存档联动）、场景切换淡入淡出；
- 资源规范：格式/采样率/命名/体积预算写进 assets/README；先以占位音效打通管线；
- 与 runnerScene 事件流对接（拾取/受击/技能/结算各挂点位，具体音效内容侧定）。

### S18 · 存档与防作弊框架（依赖 S9 云环境 + S19 重放格式）
- 统一存档 API：schema 版本化、迁移链、本地缓存+云端合并策略（冲突取高分/最近）；
- 反作弊：利用确定性 sim——客户端上报 seed+输入序列+结果，云函数复跑 RunnerSim 校验分数一致；
- 排行榜写入门禁：校验不过只入本地榜并打点上报（S16 通道）。

### S19 · 测试基建升级（a 段可立即派发；b 段依赖 S4/S6）
- **S19a（纯新增，零冲突）**：golden-master 回归——固定 seed 集跑 RunnerSim 全量，落盘状态摘要（分数/事件序列/实体终态），diff 即报警；输入重放格式 v1（帧号+输入事件的序列化规范，录制/回放 API），既服务测试也是 S18 防作弊的地基；
- **S19b（S4/S6 后）**：UI 快照测试（离屏渲染关键页面→像素 diff，阈值可配）；perf bench（固定 seed+脚本化输入序列，采集帧时间分布 p50/p95，CI 里跑 node 侧逻辑帧耗时）。

## 4. 波次规划（框架线，更新版）

```
可立即并行派发：S3（平台层v2+wx）、S4（UI框架）、S15（CI/CD）、S19a（golden-master+重放格式）
波次3（S3/S4 合入后）：S5（页面迁移）、S6（wx构建管线）、S16（遥测）、S17（音频）
波次4：S7（真机性能，依赖S5+S6）、S8（内容分发管线，依赖S6）、S19b（依赖S4+S6）
波次5：S9（社交/登录/云存档）、S18（防作弊复跑，依赖S9+S19a）
```

- 两位协作者 + 用户的并发上限按 4 会话设计：S3 与 S4 是长任务各占一人，S15/S19a 短平快由第三人（或同一人串行）消化。
- 所有新任务延续「只新增文件/自有目录」纪律，与在飞任务零路径冲突。
- 内容侧协作节奏：每个里程碑合入 main 后发「框架变更通告」（新原语/新技术段字段/资源规范变化），由作者侧同步 docs 库。

## 5. 明确不做（本团队范围外）

- 新角色/道具/关卡/活动的设计与数值（含 config 玩法段改动）
- 玩法机制变更（如新增「双击=技能」之外的操作方式——若需平台输入能力扩展，仅做接口，玩法接入由内容侧提需求）
- 美术资源制作（框架只定格式规范与管线）
- 运营配置（活动排期、推送文案）
