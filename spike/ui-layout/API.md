# spike/ui-layout · API 契约（S13 → S4）

> 自绘 UI 纯逻辑内核。**零运行时依赖、零 DOM/three/仓库 src 引用**（tsconfig `lib` 不含 DOM，编译期即证明）。
> S4 搬运方式：`src/*.ts` 原样拷入 `packages/ui/src/`（文件名不变），`tests/*.test.mjs` 拷入根 `tests/` 并把
> `../dist/index.js` 改为 `../packages/ui/dist/index.js`（或按 S2 约定指向 `@tr/ui`）。
> 本文是 S4 接 three OrthoOverlay 的**唯一依据**；语义以本文 + node:test 用例为准。

## 0. 模块清单与坐标系

| 文件 | 职责 |
|---|---|
| `types.ts` | 几何/规格公共类型 + `edges/resolveLength/clamp/containsPoint/intersectRect` |
| `layout.ts` | flex 子集布局引擎：`layout / measureNode / findBox` |
| `hit.ts` | 矩形树命中：`hitPath / topTarget / isPointInBox` |
| `router.ts` | 输入分发：`InputRouter`（捕获/冒泡 + 按压生命周期） |
| `scroll.ts` | 滚动物理：`ScrollPhysics / ScrollFeel / estimateVelocity / resolveScrollFeel` |
| `button.ts` | 按钮状态机：`buttonNext / buttonActivates / createButton` |
| `virtualList.ts` | 虚拟滚动窗口：`computeVirtualWindow / contentExtentOf / itemStart / clampOffset` |
| `index.ts` | 唯一公共出口（`export *`） |

坐标系：x 右、y 下、px、原点在布局根左上角；与 three 正交相机的 y 翻转由 S4 渲染层处理。时间单位一律**秒**。

## 1. 布局引擎

```ts
layout(root: LayoutNode, viewport: Size): LayoutBox   // 纯函数，不修改输入
measureNode(node: LayoutNode, basisW: number, basisH: number): Size  // basis 非有限 = 无基准
findBox(root: LayoutBox, id: string): LayoutBox | undefined
```

`LayoutNode`（输入，可序列化）字段：

| 字段 | 类型/默认 | 语义 |
|---|---|---|
| `id` | string? | 命中分发按 id 找 handler |
| `direction` | `'row'\|'column'`，默认 `column` | 主轴方向 |
| `align` | `start/center/end/stretch`，默认 `stretch` | 交叉轴对齐（stretch 只对 auto 尺寸生效） |
| `justify` | `start/center/end/spaceBetween/spaceAround/spaceEvenly`，默认 `start` | 主轴对齐 |
| `gap` | number=0 | 子项主轴间距（与 justify 的分配间距叠加） |
| `padding` / `margin` | `number \| Partial<Edges>`=0 | 盒模型；margin 支持负值 |
| `width` / `height` | `number \| {percent}`，缺省 auto | 百分比基准 = **父内容盒**（父该轴 auto 时按 auto 处理） |
| `minWidth/minHeight/maxWidth/maxHeight` | number? | 对声明与 auto 尺寸都生效 |
| `flex` | number=0 | 主轴增长权重：父主轴尺寸确定且非滚动时，正剩余空间按权重分配；**不支持收缩** |
| `scroll` | `boolean \| 'x' \| 'y'`=false | true=沿主轴滚动并裁剪（`clip`），子项主轴按无限空间测量 |
| `scrollOffset` | number=0 | 滚动偏移（宿主每帧从 ScrollPhysics 回填），子项位置整体 `-offset` |
| `content` | `Size?` | 叶子固有尺寸（SDF 文本测量结果等，由宿主填入） |
| `passthrough` | boolean=false | 自身不作为命中目标（全屏 HUD 底板），子项仍可命中 |
| `children` | LayoutNode[]? | |

`LayoutBox`（输出）：`rect`（边框盒，绝对坐标）、`contentRect`（去 padding）、`clip?`（滚动容器=contentRect）、
`scroll?: ScrollMetrics {axis,offset,content,viewport,maxOffset}`、`passthrough?`、`children`。

关键语义（均有测试锚定）：
- **根节点**未声明的轴铺满 viewport（overlay 屏幕根语义）；声明了则按声明。
- auto 容器尺寸 = 内容并夹到可用空间；声明尺寸可溢出父盒（由 clip/滚动收口）。
- 两遍算法：测量遍中「auto 父下的百分比」按 auto；摆放遍中每层盒子已确定，百分比按父内容盒解析。
- 滚动容器内 flex 不生效（主轴无限）；`ScrollMetrics.content` 即内容总长，直接喂 ScrollPhysics。

## 2. 命中测试

```ts
hitPath(root: LayoutBox, x: number, y: number): LayoutBox[]  // root→最深命中；未命中 []
topTarget(path: LayoutBox[]): LayoutBox | undefined          // 最深的非 passthrough 节点
isPointInBox(box, x, y, clip?): boolean
```

规则：路径上每个 rect 都必须含点（溢出父盒的子项不可命中）；祖先 clip 取交集，点出裁剪区则子树不可命中；
兄弟重叠后声明者（绘制上层）优先；rect 右/下边缘为开区间。

## 3. 输入分发（InputRouter）

```ts
new InputRouter({ slop?: number = 8 })
router.setTree(root: LayoutBox)            // 每次重布局后回填
router.register(id: string, handlers: NodeHandlers) / unregister(id)
router.dispatch(input: UiInput)            // { type:'down'|'move'|'up'|'cancel', x, y, t }
router.isPressing: boolean
```

`NodeHandlers`：`onDown/onMove/onUp/onCancel/onClick(e: UiEvent)` + `onPressChange(pressed, e)`。
`UiEvent`：`{type(含 'click'), x, y, t, target, phase:'capture'|'target'|'bubble', stopPropagation()}`。

语义：
- down 命中后**锁定路径**（单触点），后续 move/up 一律沿该路径分发——滚动中按钮不误触。
- 传播顺序：捕获(root→target 父) → target(最深命中节点) → 冒泡(target 父→root)；`stopPropagation` 截断后续所有相位。
- **按压生命周期**：down → 按压目标(路径中最深的已注册节点)`onPressChange(true)`；移动超 slop → `onPressChange(false)`
  + 沿路径发 `cancel`（activePath 保留，滚动容器继续收 move）；up 仍在目标 rect 内 → 发 `click`；up 在外 → 无 click。
- `target` 恒为最深命中节点（与是否注册无关）；按压目标可是其注册过的祖先。
- down 未命中任何节点 → 后续 move/up 忽略，直到下一次 down。

S4 接法：platform `onInput` 归一化 → `dispatch`；`onPressChange` 驱动 `createButton().send('down'/'cancel')`。

## 4. 滚动物理（ScrollPhysics）

```ts
new ScrollPhysics({ content, viewport, feel?: Partial<ScrollFeel>, offset? })
p.dragStart(t) / p.dragBy(dx, t) / p.dragEnd(): number /*采用的 fling 初速*/
p.fling(v) / p.snapTo(offset) / p.setBounds(content, viewport)
p.step(dt): boolean   // 推进（内部子步 ≤1/120s，dt 上限 0.25s）；返回是否仍在动
p.offset / p.maxOffset / p.dragging / p.animating / p.velocityPxS
estimateVelocity(samples: {x,t}[]): number  // 尾部 100ms 窗口差商
```

`ScrollFeel` 手感参数（默认值即当前手感基线，S4 调参只动这里）：

| 参数 | 默认 | 含义 |
|---|---|---|
| `frictionPerS` | 4.2 | 惯性指数衰减率 1/s |
| `minVelocityPxS` | 12 | 惯性停止阈值 |
| `flingMaxPxS` | 6000 | fling 初速上限 |
| `overscrollResist` | 0.35 | 拖拽越界阻尼 0..1 |
| `bounceStiffness` | 170 | 回弹弹簧刚度 |
| `bounceDamping` | 26 | 回弹阻尼（默认≈临界阻尼，不振荡） |
| `settleEpsPx` / `settleEpsPxS` | 0.5 / 8 | 回弹收敛阈值 |

**config/game.json 未来 `params.ui.scroll` 段草案**（S4 落地时同步 schema + docs/03 参数表）：

```json
"ui": { "scroll": {
  "frictionPerS": 4.2, "minVelocityPxS": 12, "flingMaxPxS": 6000,
  "overscrollResist": 0.35, "bounceStiffness": 170, "bounceDamping": 26,
  "settleEpsPx": 0.5, "settleEpsPxS": 8
} }
```

行为承诺（测试锚定）：惯性速度单调衰减、总位移≈v0/friction（±20%）；越界（拖拽/fling）必在有限步内弹回
`[0,maxOffset]` 并精确静止；content≤viewport 时任何操作都收敛回 0；大 dt/NaN 不发散。

**每帧闭环**（S4 参考）：`physics.setBounds(box.scroll.content, box.scroll.viewport)` →
router 的 onDown/onMove/onUp 接 dragStart/dragBy/dragEnd → `physics.step(dt)` →
把 `offset` 写回 LayoutNode.scrollOffset → 重新 `layout()` → `router.setTree()`；
List 场景同时用 `computeVirtualWindow(spec, offset)` 决定渲染哪些项。

## 5. Button 状态机 / 虚拟列表

```ts
buttonNext(state: ButtonState, ev: ButtonEvent): ButtonState  // 纯 reducer
buttonActivates(state, ev): boolean                           // 仅 (pressed,'up') 为真
createButton({disabled?}): { state, send(ev) → {state,changed,activated} }
```
状态：`normal/pressed/disabled`；事件：`down/up/leave/enter/cancel/enable/disable`。
disabled 吞掉除 enable 外一切事件；pressed 中 leave/cancel 回 normal 且不再激活。

```ts
computeVirtualWindow(spec: VirtualListSpec, scrollOffset): VirtualWindow
contentExtentOf(spec) / itemStart(spec, i) / clampOffset(spec, offset)
// spec: { itemCount, itemExtent, gap?=0, viewportExtent, overscan?=1 }
// window: { start, end(不含), count, leading(首项内容偏移), contentExtent, maxOffset }
```
等尺寸条目；offset 自动夹到 `[0,maxOffset]`；NaN→0；S4 只渲染 `[start,end)` 并把首项摆在 `leading`。

## 6. 明确不支持的 CSS 特性（S4/S5 不要假设）

- `flex-wrap` 换行、`flex-shrink`/`flex-basis`（只有正剩余空间的 grow）
- `position: absolute/fixed/sticky`、`z-index`（层序 = children 声明序）
- auto 父尺寸下的百分比（按 auto 处理）、`calc()`、`vh/vw/em/rem` 单位（只有 px 与 %）
- `border`/`box-sizing` 区分（rect 即边框盒）、`overflow` 独立于 scroll（只有 scroll 容器裁剪）
- 溢出父盒的子项命中（命中要求路径每层 rect 都含点）、`pointer-events` 细分（只有 passthrough 布尔）
- 多触点/捏合/旋转手势（单触点 down/move/up/cancel；swipe/doubleTap 归 platform 层）
- 文本测量（`content: Size` 由宿主填，SDF 字体度量属 S12/S4）、CSS 动画/transition（动效走 ScrollPhysics 或宿主 tween）
- 横向 List 虚拟化差异（`virtualList` 轴向无关，extent 语义即滚动轴长度）
- 负尺寸/非有限数值的输入容错仅限已测试路径（clamp 到 ≥0；Infinity basis 有定义语义）

## 7. 构建与测试

```bash
npm i        # 仅 devDependency typescript@5.5.4（与仓库根一致）
npm test     # = tsc 构建 dist/ + node --test tests/*.test.mjs（82 例）
```
独立于根 check.mjs；dist/、node_modules/ 不入库（spike 内 .gitignore）。
