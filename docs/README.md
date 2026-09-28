# 规划文档索引（协作者入口）

> 按角色选读。所有文档随 `dev` 分支演进，`main` 为里程碑快照。

## 阅读顺序

| 你是谁 | 先读 | 再读 |
|--------|------|------|
| 新加入协作者（任何角色） | `CONTRIBUTING.md`（环境/命令/规范/边界） | `docs/framework-architecture.md` §1-§3（原则/包地图/契约注册表） |
| 框架任务执行者 | 本目录 `session-plan.md`（找到自己的 S 编号，按提示词开工） | `framework-architecture.md` §5（文件所有权）、对应契约文档 |
| 内容任务执行者（角色/关卡/数值） | 本目录 `content-track.md`（规则 + golden-master 协议 + C1/C2 提示词） | `CONTRIBUTING.md` §5 |
| 评审/协调 | `session-plan.md` §3 登记板（进度）+ §4（协调规则） | `framework-architecture.md` §6-§7（整合清单/决策点） |

## 文档清单

| 文档 | 内容 |
|------|------|
| `wx-minigame-redesign.md` | 技术栈重设计方案（微信小游戏为主目标，M5-M9 里程碑） |
| `framework-roadmap.md` | 框架与技术栈路线图（职责边界、框架域地图、S15-S19 任务定义） |
| `framework-architecture.md` | ★ 框架架构总览：包地图、契约注册表、数据流、所有权矩阵、S20 整合清单、遗留决策点 |
| `session-plan.md` | 会话协调计划：全部 S 任务提示词、波次依赖、状态登记板 |
| `content-track.md` | 内容轨道：内容侧规则、golden-master 协议、C1/C2 提示词 |
| `platform-adapter-v2.md` | 平台抽象层 v2 契约（S3 已落地） |
| `manifest-schema.md` | 配置热更新 manifest 契约（S8 实装） |
| `replay-format.md` | 输入重放格式 v1（golden-master 与 S18 防作弊地基） |
| `telemetry-spec.md` | 遥测三通道契约（S16b 实现中） |

## 波次进度速览（详见 session-plan.md §3 登记板）

- ✅ 已完成：S1-S6、S10-S15、S16a、S17、S19a + M2 运行时审计修复（364 例全绿，check ALL PASS）
- 🔨 在飞：S16b（遥测实现，已提交未 push，需 rebase）
- 📋 可认领：**S20**（整合接线，含 UI/主场景 renderer 合并——S5 遗留，wx 侧阻塞项）、**S19b**（UI 快照 + perf bench）、**C1/C2**（内容轨道，issue #7/#8）、S7/S8（待 S20）
- 🔮 后续：S9（社交/登录/云存档）、S18（防作弊云复跑）、上架材料（软著/自审报告）
