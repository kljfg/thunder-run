# 会话协调计划（小游戏重设计 · S 系列任务）

> 协调者会话负责本文件的维护：任务分派、状态登记、集成裁决。执行会话只跑自己被分配的提示词。
> 决策基线见 `docs/wx-minigame-redesign.md`；**团队职责边界（只做框架与技术栈，不碰玩法内容）与 S15-S19 新任务见 `docs/framework-roadmap.md`**。

## 0. 协调协议

- **编号**：任务固定为 S1…S9。用户向协调者汇报格式：`S3 完成` / `S3 阻塞：<原因>`。
- **工作区隔离**：每个执行会话用独立 worktree，禁止在主工作区切分支：
  ```bash
  git worktree add ..\tr-s3 -b feat/s3-platform-v2 origin/main   # 基于最新已合并点
  ```
- **分支命名**：`feat/sN-<短名>`。一个会话只碰自己 scope 内的文件，越界需求记录到汇报里由协调者裁决。
- **集成顺序即波次**：同波次任务可并行（scope 互斥）；跨波次必须等前波合并进 `dev` 后，从 `dev` 重新拉 worktree。
- **每个会话的通用底线**（已含在各提示词里，此处备查）：
  1. 先读 `AGENTS.md` + `docs/wx-minigame-redesign.md`；
  2. 提交前 4 步验证全绿（编译/单测/配置校验/架构禁令）；
  3. 汇报内容：分支名、commit 列表、验证输出摘要、遗留问题、需要下游知道的接口变化。
- **合并纪律**：执行会话只 push 自己的 feat 分支；合入 `dev` 由协调者审定（PR 或本地 merge）。

## 1. 依赖图与波次

```
波次0  S1 小修快跑（validate-config 修复、脚本收敛）      [基于 origin/main]
波次1  S2 monorepo 搬迁（M5，串行瓶颈，全局等待）          [基于 origin/main，合入后 dev=新结构]
波次1.5（与 S2 并行，全部纯新增文件、零冲突；spike 产物供下游搬运）
       S10 PlatformAdapter v2 接口规格                     [纯文档+类型草案 → 喂 S3/S4]
       S11 three×微信小游戏可行性 spike                    [→ 喂 S3/S6，M6 最大风险前置]
       S12 SDF 字体工具链                                  [→ 喂 S4]
       S13 UI 布局/命中纯逻辑内核                          [→ 喂 S4]
       S14 config 热更新 manifest schema+publish 原型      [→ 喂 S8]
波次2  S3 平台层 v2 + platform-wx 骨架 + three 空场景跑通  [依赖 S2；消费 S10 规格+S11 结论]
       S4 UI 自绘框架内核（控件库+SDF 工具链）             [依赖 S2；消费 S12+S13 产物]
波次3  S5 五页面迁移（screens.ts 退役）                    [依赖 S3+S4]
       S6 apps/wx 构建管线（game.json/分包/产物组装）       [依赖 S3；消费 S11 垫片结论]
波次4  S7 真机性能验证+降级预案（M6 验收）                 [依赖 S5+S6]
       S8 内容管线：分包资源+config 热更新 manifest(T2.5)  [依赖 S6；消费 S14 schema]
波次5  S9 平台能力：wx.login/云存档/开放数据域排行/分享     [依赖 S6+S8，需 AppID+云环境]
```

外部前置（用户准备，不占会话）：微信开发者工具安装、小游戏 AppID、软著申请启动、（S9 前）云开发环境开通与主体类型确认。

## 2. 会话提示词

### S1 · 小修快跑（波次0，可立即开工）

```text
你在工作区处理 雷霆酷跑 仓库的两个小修复，分支 feat/s1-toolfix（基于 origin/main）。
先读 AGENTS.md 了解环境坑与验证流程。

任务：
1. 修 tools/validate-config.mjs 第 10 行：默认目录改用
   fileURLToPath(new URL('../config', import.meta.url))，使中文/空格路径下不带参数也能运行。
2. package.json 的 scripts.test 目前是 "node --test tests/"，本机 Node v24.19 下目录形式会崩，
   改为 "node --test tests/*.test.mjs"；并新增 scripts.check = "node tools/check.mjs"，
   新建 tools/check.mjs 依次执行：tsc 编译、单测、validate-config、check-import-rules，
   全绿打印 ALL PASS，任一失败退出码非 0（等价旧 运行测试.bat，本机 .bat 不可用）。
3. AGENTS.md 已列的三个坑对应更新（validate-config 不再需要显式传参；node --test 用 glob）。

验收：node tools/check.mjs 全绿；把不传参运行 node tools/validate-config.mjs 的输出贴进汇报。
汇报：分支名、commit、验证摘要。不要动 src/ 与 config/。
```

### S2 · monorepo 搬迁（波次1，M5，串行瓶颈）

```text
你负责 雷霆酷跑 的工程化切换（重设计文档 docs/wx-minigame-redesign.md 的 M5），分支 feat/s2-workspace。
先读 AGENTS.md 与重设计文档全文。本机有 Node v24，允许联网装包（用 npm，pnpm 装不上就不强求）。

目标结构（见文档 §2）：
- 建 workspace：packages/core、packages/render、packages/ui(空壳占位)、packages/platform、
  packages/platform-web、packages/platform-wx(空壳占位)、apps/web。
- src/core → packages/core（含 config/effects/scene/sim/rng，路径全量迁移）；
  src/render → packages/render；src/platform/platformAdapter.ts → packages/platform（仅移动，签名先不改）；
  src/platform/webPlatform.ts → packages/platform-web；src/game/bootstrap.ts → apps/web 或 packages/game 均可，
  但保持「主流程两端共用」的提取可能（文档 §3.5），推荐 packages/game。
- src/ui/screens.ts 留在 apps/web 过渡目录（S4/S5 才处理它），移动但内容不改。
- 依赖：npm 安装 three + @types/three（版本与 vendor/three 当前一致，先查 vendor 里 build/three.module.js 头部版本号），
  packages/render 改 import 'three' 走 node_modules；vendor/ 目录本步保留不删（回滚保险）。
- 构建：Vite 负责 apps/web（dev 与 build），跨包用 tsc -b + project references 做类型构建；
  dist/ 布局变化后 index.html/style.css 跟着调整，功能零回退：启动页→登录→菜单→跑酷→结算 全流程可用，
  ?debug 探针 __trRun.state/__trRun.probe/__trSeed 正常。
- tools/check-import-rules.mjs 升级适配新结构：禁令范围改为 packages/(core|render|ui|game) 不得 import
  platform-web|platform-wx|DOM 全局（window/document/localStorage/fetch），300 行/文件上限保留。
- tests/ 暂不搬家（仍指 dist 产物），但 tsc 产物路径变了要同步测试 import 路径，92 例全绿。
- config/ 8 个 json 不动。validate-config 等 tools 随路径微调。

验收：node tools/check.mjs（或 S1 的等价物，若 S1 未合并则 4 步手动）全绿 + 浏览器手动冒烟说明。
汇报里必须包含：最终目录树、packages/platform 接口的当前签名（S3 要基于它设计 v2）、跨包 import 的写法约定。
这是大搬迁：宁可多花时间，不允许「先跑起来再说」的临时垫片。
```

### S3 · 平台层 v2 实现 + platform-wx + 空场景（波次2 · 正式派发版，已注入 S10/S11 产物）

```text
你负责 雷霆酷跑 平台抽象层 v2 的落地实现与微信小游戏侧骨架（重设计文档 §3.1/§3.2，M6 前半），
分支 feat/s3-platform-v2，基于 origin/dev。
开工必读：AGENTS.md、CONTRIBUTING.md（职责边界）、docs/wx-minigame-redesign.md、
docs/platform-adapter-v2.md + drafts/platform-adapter-v2.ts（S10 契约——实现以此为准，偏离处必须在汇报中给理由）、
spike/wx-three/README.md（S11 结论：路线 B「自写最小垫片」胜出）+ spike/wx-three/src/shim-min.js、adapter-patch.js。
环境前置：微信开发者工具 + AppID（没有就用占位 appid，完成到构建产物就绪并在汇报中说明验证步骤）。

任务：
1. 按 S10 契约实现 v2：packages/platform（接口与共享纯函数，含从 webPlatform 提取的 swipe/doubleTap 判定）、
   packages/platform-web（改造现实现）、全部调用方（packages/render、packages/game、apps/web）同步修正；
   drafts/platform-adapter-v2.ts 定稿后移入 packages/platform/src（drafts/ 保留指针 README 或删除，汇报说明）。
2. packages/platform-wx 完整实现 v2 + WxExtras（login/share/cloud/readJson/readBinary 占位，S8/S9 实装）；
   垫片按 S11 路线 B：以 shim-min.js 为蓝本做正式化（模块化、类型化、可测试），weapp-adapter 仅兜底并说明触发条件。
3. apps/wx 工程壳：game.js/game.json/project.config.json，接 packages/game 主流程，
   开发者工具模拟器渲染 S11 同款空场景（三色道+地平线，从 packages/render 抽最小复现）。
4. tools/check-import-rules.mjs 增禁令：packages/platform-wx 是唯一允许触碰 wx 全局的包（apps/wx 入口垫片除外）。
5. 边界纪律：不改 config 玩法段数值；不碰 packages/ui（S4 并行中）。

验收：npm run check 全绿；web 壳全流程不回退（启动→登录→菜单→跑一局→结算，?debug 探针正常）；
开发者工具空场景截图或说明 + 帧率/内存初值。
汇报：与 S10 契约的偏离点及理由、垫片正式化结论、遗留给 S6（构建管线）的问题清单。
```

### S4 · UI 自绘框架（波次2 · 正式派发版，已注入 S12/S13 产物，与 S3 并行）

```text
你负责 雷霆酷跑 的自绘 UI 框架（重设计文档 §3.3，M7 前半），分支 feat/s4-uikit，基于 origin/dev。
开工必读：AGENTS.md、CONTRIBUTING.md（职责边界）、docs/wx-minigame-redesign.md §3.3、
spike/ui-layout/API.md + spike/ui-layout/src/*（S13 纯逻辑内核：layout/hit/scroll/button/virtualList/router，82 例测试）、
assets/fonts/README.md + latin/cjk 两张图集与 metrics.json（S12 SDF 规格）。
并行纪律：S3 正在改 packages/platform* 与调用方——你不得修改这些文件；输入先按现有 v1 接口
（packages/platform/src/platformAdapter.ts 现状）+ 一层内部适配，汇报中写明 S3 合入后的切换点。

任务：
1. 把 S13 内核搬入 packages/ui/src（保持模块划分与 API.md 契约），spike/ui-layout 删除（避免双源漂移）；
   其测试全部迁入并接入 npm run check（tests/ 或包内 script 均可）。
2. 渲染绑定层：OrthoOverlay——与主场景共享 WebGLRenderer、独立正交场景、独立 render pass；
   对外 API：createOverlay(host)/mount(view)/unmount()/handleInput(evt)/tick(dt)。
3. SDF 文本：three shader 按 assets/fonts/README.md 的坐标系/scale/spread 约定采样图集，
   Label 支持中英文混排、换行、对齐；图集加载走 resources 接口（web fetch，wx 侧留 S6 接入点）。
4. 控件渲染化：Label/Button/Panel/List/ScrollView 绑定 S13 状态机；九宫格贴片；按压态视觉反馈。
5. ui 手感参数（惯性摩擦/回弹/双击窗口等）进 config/game.json 技术段 ui 节 + schema + configValidator 同步。
6. 演示页：apps/web 挂 ?ui=demo 展示全部控件与中文渲染，供 S5 迁移前验收。

验收：npm run check 全绿（含迁移的 82 例）；?ui=demo 截图或控件清单说明；中文字形渲染质量自查。
汇报：控件 API 终版（S5 迁移依据）、字体渲染参数、与 S3 的耦合点清单（合流时协调者处理）。
```

### S5 · 五页面迁移（波次3）

```text
你负责把 雷霆酷跑 的全部 DOM 页面迁移到自绘 UI（重设计文档 §3.3/§3.4，里程碑 M7），分支 feat/s5-pages。
依赖：S3 的 PlatformAdapter v2 与 S4 的 ui 控件库均已合入（开工前读 packages/ui 与 packages/platform 最新 API）。

任务：
1. 用 S4 控件重建 5 个页面：boot（加载/错误态）、login（游客+测试 openid 输入，走 platform 注入的 login 占位）、
   menu（角色卡片可滑动列表、技能/被动文案、清缓存按钮）、run HUD（分数/金币/buff 槽/技能条，数据源仍是
   runnerScene 的 onHud 推送）、result（得分/最佳/重开/回菜单）。对照现 apps/web 里 screens.ts 的信息与交互逐项映射。
2. bootstrap 主流程改接 overlay UI，删除 screens.ts 及 style.css 中废弃样式；index.html 只剩挂载点。
3. 两端同一套 UI 是验收标准：所有页面代码 0 处 document/window（check-import-rules 会盯）。
4. 键盘快捷键（Esc 退菜单、Enter=游客登录）仅 web 壳经 onKey 注入，逻辑不变。
5. tests 补页面状态流转用例（可在 node 端测 overlay view model，不必渲染像素）；?debug 探针行为不回退。

验收：node tools/check.mjs 全绿 + web 壳全流程手测（启动→登录→选角色→跑一局→结算→重开）+ 与迁移前逐页对照清单。
汇报：页面映射表（DOM 元素→控件）、删除文件清单、接口层发现的不顺手点（给 S6/S7 参考）。
```

### S6 · apps/wx 构建管线（波次3，与 S5 并行）

```text
你负责 雷霆酷跑 的小游戏产物构建（重设计文档 §3.5，衔接 M6→M8），分支 feat/s6-wxbuild。
依赖：S3 已合入（platform-wx + apps/wx 工程壳 + 空场景）。与 S5（页面迁移）并行：你只动构建链路与
apps/wx 壳，不碰 packages/ui 与页面代码；产物里 UI 暂时是 S3 空场景或占位 HUD 即可。

任务：
1. tools/build-wx.mjs + Vite lib 配置：把 packages/* 与 apps/wx 入口 bundle 成小游戏可用的
   CommonJS 产物（微信后台按 CommonJS 处理；目标微信基础库现行版本），输出目录结构见重设计文档 §3.5。
2. 分包落地：game.json subpackages 配好 pkg-assets（字体图集、非默认角色模型与主题贴图、config/*.json）；
   主包产物体积打印进构建日志，硬门槛主包 ≤4MB（超出即 fail）。
3. 资源读取：packages/platform-wx 补 readJson/readBinary：优先 wx.getFileSystemManager 读分包资源，
   网络 URL 走 wx.downloadFile（为 S8 的 CDN 预留同一接口）。config 装载链（configLoader 的 FileSource）
   切到该接口，web 壳继续用 fetch——两端 config 内容保持同源。
4. 开发者工具验证：给出「用微信开发者工具打开 apps/wx/dist 并看到空场景」的步骤；若装了 CLI，
   构建脚本尾部提示/自动调用预览刷新（auto 预览 token 缺失则跳过并说明）。
5. tools/check.mjs 增加第 5 步：node tools/build-wx.mjs --dry（只 bundle 校验不发布），全链路防回归。

验收：node tools/check.mjs 全绿（含新第 5 步）；开发者工具模拟器截图：分包加载日志 + 主包体积数字。
汇报：产物目录树、主包/分包体积表、留给 S7 的真机验证清单与 S8 的 CDN 接口点。
```

### S7 · 真机性能验证 + 降级预案（波次4，M6 验收）

```text
你负责 雷霆酷跑 小游戏的真机质量关（重设计文档 §7 风险1，里程碑 M6/M8 间），分支 feat/s7-perf。
依赖：S5+S6 已合入，小游戏端可完整玩一局。需要用户提供真机（含一台低端安卓）与体验版权限——
拿不到真机就止步于「云测平台报告 + 开发者工具性能面板数据」并报告阻塞。

任务：
1. 建立测量基线：帧率/内存/首屏时间，设备矩阵 ≥3 档（iOS、高端安卓、低端安卓），
   用微信真机调试 + 性能监控面板，数据记录进 docs/perf-baseline.md。
2. 定位并修复明显热点（只允许改 packages/render 与新增性能开关，不动 core 逻辑——core 有确定性单测护航）。
3. 实现画质分级（config/game.json 新增 quality 段 + schema + docs 参数表同步，重设计 §4 同步链）：
   high/medium/low 三档控制 dpr 上限、粒子数量、云团/金币实例数上限、阴影类后处理有无；
   默认按设备 API 自动选档，debug 入口可手动覆盖。低档目标：低端安卓 ≥30fps、内存 <400MB。
4. 不达标预案：给出「材质降级/合并 drawcall/30fps 锁帧」的具体收益测量数据与建议。

验收：node tools/check.mjs 全绿；docs/perf-baseline.md 完成；各档实测数字表。
汇报：设备×画质矩阵、修复清单、是否判定 M6 通过（协调者据此放行 S8/S9 或插整改任务）。
```

### S8 · 内容管线：CDN + 配置热更新（波次4，T2.5 复活）

```text
你负责 雷霆酷跑 的资源分发与配置热更新（重设计文档 §3.5，原 T2.5），分支 feat/s8-content。
依赖：S6 的 readJson/readBinary 与分包结构。存储后端选型：优先微信云开发存储（需用户提供云环境 ID；
没有就先用「任意 CDN URL + 本地 config 兜底」实现完整接口，环境就绪只换 URL 配置）。

任务：
1. manifest 方案：版本清单 json（各 config 文件哈希+URL+最低兼容客户端版本）；
   configLoader 增加远端源优先级：manifest → CDN 新哈希 → 分包内置兜底；离线/失败静默降级到内置并打点。
2. 本地缓存策略：wx 文件缓存 + web localStorage 走同一套 cacheKey 规范（现有 thunderrun:config: 前缀演进，
   保持菜单页「清缓存」按钮语义不变，且 S5 后该按钮在自绘 UI 里）。
3. 构建侧：tools/publish-content.mjs——把 config/*.json 生成 manifest（含 diff 提示）并上传
   （云环境就绪用 wx cloud 上传，否则本地目录模式 + 部署说明文档）。
4. 防呆：远端配置过 configValidator（同 T0.4 逻辑）才允许热应用；校验失败保留旧版本并上报
   ——「配了但没效果」与「配错炸客户端」都不许发生。
5. 测试：manifest 解析/降级链/校验拦截的用例进 tests（node 端可测，mock FileSource）。

验收：node tools/check.mjs 全绿；演示一次「改 game.json 数值→publish→客户端拉到新值」的完整流程记录。
汇报：manifest schema、降级链决策表、留给 S9 的云环境共用点。
注意：config 数值改动仍受 docs 库双向同步约束（AGENTS.md §4），改动清单在汇报里列出以便知会作者。
```

### S9 · 平台能力：登录/排行/分享/存档（波次5，M9）

```text
你负责 雷霆酷跑 的微信开放能力接入（重设计文档 §6，里程碑 M9），分支 feat/s9-social。
依赖：S6 构建链 + S8 云环境结论。开工前确认：AppID 正式可用、云开发环境已开通、主体类型已定。

任务（按独立子项推进，可分多次 commit）：
1. 登录：platform-wx 的 WxExtras.login 实装（wx.login → code → 云函数换 openid/session），
   packages/game 的登录态从「本地假校验」切到真实 openid；bestScore/角色选择以 openid 为主键迁移到
   云开发 DB（本地缓存继续做离线兜底，换机不丢档）。
2. 好友排行榜：开放数据域独立入口（子包 openDataContext）：渲染 bestScore 榜，主域 postMessage 传分数；
   开放数据域 API 受限的坑记录进 docs。UI 榜单位置在 S5 迁移后的 menu/result 里加入口（跨 packages/ui 改动，
   保持控件层 API 不变，只加 view）。
3. 分享：onShareAppMessage 定向分享（结算页「炫耀一下」带分数口令）、被动侧分享回流场景值识别。
4. 预留不实装：订阅消息、IAA 广告位、虚拟支付——只在 WxExtras 定义接口与 TODO 注释，等运营决策。
5. 隐私合规：用户协议/隐私政策入口（设置页或菜单角落），收集 openid 的声明文案。

验收：node tools/check.mjs 全绿；体验版真机演示：登录→刷分→重启换设备登录→榜单可见。
汇报：各子项状态、云环境资源用量初值、审核材料缺口（自审报告/隐私接口声明）。
```

## 2.5 波次1.5 提示词（与 S2 并行，只新增文件）

### S10 · PlatformAdapter v2 接口规格（纯设计）

```text
你负责为 雷霆酷跑 设计 PlatformAdapter v2 接口规格（分支 feat/s10-adapter-spec，基于 dev）。
先读 AGENTS.md、docs/wx-minigame-redesign.md §3.1、src/platform/platformAdapter.ts（现 v1）。
约束：只新增文件，禁止修改任何既有文件（另一会话正在做全量目录搬迁）。
产出：
1. docs/platform-adapter-v2.md：完整接口签名——CanvasFactory（去 DOM 类型的 WebGL canvas 抽象）、
   onInput（手势+键盘统一事件模型）、storage/fetchJson/requestFrame/cancelFrame/onVisibility/now、
   WxExtras 可选注入接口（login/share/cloud/readJson/readBinary，S8/S9 用）；
   每个方法的 web/wx 实现映射表；迁移注记：render/game/ui 哪些调用点需要改、怎么改。
2. drafts/platform-adapter-v2.ts：可编译的类型草案（含最小 wx 全局类型声明，自包含），
   用 node tools/vendor/typescript/lib/tsc.js --noEmit 单独验证（不要挂进仓库 tsconfig）。
验收：类型草案 --noEmit 通过；v1 接口所有方法在规格中 100% 有去向（保留/改名/合并/删除+理由）。
汇报：接口关键设计决策清单（协调者评审后下发 S3/S4 作为实现契约）。
```

### S11 · three×微信小游戏可行性 spike（M6 最大风险前置）

```text
你负责 雷霆酷跑 的 three.js×微信小游戏可行性 spike（分支 feat/s11-wx-spike，基于 dev），
这是 docs/wx-minigame-redesign.md §7 风险1 的前置验证。先读 AGENTS.md 与该文档 §3.2。
约束：只在 spike/wx-three/ 下新增文件（自带 package.json，npm i three 用与 vendor 一致的版本），
禁止修改仓库任何既有文件。
任务：
1. 最小小游戏工程：game.js/game.json/project.config.json（appid 占位），three 渲染
   旋转立方体 + 一张纹理贴图平面，固定步长 60fps 循环，触摸事件打日志。
2. 对比两条垫片路线并给出选择：A) 官方 weapp-adapter；B) 自写最小垫片（只喂 WebGLRenderer 必需的
   canvas/getContext/全局对象）。记录各自坑点：纹理加载(Image/createImageBitmap)、DPR、canvas 事件、内存。
3. 用微信开发者工具跑通并记录性能面板帧率/内存基线；写一份真机测试步骤清单（协调者转交用户执行）。
开发者工具不可用则：完成全部构建产物+文档后报告阻塞。
产出：spike/wx-three/ 工程 + spike/wx-three/README.md（路线结论、坑清单、给 platform-wx 的垫片形态建议）。
汇报：A/B 路线结论与依据、性能数字、S3 必须规避的坑清单。
```

### S12 · SDF 字体工具链（S4 前置）

```text
你负责 雷霆酷跑 的 SDF 位图字体工具链（分支 feat/s12-sdf-font，基于 dev），供 S4 自绘 UI 的 Label 使用。
先读 AGENTS.md 与 docs/wx-minigame-redesign.md §3.3。
约束：只新增文件；工具自包含在 tools/fontgen/（自己的 package.json，可用 opentype.js、tiny-sdf 等，
不要改根 package.json——另一会话正在搬迁工程结构）；生成产物放 assets/fonts/。
任务：
1. tools/fontgen/gen.mjs：输入 TTF + 字符集清单，输出 SDF 图集 PNG（padding/尺寸可配）+
   metrics.json（每字形 bbox/advance/scale 约定）。系统字体先探测可用性（C:\Windows\Fonts\simhei.ttf、msyh.ttc 等）。
2. tools/fontgen/charset.mjs：扫描 src/ui/screens.ts 与 config/*.json 出现的全部中文字符+ASCII 可打印集，
   输出 charset.txt（dev 基线上 screens.ts 还在 src/ui/，按此路径）。
3. assets/fonts/README.md：使用规格——坐标系、SDF spread/size 参数、three shader 采样约定，S4 照此对接。
4. tests/fontgen.test.mjs（node:test）：生成确定性（同输入两次产物哈希一致）、metrics 字段完备、
   字符集覆盖；只 import tools/fontgen 不 import dist；fontgen 依赖未安装时用例 skip 并提示安装命令。
5. 实际生成 latin+中文 两张图集并自查可读（尺寸/字数写进汇报）。
验收：node --test tests/fontgen.test.mjs 全绿（或依赖缺失时 skip 逻辑正确）。
汇报：产物清单、图集尺寸/字符数、SDF 参数、给 S4 的接口约定摘要。
```

### S13 · UI 布局/命中纯逻辑内核（S4 前置）

```text
你负责 雷霆酷跑 自绘 UI 的纯逻辑内核原型（分支 feat/s13-ui-layout，基于 dev），供 S4 搬运进 packages/ui。
先读 AGENTS.md、docs/wx-minigame-redesign.md §3.3、src/ui/screens.ts（现有页面的布局与交互需求）。
约束：只在 spike/ui-layout/ 下新增文件（自带 tsconfig+package.json，不改根 package.json）；
纯 TS：禁止 import three/DOM/仓库 src 代码——产物必须能整体平移进 packages/ui。
任务：
1. 布局引擎：flex 子集（row/column、gap/padding/margin、align/justify、固定+百分比尺寸、滚动裁剪），
   输入约束树输出矩形树，纯函数无副作用。
2. 命中与手势分发：矩形树命中测试、冒泡/捕获、按压态生命周期；ScrollView 惯性滚动物理
   （摩擦/回弹，参数化，手感参数结构对齐 config/game.json 未来 ui 段）。
3. 控件状态机：Button(normal/pressed/disabled)、List 虚拟滚动窗口计算（S4 按窗口渲染可见项）。
4. node:test ≥30 例：嵌套布局、百分比、滚动裁剪、命中优先级、惯性衰减收敛、回弹、虚拟窗口边界。
   测试跑在 spike 内部（npm test），不挂根 check.mjs，避免干扰搬迁会话。
5. spike/ui-layout/API.md：对外 API 契约（S4 接 three overlay 的唯一依据）。
验收：spike 内 npm i && npm test 全绿。
汇报：API 摘要、用例数、明确不支持的 CSS 特性清单。
```

### S14 · config 热更新 manifest 原型（S8 前置）

```text
你负责 雷霆酷跑 的配置热更新 manifest 原型（分支 feat/s14-manifest，基于 dev），供 S8（原 T2.5）。
先读 AGENTS.md、docs/wx-minigame-redesign.md §3.5、src/core/config/configLoader.ts（现有缓存链）。
约束：只新增文件（tools/publish-content.mjs、docs/manifest-schema.md、tests/manifest.test.mjs），
不改任何既有文件；工具只用 node 内置模块（sha256 用 node:crypto），零新依赖。
任务：
1. docs/manifest-schema.md：manifest 结构（版本号/每文件 sha256/URL/minClient）；客户端拉取降级链
   （manifest→CDN 新哈希→包内兜底）；缓存键规范（兼容现有 thunderrun:config: 前缀的演进方案）；失败策略表。
2. tools/publish-content.mjs：扫描 config/*.json 生成 manifest.json + 产物复制到 out/（本地目录模拟 CDN）；
   --diff 对比上次 manifest 输出变更清单；--upload 留接口（S8 接云存储时实装）。
3. tests/manifest.test.mjs：生成确定性、diff 正确、哈希校验、降级链决策（mock FileSource）；
   不 import dist（避免与搬迁会话耦合）。
4. 本任务不许改 config/*.json 的任何数值（只读）；提醒：config 数值改动需 docs 库双向同步。
验收：node --test tests/manifest.test.mjs 全绿；演示一次生成 + --diff 输出。
汇报：schema 要点、降级链决策表、给 S8 的接口预留点。
```

### S15 · CI/CD 门禁（波次2，零依赖，可立即）

```text
你负责 雷霆酷跑 的 CI/CD（docs/framework-roadmap.md §3 S15），分支 feat/s15-ci，基于 origin/dev。
只新增 .github/ 下文件 + README 顶部 badge 行（README 其余内容不动）。先读 AGENTS.md、CONTRIBUTING.md。

任务：
1. .github/workflows/ci.yml：on pull_request(base=dev) + push(dev/main)；
   步骤：npm ci → npm run build → npm install --prefix tools/fontgen → npm test →
   node tools/validate-config.mjs → node tools/check-import-rules.mjs → npm run build:web；npm 缓存开启。
2. 矩阵 ubuntu-latest + windows-latest：验证 tools/fontgen 用例在 ubuntu（无中文系统字体）的 skip 行为——
   若失败而非 skip，优先在 CI 层按平台跳过该测试组；确需改 fontgen 源码要在汇报中说明理由。
3. 预留 wx-artifact job（注释占位）：S6 落地后接入产物构建 + 主包 4MB 体积门禁 + artifact 上传，写清接入点。
4. README 加 CI badge（dev 分支）。

验收：push 后 GitHub Actions 在 dev 分支的 run 双平台全绿。
汇报：run 链接、耗时、fontgen 在 ubuntu 的行为、给 S6 的接入点说明。
```

### S19a · golden-master 回归 + 输入重放格式（波次2，纯新增，可立即）

```text
你负责 雷霆酷跑 测试基建 a 段（docs/framework-roadmap.md §3 S19a），分支 feat/s19a-replay，基于 origin/dev。
必读：AGENTS.md、CONTRIBUTING.md、packages/core/src/sim/runnerSim.ts 公开 API（确定性 sim，同 seed 同输入必同结果）。
并行纪律：尽量零修改既有文件；确需 core 挂钩子必须做成可选参数的加法式 API，汇报中单独说明。

任务：
1. docs/replay-format.md：输入重放格式 v1——结构含 version/seed/charId/固定步长/输入事件序列 {frame,type,payload}，
   事件形状对齐 packages/platform 的 Gesture/onKey 类型；给出示例文件与扩展规则（版本演进策略）。
2. tools/replay/：runner.mjs（node 无头加载重放文件驱动 RunnerSim，输出结果摘要）、
   recorder.mjs（程序化生成重放：脚本化输入序列→重放文件）。
3. golden-master：tools/replay/golden-gen.mjs 以固定 seed 集（≥5 条赛道 × 3 角色）+ 脚本化输入生成
   tests/golden/*.json（终局分数/金币/距离/事件序列哈希/结算摘要）；tests/golden.test.mjs 逐项对比，
   失败输出可读 diff 摘要；重新生成必须显式 --update（防静默漂移）。
4. 有效性自证：临时改一个 sim 物理常量让 golden 变红（截图/输出记录进汇报后还原）。

验收：npm run check 全绿（含新用例）；golden 文件可复现（连续两次生成哈希一致）。
汇报：格式规范要点、golden 覆盖矩阵、core 加法改动（如有）、给 S18（云复跑防作弊）的复用点。
```

### S16a · 遥测与日志框架接口规格（波次2，纯设计，可立即）

```text
你负责为 雷霆酷跑 设计遥测与日志框架的接口规格（S16a，分支 feat/s16a-telemetry-spec，基于 origin/dev）。
必读：AGENTS.md、CONTRIBUTING.md、docs/framework-roadmap.md §3 S16、docs/platform-adapter-v2.md（S10 契约，
遥测将挂在 v2 平台上）、docs/manifest-schema.md（热更新命中率埋点对接）、docs/replay-format.md（数据形状对齐）。
约束：只新增文件（docs/telemetry-spec.md + drafts/telemetry.ts），禁止修改任何既有文件——S3/S4 正在并行改 packages/*。

任务：
1. docs/telemetry-spec.md：log/metric/error 三通道接口（级别、采样、限流、批量刷写、会话标识）；
   web 实现映射（console+缓冲+sendBeacon）与 wx 实现映射（wx.getRealtimeLogManager 实时日志、云数据库上报）；
   关键埋点清单：首屏耗时（boot 分阶段打点）、局内帧时间分布（p50/p95）、内存水位（wx.getPerformance）、
   配置热更新命中率、崩溃栈与 unhandledrejection；
   config 技术段 telemetry 节设计（采样率/开关/批量大小）+ schema/configValidator 同步说明。
2. drafts/telemetry.ts：可编译类型草案（Telemetry 接口+事件类型+no-op 实现签名），
   npx tsc --noEmit 单独验证，不挂仓库 tsconfig。
3. 与 S18（防作弊上报）、S19b（perf bench）的数据形状对齐：复用 eventsSha256/结果摘要结构。
验收：类型草案 --noEmit 通过；埋点清单覆盖 framework-roadmap §3 S16 全部条目。
汇报：接口设计决策清单、埋点清单、给 S16b（实现，依赖 S3 合入）的拆分建议。
```

## 3. 状态登记板

| 会话 | 任务 | 波次 | 依赖 | 状态 | 分支 | 备注 |
|------|------|------|------|------|------|------|
| S1 | 工具小修 | 0 | - | 已合并@4dbd1bc | feat/s1-toolfix | check.mjs ALL PASS，92/92 |
| S2 | monorepo 搬迁 | 1 | S1(已吸收) | 已合并@7698848 | feat/s2-workspace | check ALL PASS；提交曾误落 s11 分支，已修正指针 |
| S3 | 平台层 v2+wx 骨架 | 2 | S2✓ | 已合并@7141d65 | feat/s3-platform-v2 | issue #1 已关；platform v2 双实现+apps/wx 空场景+build-wx.mjs 初版 |
| S4 | UI 框架内核 | 2 | S2✓ | 已合并@d2110a6 | feat/s4-uikit | issue #2 已关；含 fontgen SDF 内腔缺陷修复；契约 packages/ui/API.md |
| S5 | 页面迁移 | 3 | S3✓,S4✓ | 就绪可派 | feat/s5-pages | 按 packages/ui/API.md + packages/game views 接口 |
| S6 | wx 构建管线 | 3 | S3✓ | 就绪可派 | feat/s6-wxbuild | 以 tools/build-wx.mjs 为起点；与 S5 并行 |
| S7 | 真机性能关 | 4 | S5,S6 | 待派发 | feat/s7-perf | 需真机 |
| S8 | CDN+热更新 | 4 | S6 | 待派发 | feat/s8-content | 需云环境 |
| S9 | 社交/登录/存档 | 5 | S6,S8 | 待派发 | feat/s9-social | 需正式 AppID |
| S10 | Adapter v2 规格 | 1.5 | - | 已合并@13dbfb6 | feat/s10-adapter-spec | docs/platform-adapter-v2.md + drafts/ 类型草案 |
| S11 | three×wx spike | 1.5 | - | 已合并@25aa909 | feat/s11-wx-spike | 结论：路线B最小垫片胜出，见 spike/wx-three/README.md |
| S12 | SDF 字体工具链 | 1.5 | - | 已合并@a68b68d | feat/s12-sdf-font | assets/fonts 图集+metrics；9/9 用例绿 |
| S13 | UI 布局纯逻辑内核 | 1.5 | - | 已合并@ce82749 | feat/s13-ui-layout | spike/ui-layout，82 例绿，API.md 为 S4 契约 |
| S14 | manifest 原型 | 1.5 | - | 已合并@138a074 | feat/s14-manifest | docs/manifest-schema.md + publish-content.mjs，22 例绿 |
| S15 | CI/CD 门禁 | 2 | - | 已合并(PR#5) | feat/s15-ci | CI 双平台绿（run 36371594917）；issue #3 已关 |
| S19a | golden-master+输入重放 | 2 | - | 已合并@1ef3481 | feat/s19a-replay | 155/155 绿；issue #4 已关；golden 与 config 玩法段绑定，改数值需审查后 --update |
| S16a | 遥测接口规格 | 2 | - | 已合并@a869e47 | feat/s16a-telemetry-spec | docs/telemetry-spec.md + drafts/telemetry.ts |
| S16b | 遥测/日志实现 | 3 | S3✓,S16a✓ | 就绪可派 | feat/s16-telemetry | 契约见 docs/telemetry-spec.md |
| S17 | 音频框架 | 3 | S3✓ | 就绪可派 | feat/s17-audio | 资源由内容侧投放 |
| S19b | UI 快照+perf bench | 4 | S4,S6 | 待派发 | feat/s19b-bench | |
| S18 | 存档防作弊(云复跑) | 5 | S9,S19a | 待派发 | feat/s18-anticheat | 确定性 sim 复跑校验 |

状态取值：待派发 / 进行中 / 阻塞:<原因> / 待评审 / 已合并@<commit>

## 4. 协调者规则（我自己遵守）

- 你汇报状态时，我只做三件事：更新登记板 → 判定是否放行下游 → 必要时改写尚未派发的提示词（接口变化传导）。
- 已派发会话的提示词不再改；其产出的接口漂移由合并评审吸收，冲突时先合入者赢，后者 rebase。
- 波次1 是唯一硬串行点；S3/S4、S5/S6、S7/S8 是安全并行对。
- 波次1.5（S10-S14）与 S2 并行：全部约束为纯新增文件，互相之间及与 S2 均零路径冲突，任意顺序合入 dev。
  合并后把各会话汇报（接口契约/坑清单/schema）注入对应下游会话（S3←S10+S11、S4←S12+S13、S6←S11、S8←S14）的派发提示词。
- 涉及 config/*.json 的改动，合并前检查「docs 库同步」待办是否记入汇报。
