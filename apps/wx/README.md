# apps/wx —— 微信小游戏工程壳（S3 骨架）

> dist/ 为构建产物（不入库）；本目录的 `game.json` / `project.config.json` 是源模板，
> `src/main.ts` 是入口，`tools/build-wx.mjs` 把两者组装成 dist。

## 构建 + 模拟器验证步骤（无微信开发者工具时的交接清单）

```bash
npm run build:wx     # tsc -b 全仓 → esbuild 打包 → apps/wx/dist（game.js + game.json + project.config.json + config/）
```

1. 安装微信开发者工具（stable 版），登录任意微信号（游客模式即可，无需自有 AppID）。
2. 「导入项目」选择 `apps/wx/dist/` 目录；AppID 选「游客模式」（project.config.json 已预填 `touristappid`）。
3. 编译运行，预期：
   - 模拟器渲染**三色道 + 地平线**空场景，路面虚线向前滚动（S11 同款验收场景）；
   - Console 有 `[tr] adapter v2 ready {"env":"wx",...}`、`[tr-wx] boot {...}`，每 2s 一条 `[tr-wx] stats {...}`；
   - `__trWx.stats()` 可在 Console 手动查询（fps/窗口尺寸/dpr）。
4. 性能初值采集：开发者工具「调试器 → 性能」面板录制 30s，记录 FPS 均值与 JS 内存，回填
   `spike/wx-three/README.md` §7 表格（同口径），PR 附截图。
5. 触摸链路：模拟器里点击/滑动会走 platform-wx 输入 → GestureClassifier；
   空场景暂无消费者，日志可在 Console 用 `__trWx.adapter.onInput(e => console.log(e))` 现场订阅。

## 已知边界（S6 构建管线待办）

- 分包/主包体积策略、`wx.loadSubpackage`、CDN 降级链 → S6/S8；
- devtools「代码保护」与 minify 对照、`cli upload` 体验版自动化 → S6；
- `es6` 转换已在 project.config 关闭（bundle 目标是 es2017，v8 原生跑）；其他机器如遇基础库过旧再开。
- 真机（尤其 iOS）WebGL2 需要 `game.json` 的 `iOSHighPerformance:true`（S11 K8），已在模板配置。
