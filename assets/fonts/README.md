# assets/fonts — SDF 位图字体图集（S12 产物，S4 对接规格）

由 `tools/fontgen/` 离线生成，**运行时零依赖**（纯 PNG + JSON，网页与微信小游戏通用）。
格式版本：`tr-sdf-atlas/1`。

## 1. 文件清单

| 文件 | 内容 |
|---|---|
| `latin.png` / `latin.metrics.json` | ASCII 可打印集（95 字符），源字体 Arial |
| `cjk.png` / `cjk.metrics.json` | 中文及全角符号（424 字符，扫描自 `src/ui/screens.ts` + `config/*.json`），源字体微软雅黑；`❤ ♡` 等主字体缺失的符号自动回退 Segoe UI Symbol（glyph 带 `fallbackFont` 字段） |
| `charset.txt` | 生成图集所用字符集（每行一个字符，码点升序） |

图集为 **8-bit 灰度 PNG**（单通道；按 RGBA 上传时 r=g=b，shader 一律取 `.r`）。

## 2. SDF 编码约定（核心契约）

- 参数（见 metrics `sdf` 段）：`fontSize=40`（源光栅化字号）、`spread=8`（距离场总宽度，px）、`padding=2`、`buffer=spread/2+padding=6`（每字形四周外扩）、`gap=2`（单元间隔）。
- 像素值 `v ∈ [0,255]`，对应图集坐标系下有符号距离（**正 = 字形内部**）：

  ```
  sd_px = (v/255 - 0.5) * spread      // 0 恰在字形边缘；|sd| ≥ spread/2 饱和
  ```

- `v=128`（≈127.5）即轮廓边缘；`v=0` 距边缘 ≥4px 的外部；`v=255` 距边缘 ≥4px 的内部。

## 3. 坐标系与字形度量

- metrics 中所有 px 值均基于 `fontSize=40`；渲染目标字号 `S` 时统一乘缩放 `k = S / sdf.fontSize`。
- 字形原点 = **pen 位置（基线左端）**；`bearingX` = 墨迹左缘相对 pen 的 x 偏移（右为正）；`bearingY` = 墨迹顶边相对基线的高度（**y 向上为正**）；`advance` = 笔进量。
- UI 屏幕系（y 向下）换算，每个字形画一个四边形：

  ```
  k       = S / metrics.sdf.fontSize
  quadX   = penX + (bearingX - sdf.buffer) * k
  quadY   = baseY - (bearingY + sdf.buffer) * k     // baseY = 基线的屏幕 y
  quadW   = cell.w * k,  quadH = cell.h * k          // cell = 墨迹 + buffer 外扩
  uv      = glyph.uv (x0,y0)=左上, (x1,y1)=右下      // 归一化图集坐标，y 自顶向下
  penX   += advance * k
  ```

- 行排版：基线间距 = `baseline.lineHeightPx * k`；首行基线 = 顶边 + `baseline.ascenderPx * k`；`descenderPx` 为负值。
- 空白字符（空格）：`inkW=0`，cell 为 2×buffer 的全 0 小格，上述公式仍然成立（渲染为透明）。

## 4. three.js / WebGL 采样约定

- 纹理加载后必须设置：`texture.flipY = false`（uv 的 y0 对应 cell 顶边）、`generateMipmaps = false`、`minFilter = magFilter = LinearFilter`。灰度 PNG 以 R8 或 RGBA8 上传均可，shader 取 `.r`。
- 片元着色（`uSpreadK = sdf.spread * k`，即距离场换算到屏幕像素的系数）：

  ```glsl
  float d = (texture2D(uAtlas, vUv).r - 0.5) * uSpreadK; // 屏幕 px，正=内部
  float w = max(fwidth(d), 0.5);                           // 抗锯齿半宽
  float alpha = smoothstep(-w, w, d) * uOpacity;
  ```

  不用 fwidth 时可取固定 `w = 0.5`（1 屏幕像素过渡）。描边/阴影用第二个阈值带（如 `smoothstep(outlineW, outlineW+2w, -d)`）即可，无需额外图集。
- 放大无损（SDF 特性）；**缩小到 S < fontSize 一半时笔画开始糊**，超大标题建议单独生成大字号图集（`--size 64`）。

## 5. 重新生成（改文案 / 换字体后）

```bash
cd tools/fontgen && npm install        # 首次（仅依赖 opentype.js；npm 上 tiny-sdf 无可用的 Node 版，SDF 算法已按其 MIT 实现内置）
node charset.mjs                       # 扫描 src/ui/screens.ts + config/*.json -> assets/fonts/charset.txt
node gen.mjs --all                     # 生成 latin/cjk 两张图集 + metrics
node gen.mjs --probe                   # 探测系统字体可用性（含 TTC 抽取）
node preview.mjs --chars 雷霆酷跑       # 终端 ASCII 自查可读性
```

- 生成是确定性的：同输入两次产物字节一致（`tests/fontgen.test.mjs` 有守护用例）。
- 常用参数：`--size`（源字号）、`--spread`、`--padding`、`--gap`、`--max-width`、`--font <路径>`（显式字体，支持 ttf/ttc）、`--range ascii|nonascii|all`、`--no-fallback`（关闭符号回退）。
- 字体优先级见 `tools/fontgen/fonts.mjs`（CJK：雅黑→黑体→等线→宋体；Latin：Arial→雅黑→黑体；符号回退：Segoe UI Symbol）。

## 6. 已知限制与发布前注意

- **字体版权**：雅黑/黑体/Arial/Segoe 均为系统专有字体，图集 PNG 属于其派生产物，**仅可用于开发调试**；正式发布（尤其微信小游戏分包分发）前应改用 OFL 开源字体重新生成，例如思源黑体（Noto Sans SC / Source Han Sans）+ Arimo，命令：`node gen.mjs --font <NotoSansSC-Regular.otf> --preset cjk`（otf/CFF 轮廓同样支持）。
- `metrics.missing` 列出主字体与回退字体都缺的字符（当前为 0）；S4 遇到图集外字符应回退为占位方块，不要崩溃。
- 图集非 2 的幂（1022×1186 / 1016×208）：WebGL2 与微信小游戏均支持 NPOT + LinearFilter + 无 mipmap（本规格第 4 节的设置已按此约定）。
