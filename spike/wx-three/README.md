# S11 spike：three.js × 微信小游戏可行性验证

> docs/wx-minigame-redesign.md §7 风险1 的前置验证。分支 feat/s11-wx-spike。
> 本目录自包含（自带 package.json / node_modules 不入库），不触碰仓库任何既有文件。
> three 版本与 vendor 一致：0.160.1（r160）。

## 1. 结论（TL;DR）

**选路线 B：自写最小垫片。** 官方 weapp-adapter（路线 A）只保留为"第三方库硬依赖 DOM 时的兜底"。

依据（全部源码级证据 + 自动化验证）：

1. three r160 的 `WebGLRenderer` 在**显式传入 canvas** 时对全局环境零要求：
   `window`/`navigator`/`performance`/`WebGLRenderingContext` 全部有 `typeof` 守卫
   （vendor/three/build/three.module.js:53030 / :24000 / :47162 / :28680）。
   对 canvas 的真实要求只有 4 条：`getContext`、`width/height` 可写、
   `addEventListener/removeEventListener`（webglcontext* 三事件，:28648）、
   `'setAttribute' in canvas` 为 false 时自动跳过（:28645）。
   `canvas.style` 可用 `setSize(w,h,false)` 完全避开（:28834）。
   → 最小垫片 = 给 wx 画布补两个事件方法，**约 50 行**（src/shim-min.js）。
2. 官方 adapter 与 three r160 的纹理链路**直接不兼容**（见坑 K1/K2），要用必须打补丁，
   补丁量 ≈ 最小垫片量，还额外背上 K4/K9/K11 的包袱。
3. 自动化验证：路线 B 在 Edge headless（wx API mock + 真 WebGL2）下 10/10 断言通过，
   纹理上传、固定步长、触摸日志全绿（preview/shot-b.png）；node 单测 12/12。
4. 包体：路线 B 比 A 少 ~55KB（未压缩）/ ~20KB（min），且无 adapter 全局注入副作用。

## 2. 运行方式

```bash
cd spike/wx-three
npm install                 # three@0.160.1 + esbuild + playwright-core
npm run tex                 # 生成 assets/tex.png（128×128 POT 棋盘格）
npm run build               # → minigame-a/（路线A）+ minigame-b/（路线B），未压缩便于调试
npm run build:min           # minify 版（体积对照：A 676KB / B 653KB）
npm test                    # node 单测 12 例（固定步长 + 垫片/补丁/纹理语义）
npm run verify:browser      # Edge headless 冒烟（仅路线 B 保真），截图 preview/shot-b.png
npm run serve               # http://127.0.0.1:8790/preview/index.html?route=b 手动看
```

微信开发者工具：「导入项目」选 `minigame-a/` 或 `minigame-b/`，appid 用占位
`touristappid`（游客模式，project.config.json 已填）。`compileType: "game"`。
**本机当前未安装微信开发者工具（仅残留 Androws 空目录）→ devtools/真机验证阻塞，
见 §4 与 §8 清单，待协调者转交用户执行后回填 §7 数字。**

## 3. 两条路线的差异点

| | 路线 A（vendor/weapp-adapter.js） | 路线 B（src/shim-min.js） |
|---|---|---|
| 来源 | 官方 minigame-demo 仓库 bundle（1536 行 webpack） | 自写 ~50 行 |
| 注入全局 | window/document/navigator/Image/HTMLElement/localStorage/XHR/Audio/WebSocket/FileReader/performance… | 无（只包装 canvas） |
| three 纹理链 | 需补丁 P1+P2（§5）后才通 | 不用 TextureLoader，wx.createImage+THREE.Texture |
| 触摸 | adapter 转 DOM TouchEvent | 直接 wx.onTouchStart 等 |
| rAF | adapter 全局 requestAnimationFrame | 显式 wx.requestAnimationFrame |
| 坑 | K1-K4, K9, K11 | K5-K8, K12（与路线无关的通用坑也适用） |

## 4. 验证状态矩阵

| 验证项 | 状态 | 结果 |
|---|---|---|
| node 单测（12 例） | ✅ | 12/12（固定步长确定性/钳制/统计；shim/patch/texture 语义） |
| 浏览器冒烟（路线 B，Edge headless + 真 WebGL2） | ✅ | 10/10：boot、纹理上传、帧循环 steps≈frames、触摸、WebGL2、无页面错误 |
| 浏览器冒烟（路线 A） | ⛔ 不做 | adapter 假设可重定义 window（K11），浏览器无法保真模拟 |
| 微信开发者工具（模拟器+性能面板） | ⛔ 阻塞 | 本机未装开发者工具；产物已就绪，按 §8 步骤执行 |
| 真机（Android/iOS） | ⛔ 待用户 | 清单见 §8 |

## 5. 坑清单（S3 必须规避）

**路线 A 专属：**
- **K1** adapter 的 document 没有 `createElementNS`；three ImageLoader 第一步就调它
  （three.module.js:43916）→ `TypeError`。补丁 P1：补 createElementNS。
- **K2** adapter 的 `Image()` 直接 `return wx.createImage()`，裸 Image 只有 onload/onerror，
  没有 addEventListener；three 用 `image.addEventListener('load')`（:43948），且回调依赖
  `this === image`（Cache.add(url,this)）。补丁 P2：事件垫片必须 `fn.call(img, e)`。
- **K3** devtools 模拟器里有真 DOM，three 的裸 `document` 解析到**真 document** 而非
  adapter 的假 document（adapter 只 defineProperty 可配置属性）。补丁 P3：直接改运行时
  实际解析到的 document，且 `createElementNS('img')` 强制返回 wx.createImage 包装，
  否则 devtools 里会建真 DOM `<img>`，相对路径 src 指不到代码包文件。
- **K4** adapter 的 `performance.now()` 返回 `Date.now()/1000`（**秒**）。任何依赖
  `THREE.Clock` 的代码（AnimationMixer、阻尼动画）会慢 1000 倍。本 spike 循环用
  `Date.now()` 自计时规避；S3 的 platform 层**禁止把 adapter 的 performance 喂给 three**。
- **K9** adapter 注入 localStorage/XHR/Audio/WebSocket/FileReader 等全家桶，常驻内存与
  包体都变胖；spike 用不到任何一个。
- **K11** adapter inject() 在严格模式下执行 `window.parent = window`、`window = global`，
  真 DOM 环境（浏览器/devtools 部分场景）直接抛 TypeError → 路线 A 无法在浏览器保真验证。

**通用（两路线都要躲）：**
- **K5** wx **没有** webglcontextlost 事件源。three 的监听器（:28648）收下但永不触发；
  上下文丢失恢复要自实现（wx.onHide/onShow 钩子 + 资源重建），S3 的 PlatformAdapter
  需预留 onContextRestored 回调位。
- **K6** DPR：真机 pixelRatio 常见 2.75~3.5，必须封顶（spike 用 2）。wx 上屏画布默认
  width/height 已是物理像素；`renderer.setSize(逻辑宽, 逻辑高, false)` + `setPixelRatio(dpr)`
  是唯一正确组合，updateStyle 必须 false（wx canvas 无 style，:28834 会炸）。
- **K7** 纹理：wx 无全局 `createImageBitmap`（three ImageBitmapLoader 自检 :46803 会 warn）；
  TextureLoader 链按 K1/K2 不可用 → 统一走 `wx.createImage()` + `new THREE.Texture(img)` +
  onload 置 `needsUpdate`（src/texture.js，两路线共用）。首帧贴图未就绪会白一下，属预期。
  WebGL1 下 NPOT 纹理不能开 mipmap（resizeImage 走 document 画布 :24035 也会炸）→
  **纹理一律 POT**，或保证 WebGL2。
- **K8** WebGL2：iOS 需 game.json `"iOSHighPerformance": true` 才有 webgl2，否则 r160 回落
  webgl1（r163 移除 webgl1，升级 three 前必须解决）。contextNames 顺序 :28654 自动降级。
- **K10** 包体：three 未压缩 1235KB / min 640KB；路线 A +55KB/+20KB。主包 4MB 内无压力，
  但 devtools「es6→es5」对 1.2MB bundle 重编译很慢 → project.config 里 es6 转换按需关。
- **K12** `wx.requestAnimationFrame` 回调参数不保证是时间戳 → 循环自取 `Date.now()`，
  不依赖回调参数（src/main.js）。
- **K13** 触摸坐标是**逻辑像素**（不乘 dpr）；UI 命中与渲染坐标换算要统一在 platform 层。

## 6. 给 platform-wx 的垫片形态建议（喂 S3）

1. **不造 window/document 假全局**。`CanvasFactory.createWebGLCanvas()` 返回包装对象：
   `{ canvas（wx.createCanvas 首调 + addEventListener/removeEventListener 垫片）, width, height }`；
   `windowSize()` 返回 `{ w, h, dpr: min(pixelRatio, 2) }`。即 src/shim-min.js 的形态。
2. `requestFrame/cancelFrame` → `wx.requestAnimationFrame/cancelAnimationFrame`；
   渲染层禁用 `renderer.setAnimationLoop`（它吃全局 rAF）。
3. 纹理统一 `loadTexture(path)` 平台方法（web 侧 TextureLoader / wx 侧 texture.js 同签名），
   import 禁令补一条：`packages/render` 禁止直接 new TextureLoader。
4. 输入：`wx.onTouchStart/Move/End/Cancel` → 统一 `InputEvent`（坐标逻辑像素，K13）。
5. 上下文/生命周期：`wx.onHide/onShow` 映射 onVisibility，并预留 K5 的资源重建钩子。
6. 若未来某第三方库硬要 DOM（如调试面板），再局部引入 adapter 的**子集**，不进主链路。

## 7. 性能基线

**已测（Edge headless 桌面，仅代码路径参考，不代表真机）：**
fps 56-60 / steps≈frames / draw calls=2 / triangles=14 / textures=1 / programs=2 /
drawingBuffer 780×1688（dpr=2）。`__spike.stats()` 每秒输出同口径数字。

**待测（devtools/真机，按 §8 回填）：**

| 指标 | 目标（redesign §3.2） | devtools 模拟器 | Android 真机 | iOS 真机 |
|---|---|---|---|---|
| 帧率 | 60fps | _待填_ | _待填_ | _待填_ |
| 内存 | <400MB | _待填_ | _待填_ | _待填_ |
| 启动到首帧 | - | _待填_ | _待填_ | _待填_ |
| WebGL 版本 | webgl2 | _待填_ | _待填_ | _待填_(需 iOSHighPerformance) |

## 8. 真机/开发者工具测试步骤清单（协调者转交用户）

1. 安装微信开发者工具（stable），登录有「小游戏」权限的微信号（游客模式亦可跑模拟器）。
2. 导入项目：`spike/wx-three/minigame-b`（先 B 后 A 对照），appid 选「游客模式」。
3. 模拟器：编译运行。Console 应见 `[spike:B] boot {...}`、`context: webgl2`、
   `[spike:tex] loaded assets/tex.png 128x128`、每秒一条 `[spike:B] stats {...}`。
   点击/拖动模拟器屏幕 → 见 `[spike:B] touch start/move/end` 日志。
4. 性能面板：录制 30s，记录 FPS 曲线均值/毛刺、JS 内存峰值 → 回填 §7。
   Console 执行 `__spike.stats()` / `__spike.info()` 交叉核对。
5. 路线 A 同步骤跑 minigame-a，重点确认 `[spike:A] TextureLoader onLoad ok`
   （补丁生效证据）与 `[spike:patchA]` 日志；对比两路线内存面板差值。
6. 真机预览（扫码）：Android 一台（尽量低端）+ iOS 一台。
   - Android：性能监控（开发者工具「真机调试-性能」或 vConsole）记录 10 分钟
     FPS/内存；切后台 30s 再回前台，确认循环恢复且 `clamped` 计数 +1（K6/钳制生效）。
   - iOS：先默认配置跑一轮；再把 game.json 改 `"iOSHighPerformance": true` 重跑，
     对比 `context:` 日志 webgl1→webgl2 与帧率差异（K8）。
7. 内存红线：任一路径 JS+纹理内存 >400MB 即触发 redesign §7 风险1 降级预案讨论。
8. 把数字回填本文件 §7 表格，并在 PR 描述附性能面板截图。

## 9. 文件清单

```
spike/wx-three/
├── package.json / package-lock.json     # three@0.160.1、esbuild、playwright-core
├── src/
│   ├── main.js            # 共享场景：旋转立方体+纹理平面、固定步长循环、触摸日志、__spike 探针
│   ├── fixedStep.js       # 纯逻辑固定步长循环（单测覆盖）
│   ├── texture.js         # wx.createImage + THREE.Texture（两路线共用纹理路径）
│   ├── shim-min.js        # 路线 B 最小垫片
│   ├── adapter-patch.js   # 路线 A 必需补丁 P1/P2/P3
│   ├── entry-a.js / entry-b.js
├── vendor/weapp-adapter.js  # 官方 adapter（wechat-miniprogram/minigame-demo 原样拷贝）
├── shell/                 # game.json / project.config.json 模板（appid=touristappid）
├── tools/                 # make-texture / build(esbuild 双路线) / serve-spike / verify-browser
├── test/                  # node:test 12 例
├── preview/               # 浏览器冒烟 harness（wxmock + index.html + shot-b.png）
├── assets/tex.png         # 128×128 POT 测试纹理
├── minigame-a/ minigame-b/  # 构建产物 = 可直接导入开发者工具的完整小游戏工程
└── README.md
```
