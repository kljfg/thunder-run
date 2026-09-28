# 遥测与日志框架接口规格（S16a · 评审稿）

> 状态：待协调者评审，通过后作为 S16b（实现，依赖 S3 合入）的契约下发。
> 基线：`dev@87ce734`。遥测构建在 v2 平台契约（`docs/platform-adapter-v2.md`）之上，**不改动 adapter 接口面本身**——只消费 `now/storage/onVisibility/fetchJson/extras.cloud`。
> 配套类型草案：`drafts/telemetry.ts`（可独立编译，验证命令见 §11；**未挂仓库 tsconfig**）。
> 上游依据：`docs/framework-roadmap.md` §3 S16（§4 埋点清单逐项对齐）、`docs/manifest-schema.md` §4（配置来源与失败策略表 = 命中率埋点挂点）、`docs/replay-format.md` §4/§5/§7（结果摘要与可复现三元组）、`config/game.json params.antiCheat`（采样百分比语义）。

## 1. 定位与设计原则

1. **packages/telemetry 是纯逻辑包**（与 core 同级）：级别过滤/采样/限流/批处理/信封组装全部与宿主无关；传输（sink）由外部注入。`console/sendBeacon/wx.*` 只出现在 `packages/platform-web`/`packages/platform-wx` 的 sink 实现里——与 check-import-rules 的纪律同构（S16b 建包时把 telemetry 并入「纯逻辑包」禁令集，见 §10）。
2. **三通道一条管线**：`级别过滤 → 采样 → 限流/去重 → 批队列 → 触发 flush → sink`。通道（log/metric/error）只是缺省策略不同的事件类型，不做三套机制。
3. **fire-and-forget、至多一次**：埋点侧一律同步调用、不返回 Promise、永不向业务抛异常。传输失败仅重试一次，丢弃计数由自监控事件 `telemetry.dropped` 上报。**不做磁盘持久队列**（wx storage 10MB 配额优先留给游戏数据，且崩溃后的重试队列语义复杂不值当）。
4. **采样稳定**：采样判定 = `(sessionId, 事件名)` 的稳定哈希——同一会话内同名事件全留或全丢，时序类事件（boot 阶段、帧分布）不被切成碎片；判定式可在服务端重算（「这个会话为什么没数据」可解释）。
5. **配置驱动、缺省安全**：开关/最低级别/采样/限流/批量全部来自 `config/game.json params.telemetry`（§5，框架技术段）。缺节或解析失败 → 等价 `createNoopTelemetry()`，调用点零分支（对齐 S10 §5 的 no-op 兜底思想）。
6. **数据形状三线一致**：对局结果事件直接复用 `docs/replay-format.md` §4 的结果摘要（`frames/summary/eventCounts/eventsSha256/inputsSha256`）；帧时间分桶边界是与 S19b perf bench 共享的规范常量。遥测、golden 回归、S18 云复跑看到的是同一组字段名与同一 canonicalJson。

## 2. 会话标识与事件信封

三要素：**bootId / sessionId / seq**。

| 标识 | 生命周期 | 生成 | 存放 |
|---|---|---|---|
| `bootId` | 每次冷启动唯一 | 12 hex 随机（web `crypto.getRandomValues`；wx `getUserCryptoManager().getRandomValues`；退化 `Math.random`） | 仅内存 |
| `sessionId`（`sid`） | 跨冷启动稳定（匿名设备级） | 首次生成 16 hex，之后复用 | `adapter.storage`，键 `thunderrun:telemetry:session`（沿用项目键前缀规范；wx `''` 歧义由 v2 storage 归一化解决——S10 D11） |
| `seq` | 会话内自 1 单调递增 | 管线组装时分配 | 内存（服务端可按 seq 断流检测丢批） |

所有事件共享信封（草案 §1 `TelemetryEnvelope`）：

| 字段 | 必填 | 说明 |
|---|---|---|
| `v` | 是 | 信封版本，v1 恒 `1`；接收端遇未知大版本**拒绝入库**（沿用 replay「不猜语义」铁律） |
| `ch` | 是 | `'log' \| 'metric' \| 'error'` |
| `ts` | 是 | `adapter.now()` 单调基准（ms，原点 = 平台构造时刻；与帧时间戳同基准，S10 D12） |
| `epochMs` | 是 | `Date.now()` 墙钟，仅用于跨会话排序/报表分日；**不要求客户端时钟准确** |
| `seq` / `bootId` / `sid` | 是 | 见上表 |
| `name` | 是 | 点分命名空间（`boot.phase`、`config.load`…），枚举集见 §4 |
| `level` | log/error | `'trace'\|'debug'\|'info'\|'warn'\|'error'\|'fatal'` |
| `kind` | metric | `'counter'\|'gauge'\|'timer'\|'histogram'` |
| `val` | metric | counter=增量；gauge=瞬时值；timer=ms；histogram=桶计数数组（`number[]`，形状见 §4.2） |
| `fields` | 否 | `Record<string, string \| number \| boolean \| null>` 平铺字段；嵌套对象先 `canonicalJson` 成字符串再入 fields（序列化字节稳定） |
| `tags` | 否 | 低基数维度（device/quality/env），供 group by；**高基数值禁入 tags**（seed/runId 一律进 fields） |

管线组装时统一注入的公共维度（埋点不重复填）：`tags: { env, quality }`、`fields: { engineVersion, configHash, device }`。`configHash` 定义见 §4.4；`device` = wx `getDeviceInfo()` 摘要 / web UA 截断。

## 3. 三通道接口

接口面（草案 §4 `Telemetry`，签名逐字以 draft 为准）：

```ts
log(level, name, fields?, opts?)                 // 结构化日志
metric(name, kind, val, tags?, opts?)            // 指标；histogram 的 val 是桶计数数组
error(err, context?, opts?)                      // 捕获栈并序列化；按指纹去重（§3.3）
withScope(scope): Telemetry                      // 子句柄：附加 runId/stage 等上下文；共享父管线
measure(name, fn): Promise<T>                    // timer 便捷封装：自动记录 ms 并透传结果
flush(): Promise<void>                           // 手动刷写（run.end / 退出路径用）
```

`opts?: { priority?: 'normal' | 'now' }`——`'now'`：立即成批发出（crash 专用），并绕过队列头部丢弃策略。

### 3.1 级别
- `minLevel` 来自 config（§5）。生产 wx 缺省 `info`；web `?debug` 缺省 `trace`。级别序 `trace < debug < info < warn < error < fatal`，低于 minLevel 的 **log 通道**事件直接丢弃（不计 dropped——级别过滤在采样之前，属预期行为）。
- `fatal` 仅 crash 通道使用（该 boot 可能就此终结）。
- metric / error 通道**不受 minLevel 约束**：metric 靠按名采样率控制量，error 无条件透传（仅指纹去重）。

### 3.2 采样
- 百分比 = 整数 `0..100`（对齐 `antiCheat.replaySampleRate` 的语义，不用 0..1 浮点，杜绝「0.5」这类配置事故）。
- 按事件名覆盖：`sampleRates[name]`；未命中用 `sampleRates.default`。
- 判定：`fnv1a32(sid + '\u0000' + name) % 100 < rate`（FNV-1a 32 位，纯整数，双端/服务端可重算）。
- error 通道固定 100%；`error.sample` 仅允许 `100 | 0`（应急总开关，不半采——崩溃不允许概率性丢失）。
- 采样丢弃在限流**之前**，被采样的事件不吃限流令牌。

### 3.3 限流与去重
- 普通通道：固定 60s 窗口、按 name 计数，超 `rateLimit.perNamePerMin`（缺省 30）即丢并累计 `telemetry.dropped{ reason:'rate', name, count }`（自监控事件本身豁免限流，每窗口最多 1 条）。
- 全局字节预算：`rateLimit.maxBytesPerMin`（缺省 64 KiB，按信封 JSON UTF-8 字节计），护弱网与云开发配额。
- error 通道用**指纹去重窗**替代普通限流：`fingerprint = hash(ch + name + message + 栈顶2帧)`；`error.dedupWindowMs`（缺省 60s）内同指纹只发一条，重复计数并入 `dupCount` 字段（后续同指纹事件更新同一条，或按批末快照重发——实现二选一，语义：崩溃风暴收敛为 1 事件 + 计数）。

### 3.4 批量刷写
- 触发条件（先到先刷）：队列达 `batch.maxEvents`（缺省 30）／队首事件等待超 `batch.maxDelayMs`（缺省 5000ms）／单批字节达 `batch.maxBytesPerFlush`（缺省 16 KiB——同时是 sendBeacon 体积安全线，Chrome 上限约 64 KiB，留 4 倍余量）。
- 强制刷写点：`adapter.onVisibility(hidden=true)`、web `pagehide`、wx `wx.onHide`（均经 sink 注册）、`priority:'now'`、`destroy()`。`batch.flushOnHide=false` 可关（仅调试用）。
- 失败策略：每批重试 1 次（间隔 2s，`batch.retry`），仍失败丢弃 + `telemetry.dropped{ reason:'transport' }`。不持久化。
- 队列上限 3 个批次（≈90 事件）；超限丢最老的 normal 事件（计入 dropped，`reason:'overflow'`）；`now` 优先批不丢。
- flush 结果自监控：`telemetry.flush{ ok, events, bytes, ms, retry }`（timer + counter 合并形态）。

## 4. 埋点清单（覆盖 roadmap §3 S16 全部条目）

> 每项含：事件名 / 通道 / 打点位（S16b 落码位置）/ 关键字段 / 去向。草案 §3 有对应 payload 类型。
> roadmap 原文条目 → 小节映射：首屏耗时→§4.1、局内帧时间分布(p50/p95)→§4.2、内存水位(wx.getPerformance)→§4.3、配置热更新命中率→§4.4、崩溃栈→§4.5、?debug 探针并入→§4.6、采样限流进 config 技术段→§3+§5。

### 4.1 首屏耗时 —— `boot.phase`（metric/timer，每阶段 1 条）+ `boot.summary`（log/info，每 boot 1 条）★

原点 `T0` = **入口脚本开始执行**（web：入口 bundle 第一行，可与服务端 navigation timing 对齐；wx：`wx.getPerformance().now()` 冷启动基准）。

| phase | 打点语义 | 代码位置（S16b） |
|---|---|---|
| `entry` | T0 → 入口模块体执行 | `apps/web/src/index.ts` / apps/wx 入口第一行 |
| `modulesReady` | T0 → 主包全部 import 顶层代码完成 | 入口 import 链之后、boot() 调用前 |
| `adapterInit` | T0 → PlatformAdapter v2 构造完成 | `createWebPlatform()/createWxPlatform()` 返回处 |
| `configStart` | T0 → loadAllConfig 开始 | bootstrap 配置加载调用点 |
| `configDone` | T0 → LoadReport 就绪（伴随 §4.4 loadSummary） | 同上 |
| `firstFrame` | T0 → 第一帧 renderer 提交完成 | render 首帧回调（rAF 内渲染后） |
| `interactive` | T0 → 主菜单首屏绘制完成、可接受首个输入 | ui bootstrap（S5 页面框架就绪后接线） |
| `total` | = interactive 值，**首屏头号指标** | 派生，不重复打点 |

- fields：`phase, ms`；tags：`quality`。`boot.summary` 把全部 phase 合并成一条发云（单点事件可降采样，summary 恒 100%）。
- wx 可选官方镜像：`wx.reportPerformance` 上报 `boot.total`（`transport.mirrorOfficial=true` 时启用；官方报表作交叉校验，自定义分解仍以 telemetry 为准）。

### 4.2 局内帧时间分布 p50/p95 —— `perf.frameDist`（metric/histogram）★

- 采集：run 主循环取 `requestFrame` 回调时间戳差分（与 `now()` 同基准，S10 D12 保证），**逐帧入桶、零逐帧事件**；桶计数数组常驻，事件只在收尾发。
- **规范桶边界** `FRAME_BUCKET_EDGES_MS`（telemetry 包导出常量，S19b 强制复用）：
  `[0,4,8,12,16,20,25,33,50,100,200,∞)` → 12 桶；最后一桶 = >200ms 溢出（卡顿/冻结）。
- 触发：`run.end` 每局 1 条；长局每 30s 加 1 条（fields 加 `cumulative:true`）；主菜单场景 `scene:'menu'` 每分钟 1 条（默认采样 `sampleRates['perf.frameDist']`，缺省 100）。
- fields：`runId, scene('run'|'menu'|'bench'), frames, buckets(number[12]), p50Ms, p95Ms, longCount(>50ms 帧数), worstMs, p95Approx?:boolean`。
- **p50/p95 定义（规范）**：对桶计数展开，nearest-rank 取 `ceil(q·frames)-1` 位；值 = 所在桶 `[下界,上界]` 按桶内均匀假设线性插值；∞ 桶按 400ms 封顶插值并置 `p95Approx:true`。S19b bench 可绕桶用帧数组算精确值——与桶近似值**双上报**，偏差率即该定义的误差预算（目标 <5%）。

### 4.3 内存水位 —— `perf.memory`（metric/gauge）+ `perf.memWarn`（log/warn）★

| 端 | 数据源 | 字段 / 说明 |
|---|---|---|
| web | `performance.memory.{usedJSHeapSize,totalJSHeapSize,jsHeapSizeLimit}`（Chromium 专有、非标准） | `usedMB,totalMB,limitMB` |
| wx 首选 | `wx.getPerformance()`。**注意**：小游戏文档面 Performance 仅承诺 `now()`（§11 实测记录）；`getEntries()`/`createObserver()` 是否可用、是否含 memory 型条目属基础库运行时能力，**S16b 真机验证后再启用** | `usedMB?` |
| wx 兜底 | `wx.onMemoryWarning` 级别回调（level 5=warning/10=danger/15=critical，以官方文档为准）→ 立即发 `perf.memWarn{ level }`，绕过采样 | `level` |
| 统一标注 | `src` 字段标记来源：`performance.memory` \| `getPerformance` \| `onMemoryWarning` \| `unavailable`，可用性在分析侧统计而非猜测 | |

- 频率：局内每 `memory.sampleEveryS`（缺省 10s）1 条 + `run.end` 附带本局高水位 `maxUsedMB`；读不到数据时**每 boot 发 1 条 `src:'unavailable'`**（iOS JS 堆普遍不可读），不许静默缺失。
- tags：`device`（机型聚合看泄漏趋势：同机型同版本 usedMB 单调爬升 = 泄漏嫌疑）。

### 4.4 配置热更新命中率 —— `config.load`（log/info，每文件）+ `config.loadSummary`（log/info，每 boot 1 条）★

- 挂点 = configLoader 的来源判定处。现状 `FileSource = 'network' | 'cache' | 'failed'`（`packages/core/src/config/configLoader.ts:19`）；manifest-schema §4 将增 `'bundle'`。**命中率 = 按文件 source 占比**，S16b 先接现有 LoadReport，S8 落地 manifest 链后无缝升级（source 枚举加法演进，事件形状不变）。
- `config.load` fields：`file(CONTENT_NAMES), source, ms, bytes?, sha12?, contentVersion?, fallbackCode?(F1..F10)`。`fallbackCode` 对齐 manifest-schema §4 失败策略表（F6=sha256 不匹配、F7=schema 校验失败需人工告警等）；正常路径无此字段。
- `config.loadSummary` fields：`countsBySource(嵌套 canonicalJson 串), hitRateCache%, hitRateBundle%, failedCount, manifestSource('fresh'|'cached'|'none'), contentVersion`。运维参考告警线：`hitRateCache < 60` 或 `failedCount > 0`。
- **`configHash`（信封公共字段）**：`contentVersion + ':' + sha256Hex(canonicalJson(files 按 CONTENT_NAMES 序的 sha256 列表)).slice(0,12)`；无 manifest（现网/S8 前）时 = `'bundle:' + configVersion`。作用：给 replay-format §5「可复现性三元组」的 engineVersion+configHash+replay 补上第二元，S18 云复跑据此锁配置版本。

### 4.5 崩溃栈与 unhandledrejection —— `crash.uncaught` / `crash.rejection` / `crash.wxError`（error/fatal）★

| 事件 | web 捕获点 | wx 捕获点 |
|---|---|---|
| `crash.uncaught` | `window.onerror`（ErrorEvent：message/source/line/col/error.stack） | `wx.onError(res)`（res.message + res.stack）→ `crash.wxError` |
| `crash.rejection` | `window.addEventListener('unhandledrejection')` | `wx.onUnhandledRejection({ reason })` |

- 安装点在 **sink 层**：`installErrorCapture(host, telemetry)`——web 实现在 platform-web、wx 实现在 platform-wx（`window/wx` 全局不进 packages/telemetry）。同端多捕获器并存（onerror + rejection）互不吞并。
- 栈序列化规范：`message`（≤512B 截断）、`stack`（≤ `error.maxStackBytes` 缺省 4096B，**保留栈顶**=离抛出点最近）、`file/line/col`、web 跨域脚本栈被浏览器净化时置 `src:'crossorigin'`、`reasonType`（rejection：typeof + 构造器名）。sourcemap 还原归服务端（CI 保留构建产物 map），客户端不做还原。
- 走 `priority:'now'`：崩溃可能就是该 boot 最后一条事件，立即成批发出 + 限流豁免；指纹去重见 §3.3。
- wx 双写：error 通道**同步镜像** `RealtimeLogManager.error/warn`（手机上立即可查、不依赖网络落库），云数据库走批（§7）。

### 4.6 ?debug 探针并入统一通道 —— Console Sink 环缓冲 + `debug.probe`（log/trace，可选）★

- `__trRun.state/probe` 对外形状**保持不动**（调试脚本依赖），实现改为读 Console Sink 的环缓冲 `recent(n)`（最近 N 条信封快照）——runDebugProbe 的帧内快照成为 `perf.frameDist`/`debug.probe` 的采样视图，「两套数据」变「一套数据、两个视图」。
- `debug.probe` 事件 = runDebugProbe 现有字段形状（r2 圆整后），缺省采样 0%，按需调高用于云侧回放调试。
- 埋点侧禁止再散落 `console.log`：`?debug` 时 Console Sink 即所有通道的 echo（前缀 `[tr.<level>] <name>`），与现网调试习惯一致。

### 4.7 管线自监控与生命周期（S16 自身配套）

- `session.boot{ phase:'start', wxBaseLib? , launchMode }`：每冷启动第一条（100% 采样、限流豁免），会话/DAU 锚点。
- `run.start{ runId, seed, charId, quality }` / `run.end{ …§8 对局结果… }`。
- `telemetry.dropped{ reason:'rate'|'bytes'|'overflow'|'transport'|'disabled', name?, count }`（每窗口 ≤1 条）、`telemetry.flush{ ok, events, bytes, ms, retry }`。

## 5. config 技术段 `params.telemetry`

`config/game.json` 的 `params.telemetry` 节（框架技术段，与 quality 同侧；数值以 §3 缺省为准）：

```json
"telemetry": {
  "enabled": true,
  "minLevel": "info",
  "sampleRates": { "default": 100, "perf.frameDist": 100, "debug.probe": 0 },
  "rateLimit": { "perNamePerMin": 30, "maxBytesPerMin": 65536 },
  "batch": { "maxEvents": 30, "maxBytesPerFlush": 16384, "maxDelayMs": 5000, "flushOnHide": true, "retry": 1 },
  "error": { "sample": 100, "maxStackBytes": 4096, "dedupWindowMs": 60000 },
  "memory": { "sampleEveryS": 10 },
  "transport": { "webEndpoint": "", "wxRealtimeLog": true, "wxCloudCollection": "telemetry", "mirrorOfficial": false }
}
```

- `webEndpoint=''`：web 调试壳只 Console echo 不发网络；联调 collector 时填 URL（同源相对路径即可，Vite dev 代理）。
- `enabled=false`：管线直通丢弃（仍计数 `telemetry.dropped{reason:'disabled'}` 一条，避免「关了却没确认」）。
- **schema/configValidator 同步说明**（S16b 落码时执行，本任务零改动）：
  1. `configValidator.validateFile` 对 `game` 仅校验 `params` 为非空对象（`packages/core/src/config/configValidator.ts:26-29`），`tools/validate-config.mjs` 同理 → **新增节不需要改校验器代码**。
  2. 需同 PR 改三处（roadmap §1「技术段 + schema 分区标注」契约）：① `config/game.json` 增本节；② 设计库 `schema/config.schema.json` 的 `game.params.telemetry` 定义并标注技术段（仓库 `$schema` 指针所指向的 schema 目前随设计库 `D:\gpt-6\work\酷跑小游戏` 维护，两边同步义务见 AGENTS.md §4）；③ 设计库 docs/03 参数表加行。里程碑合入 main 后按 roadmap §4 发「框架变更通告」知会作者侧。
  3. 类型与解析：packages/telemetry 导出 `TelemetryConfig`（草案 §4）与 `readTelemetryConfig(params)`——缺节/类型错 → 返回 undefined（→ noop 管线）并对越界数值**钳制**（sample 0..100、maxEvents 1..200、maxBytesPerFlush ≤ 64KiB），钳制发生即 warn 一条。

## 6. web 实现映射（packages/platform-web + apps/web）

| 规格成员 | web 实现 |
|---|---|
| log/metric/error 入队 | `createWebTelemetry(host)`：管线在 packages/telemetry（纯逻辑），sink 注入下表各项 |
| Console echo | `console.debug/info/warn/error('[tr.<level>]', name, fields)`；`?debug` 时 trace 级也出。环缓冲 `recent(n)` 供 `__trRun`（§4.6） |
| flush 传输 | `navigator.sendBeacon(webEndpoint, new Blob([canonicalJson(batch)], {type:'application/json'}))`；返回 false 或 API 缺失 → 退化 `fetch(url, { method:'POST', keepalive:true, body })`。**不引入 collector SDK**：payload 就是信封数组，collector 端形态归 S8/S9 网络线定 |
| 强刷时机 | `adapter.onVisibility(hidden)` + `window.addEventListener('pagehide')`（sendBeacon 的最后窗口，二者幂等去重） |
| sessionId | `adapter.storage`（localStorage 包装，v2 已含 try/catch 静默）键 `thunderrun:telemetry:session` |
| 内存 | `performance.memory` 存在则采样；否则 `src:'unavailable'`（Firefox/Safari） |
| crash | `window.onerror` + `unhandledrejection` 各一监听器（sink 的 `installErrorCapture`），bootId 在首条事件里已可关联 |
| boot 时钟 | `entry` 之前的耗时想对齐导航起点：`performance.timeOrigin` 换算后并入 `boot.summary` 的 `navOffsetMs` 字段（可选，仅 web 有） |

## 7. wx 实现映射（packages/platform-wx）

| 规格成员 | wx 实现 |
|---|---|
| 实时日志镜像 | `wx.getRealtimeLogManager()`：`log.info/warn/error(msg)`，msg = 单行 `name\|k=v\|…`（关键 3~5 字段，**不是全量信封**——实时日志是排查入口，全量数据在云数据库）。`setFilterMsg(bootId)`：真机复现某局后在 MP 后台按 bootId 过滤（过滤词有条数/长度上限，用短 bootId，不放长字段） |
| 镜像级别策略 | `transport.wxRealtimeLog`：error/fatal 恒镜像；warn 级与 `boot.summary`/`config.loadSummary`/`crash.*` 等关键 log 镜像；metric 常规不镜像（实时日志有平台频控，客户端限流先于平台频控，不裸奔） |
| 云数据库上报 | 经 `extras.cloud.callFunction('telemetryIngest', { sid, bootId, batch })`（S10 CloudBridge），批 ≤ `maxBytesPerFlush`。**推荐云函数代收而非客户端直写 DB**：写权限白名单 + 入库前 schema 校验，防开放集合写入成垃圾场。云环境未就绪（S9 前）→ 云通道自动退化为 realtime-log-only + 内存批丢弃，不发裸 `wx.request`（域名白名单摩擦留 S8 统一解） |
| onHide flush | `wx.onHide`（sink 注册；与 adapter.onVisibility 同源事件，只接一次）触发 flush；flush 与 JS 引擎冻结赛跑——realtime log 是同步写、天然先落，云通道尽力而为 |
| sessionId | `adapter.storage` → `wx.setStorageSync`（v2 D11 归一化） |
| 内存 | `wx.getPerformance()`（文档面 `now()`；memory 条目能力 S16b 真机验证 §4.3）+ `wx.onMemoryWarning` 兜底 |
| crash | `wx.onError` / `wx.onUnhandledRejection` + `RealtimeLogManager.error` 同步镜像（§4.5） |
| 官方数据渠道 | 可选 `wx.reportPerformance`（boot.total 镜像，`mirrorOfficial`）。`wx.getGameLogManager/reportMonitor/reportEvent` 属官方数析体系——**本规格不复用**，避免双定义；官方报表与 telemetry 交叉验证即可 |
| sendBeacon 近似 | 无等价物；`wx.request` POST 不处理响应 ≈ wx 端 beacon 语义，本规格不用（统一走云函数通道） |

## 8. 与 S18（防作弊）/ S19b（perf bench）的数据形状对齐

**`run.end` 事件 payload（规范形状，草案 §3 `RunEndPayload`）**——直接复用 `tools/replay/runner.mjs runReplay()` 的返回结构：

```json
{
  "runId": "…", "seed": 777, "charId": "char_volt",
  "frames": 1234,
  "summary": { "t": 0, "distance": 0, "coins": 0, "nearMiss": 0, "hits": 0, "score": 0, "alive": false, "casts": 0, "charId": "" },
  "eventCounts": { "coin": 0, "hit": 0 },
  "eventsSha256": "<64hex>", "inputsSha256": "<64hex>",
  "engineVersion": "…", "configHash": "3:9f86d081884c",
  "frameDist": { "buckets": "见 §4.2", "p50Ms": 0, "p95Ms": 0 },
  "maxUsedMB": 0, "revives": 0
}
```

- **S18 上报体** `{ engineVersion, configHash, replay, result }`（replay-format §7）：`result` 即本事件的 `{frames,summary,eventCounts,eventsSha256,inputsSha256}` 子结构；`replay.inputs` 走 S18 自己的排行榜通道，**telemetry 不携带完整重放**（体积）。`inputsSha256` 允许先行做快速一致性预检。
- 排行榜写入门禁不过 → 发 `anticheat.reject{ reason, score, eventsSha256, inputsSha256 }`（log/warn 级事件，roadmap S18「校验不过只入本地榜并打点上报（S16 通道）」即此）。
- canonicalJson/sha256Hex 语义以 `tools/replay/runner.mjs:35-44` 为准；S16b 把该对纯函数提为共享导出（packages/core 或 telemetry），云函数/CI/客户端一份实现——**哈希一致是三线对齐的前提**。
- **S19b perf bench**：`import { FRAME_BUCKET_EDGES_MS, percentileFromBuckets } from '@tr/telemetry/buckets.js'`（纯逻辑、零 DOM，node 可直测）；bench 输出与 `perf.frameDist` 同形状记录（`scene:'bench'`），CI 趋势与线上遥测共用一张表。golden 的 result 摘要与本事件共用字段名，报表不须双写。

## 9. 关键设计决策清单（评审点）

- **D1 纯逻辑包 + 注入 sink**：packages/telemetry 零平台依赖（与 core 同级纪律），console/beacon/realtimeLog/cloud 全在 platform-web/platform-wx 的 sink 实现。埋点方面向 `Telemetry` 接口，可被 game/render/ui import 而不触 import 禁令。
- **D2 三通道一条管线**：log/metric/error = 同一信封 + 不同缺省策略（级别过滤豁免、采样、去重、优先级），不做三套机制。
- **D3 会话级稳定采样**（`fnv1a32(sid + '\0' + name) % 100`）：同会话同名事件同生共死，时序链完整；判定可在服务端重算，「这个会话为什么没数据」可解释。
- **D4 采样单位 = 整数百分比 0..100**：对齐 `antiCheat.replaySampleRate` 语义，杜绝 0..1 浮点误配；`error.sample` 仅 100|0（崩溃不许概率性丢失）。
- **D5 标识三要素 bootId/sid/seq**：bootId 冷启动级、sid 跨启动匿名稳定（storage 持久）、seq 断流检测；键沿用 `thunderrun:` 前缀规范。
- **D6 帧分布预分桶 + 规范桶边界**：客户端常驻 `number[12]`（O(1) 内存）；p50/p95 = nearest-rank + 桶内均匀插值，定义写进规范（§4.2），与 S19b 共享同一常量——分布跨端可比。
- **D7 run.end 复用 replay 结果摘要**：`eventsSha256/inputsSha256/summary` 字段名逐字同 `tools/replay/runner.mjs`；S18/telemetry/golden 三线一份形状、一份 canonicalJson。
- **D8 命中率埋点挂 LoadReport.sources**：现有 `'network'|'cache'|'failed'` 先接；S8 的 `'bundle'` 与 F1..F10 为加法演进，事件形状不变；`configHash` 补齐可复现三元组。
- **D9 web：sendBeacon 主 + fetch keepalive 兜底**；pagehide/visibilitychange 双触发幂等去重；`webEndpoint=''` 时纯 console echo（调试壳零网络噪音）。
- **D10 wx：realtime log 做「立即可查」摘要镜像，云数据库做「全量结构化」**；云写推荐经云函数代收（权限+校验），S9 云环境前自动退化 realtime-only；realtime log 消息是 `name|k=v` 单行摘要而非全量信封（平台频控/截断）。
- **D11 内存 API 诚实三档**：wx.getPerformance() 小游戏文档面仅承诺 `now()`——memory 条目（待真机验证）/ onMemoryWarning 兜底 / `unavailable` 标注，`src` 字段自证来源；读不到也发声，不静默。
- **D12 至多一次 + 单批 1 次重试，无磁盘队列**：storage 配额让位游戏数据；丢失经 `telemetry.dropped` 可见。
- **D13 配置缺节/disabled → noop，调用点零分支**：与 S10 WxExtras no-op 兜底同形；`enabled=false` 也发一条 dropped{disabled} 作确认。
- **D14 crash `priority:'now'` + 指纹去重窗**：风暴收敛为 1 事件 + dupCount；now 批不入可丢队列。

## 10. 给 S16b 的拆分建议（实现会话，依赖 S3 合入）

| PR | 内容 | 依赖 |
|---|---|---|
| ① | `packages/telemetry` 核心管线：信封/采样(FNV-1a)/限流/去重/批处理/分桶（全纯函数）+ `TelemetryConfig` 解析 + noop + `TelemetryHost` 结构子集（`now/storage/onVisibility`，v2 adapter 天然满足）+ `tests/telemetry.test.mjs`（node:test 矩阵：采样稳定性、窗口限流、指纹去重、桶/百分位、信封字段与 seq 单调） | 无（可与 S3 并行开发，接线在后续 PR） |
| ② | config 技术段落地：`config/game.json` 增 `params.telemetry` + 设计库 schema + docs/03 参数表三处同步（roadmap §1；validator 零改动，见 §5） | ① |
| ③ | platform-web sink（console+环缓冲+sendBeacon+error capture）+ apps/web boot 接线（§4.1 阶段点 + `?debug` 并入 §4.6）；collector 先打 Vite dev 中间件，生产 `webEndpoint=''` | S3、① |
| ④ | platform-wx sink（RealtimeLogManager 镜像 + onHide flush + wx.onError/onUnhandledRejection + 内存三档真机验证回填 §4.3）；`telemetryIngest` 云函数骨架挂 S9 待办，本期 realtime-only | S3、①（与 S7 真机协作） |
| ⑤ | 埋点接线批：`run.start/run.end`（§8 payload）、`perf.frameDist`（runnerScene 桶驻留）、`config.load*`（configLoader 调用点）、`anticheat.reject` 形状预留（S18 消费） | ③④ |
| ⑥ | 基建收口：`tools/check-import-rules.mjs` 把 `packages/telemetry` 并入纯逻辑禁令集、render/ui/game 允许面加 `@tr/telemetry`；wx 主包体积门禁（S15 占位）计入 telemetry 产物 | ①~⑤ |

- 文件 ≤300 行纪律照旧；桶边界与百分位放 `packages/telemetry/src/buckets.ts` 单文件，S19b 只 import 它。
- 验收挂点：`npm run check` 全绿 + §4 清单每条能在新 collector（web 本地）/实时日志页+云集合（wx 工具）看到样例事件。

## 11. 验证记录

- 类型草案独立编译（无 DOM lib，证明自包含）：
  `npx tsc --noEmit --strict --target es2020 --lib es2020 --module esnext --typeRoots <空目录> drafts/telemetry.ts` → **通过（workspace typescript 5.5.4）**
  注：`--typeRoots` 指向空目录是为禁用 node_modules/@types 自动注入（仓库根 @types/three、@types/webxr 在无 DOM lib 下自身编译失败，与本草案无关）；草案零 import、零宿主类型引用，去掉该参数加 `--lib es2020,dom` 亦通过。
- 与 DOM lib 共存编译（web sink 同环境）：
  `npx tsc --noEmit --strict --target es2020 --lib es2020,dom --module esnext drafts/telemetry.ts` → **通过**
- wx API 事实核对（2026-09-28，developers.weixin.qq.com/minigame 官方文档）：
  - `wx.getRealtimeLogManager` → RealtimeLogManager：文档列 `error/warn/info/setFilterMsg/addFilterMsg`（另有 `wx.getLogger` 分级 Logger）；
  - `wx.getPerformance()` → 小游戏文档面 Performance **仅列 `now()`**——本规格据此把内存采集设计为三档降级（§4.3/D11），条目级能力归 S16b 真机验证；
  - 应用级事件 `wx.onError`、`wx.onUnhandledRejection` 均在小游戏 API 文档；官方性能通道 `wx.reportPerformance` 存在（仅作可选镜像）。
- 本任务未修改任何既有文件（纯新增 `docs/telemetry-spec.md`、`drafts/telemetry.ts`），与在飞 S3/S4 零路径冲突。

## 12. 开放问题（评审时裁决 / S16b 带回）

1. **collector 端形态**（webEndpoint 指向何处、信封如何入库）：归 S8/S9 网络线；本规格只锁定 payload = 信封数组的 canonicalJson。
2. **`telemetryIngest` 云函数 vs 客户端直写 DB**：§7 推荐前者；S9 云环境就绪时结合 DB 权限模型一并裁决。
3. **wx memory 条目实际可用性**：S16b 真机矩阵（Android/iOS × 基础库版本）回填 §4.3 后删除「待验证」标注。
4. **seq 断流检测的价值**：队列 3 批上限下 seq 空洞率可接受到多少——上线两周看 `telemetry.dropped` 分布再调 batch 参数。
5. **`error.sample=0` 逃生舱定位**：仅平台频控事故应急；常态必须 100。
6. **`debug.probe` 环缓冲替换 runDebugProbe 的兼容窗口**：`__trRun` 对外形状保留多久（建议至 S5 页面迁移完成后评审）。
