# 内容轨道协作指南（给内容侧协作者）

> 分工：框架团队负责引擎/平台/构建（见 CONTRIBUTING.md）；内容侧负责**玩法内容**——角色、技能、道具、障碍、赛道模板、经济数值、活动、主题。
> 设计事实源：docs 库（`D:\gpt-6\work\酷跑小游戏`，kljfg 持有）。实现仓的 `config/*.json` 与 docs 库同源，**改完两边同步**。

## 1. 内容侧规则

1. **只改玩法段**：`config/*.json` 的玩法数值与条目（obstacles/characters/skills/items/economy/events/themes 及 game.json 的玩法段）。
   **技术段禁改**（`params.ui`、`telemetry`、`quality` 等框架字段）；发现技术问题开 issue。
2. **只用已注册的效果原语**（`packages/core/src/effects/buffEngine.ts` 的 PRIMITIVES / schema enum）。
   需要新原语 → 开 issue（标签 enhancement）向框架团队提需求，**不要自己动 buffEngine**——新原语是框架任务（五处同步规则）。
3. **golden-master 协议（重要，S19a 新增）**：`tests/golden/` 锁定了 15 组「固定 seed+输入→结果」快照，
   任何玩法段数值改动都会让它变红——这是特性不是故障。流程：
   ```bash
   npm run check                       # golden 红 → 看 tests/golden.test.mjs 的 diff 摘要
   # 逐条审查 diff 是否符合设计意图（分数/距离/事件变化方向和量级对不对）
   node tools/replay/golden-gen.mjs --update   # 确认后才重新生成
   # golden 更新与 config 改动放同一个 commit，PR 描述里写清「预期数值影响」
   ```
   **禁止**不看 diff 直接 --update。
4. 分支命名 `content/<主题>`，基于 `origin/dev`，PR 合回 `dev`；提交格式 `content(config): 摘要`。
5. 每条 PR 自检：`npm install && npm run build && npm run check` 全绿（configValidator 会拦截引用不存在原语/id 的配置）。
6. 与框架波次并行时注意：`config/game.json` 框架侧也可能动（技术段）——合并前 rebase `origin/dev`，冲突按「段」解决。

## 2. 验证手段

- `npm run dev` → 浏览器实测手感（?debug 有 `__trRun.state/probe`、`__trSeed()` 复现赛道）。
- trackGen 测试会拦硬伤（三道全封死、金币重叠障碍等）；effects 测试矩阵拦原语误用。
- 小游戏真机验证需等 S6/S7 合入（框架团队通告后可用）。

## 3. 派发提示词

### C1 · 角色/技能/道具内容（建议 kljfg——docs 库同步责任在手）

```text
你负责 雷霆酷跑 的内容轨道 C1：角色、技能与道具（分支 content/characters-v1，基于 origin/dev）。
必读：CONTRIBUTING.md、docs/content-track.md（内容侧规则，尤其 golden-master 协议）、
docs 库的设计文档（03 参数表/04 效果原语清单，kljfg 本机）、config/characters.json、skills.json、items.json 与对应 schema。

任务（示例框架，具体设计以 docs 库为准）：
1. 按 docs 库设计新增/调平角色（含主动技能+被动天赋），只组合已注册原语；数值先小幅步进。
2. 道具池与掉落权重调整（items.json/economy.json 玩法段），对照 trackGen 测试的分布断言。
3. 每次改动跑 npm run check；golden 变红按 content-track.md §1.3 审查后 --update，同 commit 提交。
4. docs 库同步：改动的参数表条目在 docs 库同批更新（kljfg 本机操作），PR 描述列同步清单。
5. 需要新原语/新机制：开 issue（enhancement）给框架团队，不要动 packages/*。

验收：npm run check 全绿；web 壳手测新角色完整一局（选角→技能释放→结算文案正确）。
汇报：新增/调整的条目清单、数值影响摘要（golden diff 关键行）、docs 库同步状态、提给框架的需求 issue 列表。
```

### C2 · 赛道/障碍/经济/活动内容（建议 mostny）

```text
你负责 雷霆酷跑 的内容轨道 C2：赛道模板、障碍、经济与活动（分支 content/track-economy-v1，基于 origin/dev）。
必读：CONTRIBUTING.md、docs/content-track.md（内容侧规则，尤其 golden-master 协议）、
config/obstacles.json、game.json（玩法段：难度曲线/生成权重）、economy.json、events.json、themes.json 与对应 schema。

任务（示例框架，具体设计以 docs 库为准）：
1. 障碍模板扩充与难度曲线调整（分段权重、封路组合），trackGen 测试断言（三道全封/金币重叠等）是硬边界。
2. 经济数值：金币产出/消耗、复活与结算曲线（economy.json 玩法段）。
3. 活动/主题配置（events.json/themes.json）：按 schema 组装，不新增未注册原语。
4. 每次改动跑 npm run check；golden 变红按 content-track.md §1.3 审查后 --update，同 commit 提交。
5. 需要框架能力（新原语/新生成器参数/新页面）：开 issue（enhancement），不要动 packages/*。

验收：npm run check 全绿；web 壳 ?debug 用 __trSeed() 复现至少 3 条种子赛道手测新模板手感。
汇报：模板/数值变更清单、难度曲线前后对照、golden diff 关键行、提给框架的需求 issue 列表。
```

## 4. 框架侧对接义务（协调者承诺）

- 内容 PR 由协调者优先评审合并（golden diff 审查是重点）。
- 每个里程碑合入 main 后发「框架变更通告」：新原语、新技术段字段、资源规范变化。
- 内容侧 issue（enhancement）纳入波次排期，新原语任务按五处同步规则派发。
