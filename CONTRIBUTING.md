# 协作指南（CONTRIBUTING）

> 面向所有协作者。架构与里程碑见 `docs/wx-minigame-redesign.md`，任务分派与进度见 `docs/session-plan.md`（协调者维护）。
> 项目目标：微信小游戏（three.js 渲染 + 自绘 UI + 纯逻辑 core），网页端为开发调试壳。

## 1. 环境准备

- Node.js ≥ 22（开发在 v24.19 实测通过），npm 随附。
- 克隆后：
  ```bash
  npm install                      # 根目录：workspace 链接 + three/vite/typescript
  npm install --prefix tools/fontgen   # 可选：SDF 字体工具的依赖（不装则相关测试自动 skip）
  npm run check                    # 全量自检，必须 ALL PASS
  ```

## 2. 常用命令

| 命令 | 作用 |
|------|------|
| `npm run check` | 编译 + 单测 + 配置校验 + 架构禁令，一键全绿才算完成 |
| `npm run build` | tsc -b 类型构建（project references，产物在各包 `dist/`） |
| `npm test` | node:test 单测（275 例；**必须先 build**，测试 import dist 产物） |
| `npm run dev` | Vite 调试壳（apps/web），URL 加 `?debug` 出自动化探针 `__trRun.*` |
| `npm run build:web` | 网页端生产构建 |

## 3. 目录结构（M5 后，npm workspaces）

```
packages/core          纯逻辑：sim/效果引擎/配置/rng（禁 DOM/three/平台代码）
packages/render        three.js 场景层（只依赖 WebGL canvas 抽象）
packages/ui            自绘 UI 框架（S4）：S13 布局内核 + Overlay/控件/SDF 文本（契约见 packages/ui/API.md）
packages/platform      PlatformAdapter 接口（v2 规格见 docs/platform-adapter-v2.md）
packages/platform-web  网页实现
packages/platform-wx   微信实现（骨架，S3 填充）
apps/web               调试壳（Vite；?ui=demo 为 S4 自绘 UI 演示页）
spike/wx-three         three×小游戏可行性验证结论（S11，已定路线 B 最小垫片）
tools/                 check.mjs、校验脚本、fontgen（SDF 字体生成）
config/                8 个内容配置（与设计文档库同源，改动需双向同步）
docs/                  重设计方案、会话协调计划、manifest schema
```

## 4. 分支与提交规范

1. 集成分支是 **`dev`**：`git fetch origin && git checkout -b feat/sN-xxx origin/dev`。
2. 提交信息：`feat|fix|content|art|perf|docs(scope): 中文摘要`。
3. **提交前 `npm run check` 必须 ALL PASS**；push 自己的分支后向 `dev` 发 PR。
4. `dev` → `main` 由维护者在里程碑节点统一发起，不直接 push `main`，不 force-push。
5. 并行任务建议用独立 worktree，避免共用工作区互踩：
   `git worktree add ..\tr-sN -b feat/sN-xxx origin/dev`

## 5. 硬性约束（脚本强制，违反 = check 失败）

- **职责边界**：本团队只做框架与技术栈（引擎/平台层/UI 框架/构建/CI/测试/性能/网络/存档框架），
  **不改游戏本体内容**——`config/*.json` 的玩法段数值（关卡/角色/道具/经济/活动）一律不动，
  框架只增改技术段（quality/ui/audio/perf）。发现数值问题开 issue 知会作者侧。详见 `docs/framework-roadmap.md` §1。
- `packages/(core|render|ui|game)` 禁止 import 平台包与 DOM/wx 全局；平台代码只许出现在 `platform-*` 与 `apps/*`。
- 任何源文件 ≤ 300 行。
- 新增效果原语必须五处同一提交内改完（PRIMITIVES 注册 + 合并规则 + schema enum + 设计文档表格 + 测试矩阵）。
- 改 `config/*.json` 技术段：schema 与设计文档库需同步，PR 描述中列出改动清单。

## 6. 当前任务板（详情与派发提示词见 docs/session-plan.md，框架专项见 docs/framework-roadmap.md）

- 已完成并合入 dev：S1 工具修复、S2 monorepo 搬迁、S10 Adapter v2 规格、S11 three×wx spike、S12 SDF 字体工具链、S13 UI 布局内核、S14 热更新 manifest 原型。
- 可认领（4 个并行位）：**S3**（平台层 v2 + platform-wx，消费 S10 规格与 S11 路线 B 结论）、**S4**（UI 自绘框架，搬运 S12 字体产物与 S13 布局内核）、**S15**（CI/CD 门禁）、**S19a**（golden-master 回归 + 输入重放格式）。
- 认领方式：联系协调者会话领取派发提示词，或直接按 session-plan.md / framework-roadmap.md §3 对应小节执行。

## 7. 遇到问题

- 环境类坑（路径中文/空格、测试全红等）优先查本文件与 `docs/session-plan.md` §0。
- 架构疑问查 `docs/wx-minigame-redesign.md`；接口契约查 `docs/platform-adapter-v2.md`。
- PR 冲突：先合入者赢，后者 rebase `dev` 后重提。
