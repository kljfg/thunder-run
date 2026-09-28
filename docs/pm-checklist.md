# PM 手册：分派表 / 决策清单 / 评审 SLA / kickoff

> 项目管理：Fukaki-Ato（PM）。协调者会话负责评审合并与登记板；协作者按本手册认领与汇报。
> 任务定义与提示词见 `docs/session-plan.md`；入口索引 `docs/README.md`。

## 1. 分派表（建议稿，PM 可调整；认领以 issue 评论为准）

| 任务 | 建议承接 | 前置（PM 提供） | 状态 |
|------|----------|----------------|------|
| C1 角色/技能/道具（issue #7） | kljfg | docs 库同步由其本机执行 | 待认领 |
| C2 赛道/障碍/经济（issue #8） | mostny | 无 | 待认领 |
| S19b UI 快照 + perf bench | mostny | 无（依赖 S4/S6 已就绪） | 待认领 |
| S5 页面迁移 / S16b 遥测 | 在飞（PM 本地会话） | 无 | 收尾中 |
| S20 整合接线 | 协调者会话 | S5/S16b 合入 | 排队 |
| S7 真机性能 | mostny（S20 后） | 真机 + 体验版权限 | 排队 |
| S8 CDN + 热更新 | kljfg（S6 已就绪） | CDN 选型拍板 | 排队 |
| S9 社交/登录/云存档 | 视人力再派 | AppID/主体/云环境 | 排队 |
| S18 防作弊云复跑 | 随 S9 | 云环境 | 排队 |

## 2. PM 决策/资源清单（★=阻塞型，不给则对应任务停摆）

| 项 | 影响 | 建议默认 | 状态 |
|----|------|----------|------|
| ★ 正式 AppID + 主体类型 | S7/S9/上架 | 企业主体优先（个人主体不能接支付与部分开放能力） | 待办 |
| ★ 云开发环境开通 | S9/S18/S8 备选 | 微信云开发（免备案域名，起步最快） | 待办 |
| ★ 真机（含低端安卓）+ 体验版权限 | S7 验收 | PM 提供设备或云测账号 | 待办 |
| ★ 软著申请启动 | 上架（30-40 工作日） | 立即启动，与开发并行 | 待办 |
| CDN 选型 | S8 | 起步用微信云开发存储，量大再迁外部备案 CDN | 待拍板 |
| 云后端选型 | S9 | 微信云开发（云函数承载 code2session 与复跑校验） | 待拍板 |
| docs 库同步机制 | C1/C2 长期 | 每里程碑由 kljfg 将 docs 库 config/ 与参数表变更以 `content(docs-sync)` 提交同步进本仓 PR 描述清单 | 待 kljfg 确认 |

## 3. 评审与响应 SLA

- 框架 PR：协调者会话 24h 内首轮评审（CI 绿为前提）；PM 抽查。
- 内容 PR：PM + 协调者共审，**golden diff 逐条过**（content-track.md §1.3）；48h 内响应。
- main/dev 破坏性故障（CI 红、构建断）：即时处理，协调者会话可直接 hotfix。
- 认领响应：issue 评论认领后 48h 内应有首个进展评论，否则 PM 重新分派。

## 4. 汇报节奏与模板

- 事件驱动：任务完成/阻塞当天在对应 issue 评论；PM 每周扫一次登记板（session-plan.md §3）。
- 汇报模板（完成）：分支与 commit 列表 / 验收命令输出摘要 / 接口或契约变化 / 遗留与下游提示。
- 汇报模板（阻塞）：阻塞点 / 已尝试 / 需要谁给什么（资源或决策编号，见 §2）。

## 5. Kickoff 文案（issue #9 已发，含 @mostny @kljfg）

环境自检三步（认领前必做）：
```bash
git clone https://github.com/kljfg/thunder-run.git && cd thunder-run
npm install && npm run check        # 必须 ALL PASS；失败先查 CONTRIBUTING.md §2
node tools/replay/runner.mjs tools/replay/examples/example-v1.json   # 重放链路自检
```
认领方式：在 issue #9 评论「认领 <编号>」→ 按 §1 分派表或任务池自选 → worktree 开工 → PR 到 dev。
