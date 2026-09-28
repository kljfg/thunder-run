# 输入重放格式 v1（replay format）

> S19a 交付物。golden-master 回归（`tests/golden/`）与 S18 防作弊云复跑共用的输入序列化规范。
> 前提：core 的 `RunnerSim` 是确定性 sim——同构建、同 `config/*.json`、同 seed、同输入序列 ⇒ 逐字段同结果。
> 参考实现：`tools/replay/runner.mjs`（解析/校验/执行）、`tools/replay/recorder.mjs`(编排生成)。

## 1. 用途

- **测试**：固定 seed × 角色 × 脚本化输入的复跑摘要落盘为 golden 基线，sim 行为一变 diff 即报警。
- **防作弊（S18 地基）**：客户端上报 `seed + charId + 输入序列 + 结果摘要`，云函数按本格式复跑
  `RunnerSim` 比对 `eventsSha256` 与结算字段，一致才入排行榜。
- **调试**：任何一局可序列化为 `.json` 离线重现（配合 `?debug` 探针或 node 无头执行）。

## 2. 文件结构

一个重放文件是单个 JSON 对象：

```json
{
  "version": 1,
  "seed": 777,
  "charId": "char_volt",
  "dtMs": 16.666666666666668,
  "maxFrames": 1800,
  "inputs": [
    { "frame": 24,  "type": "swipe",     "payload": { "dir": "left" } },
    { "frame": 51,  "type": "key",       "payload": { "code": "ArrowUp" } },
    { "frame": 88,  "type": "doubleTap", "payload": { "x": 412, "y": 733 } },
    { "frame": 120, "type": "tap",       "payload": { "x": 300, "y": 640 } }
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `version` | integer | 是 | 格式版本，v1 恒为 `1`。**非 1 一律拒绝加载**（§5） |
| `seed` | integer | 是 | 赛道 seed，32 位无符号（0..2³²-1），喂给 `new RunnerSim(content, seed, charId)` |
| `charId` | string | 是 | `config/characters.json` 的角色 id；空串 `""` = 默认装备（无角色） |
| `dtMs` | number | 是 | 固定步长（毫秒）。v1 锁定 `1000/60 ≈ 16.6667`（core `STEP_DT=1/60`），不符即拒绝 |
| `maxFrames` | integer | 否 | 无头执行的帧数上限，缺省 `10800`（3 分钟）。sim 不会跑超该帧数 |
| `inputs` | array | 是 | 输入事件序列，可为空数组（=全程无操作，用于「挂机必死」类基线） |

示例文件：`tools/replay/examples/example-v1.json`（seed=777、char_volt、65 条输入，
由 `node tools/replay/recorder.mjs --seed=777 --char=char_volt --frames=1800` 生成）。

## 3. 输入事件 `{frame, type, payload}`

- `frame`：≥0 的整数，事件发生在第几个 sim 步（0 起）。**整个数组必须按 `frame` 非降序**；
  同一帧可有多条事件，按数组顺序依次生效。
- `type` + `payload`：形状对齐 `packages/platform` 的 `Gesture` 与 `onKey(code)`（platformAdapter.ts），
  即「录的是平台层归一化后的输入」，与真机操作走同一条映射：

| type | payload | 语义 | → SimAction（与 `packages/render/src/runnerScene.ts` 输入路由逐条一致） |
|------|---------|------|------|
| `swipe` | `{ "dir": "up" \| "down" \| "left" \| "right" }` | 上/下/左/右滑 | `jump` / `slide` / `laneL` / `laneR` |
| `doubleTap` | `{ "x": number, "y": number }` | 双击屏幕 | `skill` |
| `tap` | `{ "x": number, "y": number }` | 单击 | （无动作，仅保真记录；返回 null） |
| `key` | `{ "code": string }` | `KeyboardEvent.code` | `ArrowLeft→laneL`、`ArrowRight→laneR`、`ArrowUp`/`Space→jump`、`ArrowDown→slide`、`KeyE`/`ShiftLeft`/`ShiftRight→skill`；其余 code 无动作 |

映射表是格式语义的一部分：改映射 = 改语义 = 升 v2（§5）。未知 `type`、非法 `payload` 一律拒绝。

## 4. 执行语义与结果摘要

`runReplay(content, data)`（tools/replay/runner.mjs）逐帧推进：

```
for frame in 0 .. maxFrames-1:
  按数组序对该帧全部 inputs 调 sim.applyAction(eventToAction(ev))   # null 跳过
  sim.step()                                                        # 固定步长推进一帧
  sim.drainEvents() → 归属到该 frame（事件日志 [frame, event]）
  若 step 后 !sim.state.alive：停机（含该帧）
```

停机后输出结果摘要（golden 基线的 `expected` 即此对象）：

| 字段 | 说明 |
|------|------|
| `frames` | 实际推进的帧数 |
| `summary` | `sim.summary()`：t/distance/coins/nearMiss/hits/score/alive/casts/charId |
| `eventCounts` | 各事件类型计数（键按字典序，字节稳定） |
| `eventsSha256` | 事件日志 `[[frame, event], ...]` 的 canonical JSON（键序稳定）之 sha256 |
| `inputsSha256` | 规范化后 `inputs` 数组的 canonical JSON 之 sha256（上报防篡改用） |

canonical JSON：对象键递归按字典序、无空白；同数据在任何机器/语言序列化逐字节一致，
sha256 才可跨端（客户端/云函数/CI）比对。

## 5. 校验规则与版本演进策略

**v1 加载器是严格的（宁可拒绝，不可含糊）**，以下情况必须抛错拒绝加载：

- `version` 缺失、非整数、≠1（**未知版本不得猜测语义**，防止客户端/服务端理解不一致被利用）；
- `seed` 非 32 位无符号整数；`charId` 非字符串；`dtMs` 偏离 `1000/60`（±1e-9）；
- `inputs` 非数组；任一事件 `frame` 非法、序列未按帧号非降序；
- 未知事件 `type`、payload 形状非法（如 swipe 的 dir 不在四方向内）；
- `maxFrames` 若出现则必须为正整数。

演进规则：

1. **加法演进留在 v1 内**：新增*可选*顶层字段是兼容变更，v1 加载器必须忽略未知顶层字段
   （参考实现即如此）；新增事件类型/改 payload/改映射/改停机规则都是**语义变更，必须升 v2**。
2. **多版本并存**：升 v2 后保留 v1 读取器（golden 基线文件里 `replay.version` 自带版本），
   加载器按 `version` 分派，绝不做跨版本自动转换。
3. **重生成纪律**：golden 基线只有 `node tools/replay/golden-gen.mjs --update` 显式重生成才会变化；
   改 sim/编排/config 后 CI 变红是预期行为——先审查 diff 是有意变更，再 `--update` 并提交。
4. **可复现性三元组**：重放结果 = f(引擎构建, config 内容, 重放文件)。跨端比对（S18）必须同时
   锁定三者：上报时附引擎版本与 config manifest 哈希（S14 `tools/publish-content.mjs` 产物），
   服务端用同版本三元组复跑，否则拒判。

## 6. 工具链

| 路径 | 用途 |
|------|------|
| `tools/replay/runner.mjs` | 解析/校验 + 无头复跑；CLI：`node tools/replay/runner.mjs <replay.json> [--json]` |
| `tools/replay/recorder.mjs` | 程序化编排输入（RunRng 派生，同参数逐字节确定）；CLI：`--seed=N [--char=ID] [--frames=N] [--out=path]` |
| `tools/replay/report.mjs` | 结果摊平/字段级 diff/人读摘要（golden 测试与校验模式共用） |
| `tools/replay/golden-gen.mjs` | golden 基线生成（`--update`）与只读校验（无参数，漂移退出码 1） |
| `tools/replay/examples/example-v1.json` | 规范示例文件（§2） |
| `tests/golden/g-<seed>-<charId>.json` | 15 例基线：5 seeds（101/777/4242/65001/20260922）× 3 角色（char_volt/char_ama/char_kaze），每例含完整 `replay` + `expected` |
| `tests/golden.test.mjs` | 逐例复跑比对，失败输出 seed/角色/字段/期望 vs 实际 |
| `tests/replay.test.mjs` | 格式解析、非法版本拒绝、映射表、runner 确定性用例 |

均依赖 `packages/core` 的 **dist 产物**：先 `npm run build` 再使用（与 `npm test` 约定一致）。

## 7. S18（云函数复跑防作弊）复用点

- **直接复用** `parseReplay + runReplay + eventsSha256/inputsSha256`：云函数侧只需 core dist +
  本格式（零 DOM/平台依赖，node 云环境可跑），上报体 = `{ engineVersion, configHash, replay, result }`。
- 校验流程：`parseReplay` 严格拒绝 → 用同版本 config 复跑 → 比对 `eventsSha256`、`summary.score`
  等字段与客户端上报一致 → 才写排行榜；不一致打点上报（S16 通道）。
- `maxFrames` 是服务端复跑的天然算力上限；`inputsSha256` 可先于复跑做快速一致性预检。
- `config/game.json params.antiCheat` 段（maxScorePerRun/replaySampleRate 等）是采样与上限策略的
  既有挂点，S18 落地时从该段读取，不硬编码。
