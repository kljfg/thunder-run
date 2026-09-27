# 会话协调计划（小游戏重设计 · S 系列任务）

> 协调者会话负责本文件的维护：任务分派、状态登记、集成裁决。执行会话只跑自己被分配的提示词。
> 决策基线见 `docs/wx-minigame-redesign.md`。

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
波次2  S3 平台层 v2 + platform-wx 骨架 + three 空场景跑通  [依赖 S2]
       S4 UI 自绘框架内核（控件库+SDF 工具链）             [依赖 S2]
波次3  S5 五页面迁移（screens.ts 退役）                    [依赖 S3+S4]
       S6 apps/wx 构建管线（game.json/分包/产物组装）       [依赖 S3]
波次4  S7 真机性能验证+降级预案（M6 验收）                 [依赖 S5+S6]
       S8 内容管线：分包资源+config 热更新 manifest(T2.5)  [依赖 S6]
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

### S3 · 平台层 v2 + wx 骨架 + three 空场景（波次2，M6 前半）

```text
你负责 雷霆酷跑 的平台抽象层重设计与微信小游戏侧骨架（重设计文档 §3.1、§3.2、M6），分支 feat/s3-platform-v2。
基于已合入的新 workspace 结构（先读 S2 汇报的接口签名约定——如缺，读 packages/platform 现状）。
前置环境：用户应已装微信开发者工具与 AppID；若缺则本会话完成到「构建产物就绪 + 文档说明如何验证」为止并报告阻塞。

任务：
1. PlatformAdapter v2：去除一切 DOM 类型（HTMLElement/HTMLCanvasElement/window），改为文档 §3.1 的
   结构化最小接口（CanvasFactory、onInput 合并手势与键盘、storage/fetchJson/frame/visibility/now 保签名）。
   接口变更要同步 packages/platform-web 实现与全部调用方（render/game），保持编译通过。
2. 新建 packages/platform-wx：wx 全局类型声明（wx-miniprogram 官方 types 或手写核心面），
   实现 v2 接口：canvas 工厂（wx.createCanvas 首个=屏幕画布）、wx.onTouch*→Gesture 归一化
   （复用 webPlatform 的 swipe/doubleTap 判定逻辑，把该纯函数提取到 packages/platform 共享）、
   storage→wx.setStorageSync、fetchJson→wx.request、frame→requestAnimationFrame（wx 有）、visibility→wx.onShow/Hide。
   另建 WxExtras 可选注入接口：login/share/cloud 先占位（S9 实装），web 壳给 no-op。
3. apps/wx 工程壳：game.js 入口（加载 adapter 垫片 → require 主包产物）、game.json（竖屏、分包占位）、
   project.config.json（appid 用占位串并在汇报中提醒替换）。
4. three 空场景跑通：用最小 weapp-adapter 垫片策略——优先在 platform-wx 里给 WebGLRenderer 喂最小环境，
   确实不可行才引入官方 weapp-adapter 并说明原因。目标：开发者工具模拟器里渲染出「三色道+地平线」空场景
   （从 packages/render 现有 trackVisuals 抽最小复现，不要求完整场景）。
5. check-import-rules 增加：packages/platform-wx 是唯一允许触碰 wx 全局的包（apps/wx 入口垫片除外）。

验收：node tools/check.mjs 全绿；apps/web 调试壳功能不回退；开发者工具截图或说明空场景结果；
低端机风险记录（真机测不了的说明清楚）。
汇报：v2 接口最终签名、垫片方案结论（自研最小 vs weapp-adapter）、遗留到 S6 的构建问题清单。
```

### S4 · UI 自绘框架内核（波次2，与 S3 并行）

```text
你负责 雷霆酷跑 的自绘 UI 框架内核（重设计文档 §3.3），分支 feat/s4-uikit。
基于新 workspace 结构，只在 packages/ui 内工作（可加 dev 依赖），不得改 packages/render、platform 相关
（另一会话在做平台层；你只依赖 three 的场景对象与正交相机，渲染入口设计成「宿主传入 renderer 与叠加时机」的回调式，
避免直接 import 平台代码）。先读 AGENTS.md + docs/wx-minigame-redesign.md。

任务：
1. packages/ui：OrthoOverlay 设计——与主场景共享 WebGLRenderer，独立正交场景 + 独立 render pass；
   对外 API：createOverlay(host) / mount(view) / unmount() / handleInput(gestureOrHit) / tick(dt)。
2. 控件：Label、Button、Panel、List(纵向滚动)、ScrollView、九宫格贴片、简易 flex 子集布局引擎（自写，无新运行时依赖）。
3. 文本：SDF 位图字体方案。tools/gen-font.mjs：输入 ttf（找系统字体，如 微软雅黑 simhei 等可用者）
   + 字符集清单，输出 图集 png + metrics json；Latin + 游戏文案用到的中文集（扫描现有 screens.ts 与 config 里的中文字符）。
   Label 用 three mesh+shader 渲染 SDF 图集。
4. 交互与命中：控件矩形命中测试、按压态、滚动惯性（手感参数进 config/game.json 新 ui 段并同步 schema——注意 §4 的同步链）。
5. 演示页：apps/web 挂一条 debug 路由（如 ?ui=demo）展示全部控件，供 S5 迁移前验收；node:test 补布局引擎与命中测试用例。

验收：node tools/check.mjs 全绿；?ui=demo 页面截图或控件清单说明；新单测数量与覆盖点。
汇报：控件 API 清单（S5 直接照此迁移页面）、字体工具用法、性能注意点。
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

## 3. 状态登记板

| 会话 | 任务 | 波次 | 依赖 | 状态 | 分支 | 备注 |
|------|------|------|------|------|------|------|
| S1 | 工具小修 | 0 | - | 已合并@663a4bb | feat/s1-toolfix | check.mjs ALL PASS，92/92 |
| S2 | monorepo 搬迁 | 1 | S1(已吸收) | 进行中 | feat/s2-workspace | 基于 S1 提交创建，合入前冻结其他任务 |
| S3 | 平台层 v2+wx 骨架 | 2 | S2 | 待派发 | feat/s3-platform-v2 | |
| S4 | UI 框架内核 | 2 | S2 | 待派发 | feat/s4-uikit | 与 S3 并行 |
| S5 | 页面迁移 | 3 | S3,S4 | 待派发 | feat/s5-pages | |
| S6 | wx 构建管线 | 3 | S3 | 待派发 | feat/s6-wxbuild | 与 S5 并行 |
| S7 | 真机性能关 | 4 | S5,S6 | 待派发 | feat/s7-perf | 需真机 |
| S8 | CDN+热更新 | 4 | S6 | 待派发 | feat/s8-content | 需云环境 |
| S9 | 社交/登录/存档 | 5 | S6,S8 | 待派发 | feat/s9-social | 需正式 AppID |

状态取值：待派发 / 进行中 / 阻塞:<原因> / 待评审 / 已合并@<commit>

## 4. 协调者规则（我自己遵守）

- 你汇报状态时，我只做三件事：更新登记板 → 判定是否放行下游 → 必要时改写尚未派发的提示词（接口变化传导）。
- 已派发会话的提示词不再改；其产出的接口漂移由合并评审吸收，冲突时先合入者赢，后者 rebase。
- 波次1 是唯一硬串行点；S3/S4、S5/S6、S7/S8 是安全并行对。
- 涉及 config/*.json 的改动，合并前检查「docs 库同步」待办是否记入汇报。
