# apps/wx —— 微信小游戏工程（S3 骨架 + S6 构建管线）

> dist/ 为构建产物（不入库）；本目录的 `game.json` / `project.config.json` 是源模板，
> `src/main.ts` 是入口，`tools/build-wx.mjs` 把两者 + 分包资源组装成 dist。

## 产物结构（redesign §3.5，`npm run build:wx` 生成）

```
apps/wx/dist/
├── game.js                # 入口 iife bundle（esbuild：three + packages/* + 本入口，es2017，tree-shaking）
├── game.json              # 含 subpackages: [{ name: "pkg-assets", root: "pkg-assets" }]
├── project.config.json    # 开发者工具工程配置（appid: touristappid）
└── pkg-assets/            # 资源分包（主包体积不含此目录）
    ├── config/            # config/*.json 8 个（仓库根单一来源，构建时拷贝）
    ├── assets/fonts/      # SDF 字体图集（latin/cjk .png + .metrics.json）
    ├── characters/…       # 非默认角色/皮肤资源占位（S8 落真实资源，路径约定见 placeholder.json）
    ├── themes/…           # 非默认主题资源占位
    └── manifest.json      # 占位清单（S8 CDN/热更接管的接口点）
```

主包 = 引擎 + 启动流程（空场景）；其余全部进 pkg-assets 分包。体积门禁：
`node tools/check-wx-size.mjs`（主包 >4MB 或整包 >30MB 即 fail，构建时自动打印体积表）。

## 构建 + 开发者工具验证步骤

```bash
npm run build:wx           # tsc -b 全仓产物 → esbuild bundle → 组装 dist（默认不压缩；-- --minify 可加）
npm run build:wx -- --minify   # 压缩产物（CI 用这个 + check-wx-size）
```

1. 安装微信开发者工具（stable 版），登录任意微信号（游客模式即可，无需自有 AppID）。
2. 「导入项目」选择 `apps/wx/dist/` 目录；AppID 选「游客模式」（project.config.json 已预填 `touristappid`）。
3. 编译运行，预期：
   - 模拟器渲染**三色道 + 地平线**空场景，路面虚线向前滚动（S11 同款验收场景）；
   - Console 依次出现：
     - `[tr] adapter v2 ready {"env":"wx",...}`、`[tr-wx] boot {...}`（场景先起，不等分包）；
     - `[tr-wx] subpackage pkg-assets loaded in XXms`（`wx.loadSubpackage` 时序，任务 2）；
     - `[tr-wx] config chain {"ok":true,"sources":{...}}`（分包内 config 经 `extras.readJson` →
       `core.loadAllConfig` 校验通过，任务 4 的 wx 侧装载链；sources 全为 `network` 即包内直读成功）；
     - 每 2s 一条 `[tr-wx] stats {...}`。
   - S5（自绘 UI）未合入前没有页面 HUD，属预期；合入后本入口切 `createGameFlow`（见 main.ts 头注释）。
4. Console 探针：`__trWx.stats()`（fps/窗口/dpr）、`__trWx.configReport()`（装载链结果，未就绪为 null）、
   `__trWx.loadAssets()`（手动重跑装载链）、`__trWx.dispose()`。
5. 性能初值采集（S7 真机清单前置）：「调试器 → 性能」面板录制 30s，记录 FPS 均值与 JS 内存，回填
   `spike/wx-three/README.md` §7 表格（同口径），PR 附截图。
6. 触摸链路：`__trWx.adapter.onInput(e => console.log(e))` 现场订阅（空场景暂无消费者）。

## 已知边界与下游接口点

- **分包读取时序**：`pkg-assets` 内文件必须 `wx.loadSubpackage` 成功后才可读（main.ts 已按此链）；
  旧基础库/无 `wx.loadSubpackage` 环境会打 warn 降级（包内路径仍可读，真机复验留 S7）。
- **S8 CDN/热更接口点**：装载链的取数函数就是 `adapter.extras.readJson(path)`（network.ts：包内路径走
  `getFileSystemManager().readFile`，`http(s)` 走 `downloadFile→readFile`）；manifest 见 `pkg-assets/manifest.json`。
- **S5/S20 接线**：createGameFlow 接入后，wx 侧 config 应改经 `extras.readJson` 优先源
  （packages/game mainFlow.ts:106 注释已预留）；web 侧 fetch 链不变。
- **S16b**：main.ts 的 2s stats setInterval 由遥测正式通道接管后移除。
- devtools「代码保护」与 minify 对照、`cli upload` 体验版自动化 → S7/S9（需正式 AppID）。
- `es6` 转换已在 project.config 关闭（bundle 目标 es2017，v8 原生跑，S11 K10 结论）；基础库过旧的机器再开。
- 真机（尤其 iOS）WebGL2 依赖 `game.json` 的 `iOSHighPerformance:true`（S11 K8），已配置。
