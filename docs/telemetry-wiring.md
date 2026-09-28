# 遥测接线说明（S16b 交付 · 整合会话执行）

> 契约：`docs/telemetry-spec.md`（S16a）；实现：`packages/telemetry`（纯逻辑管线）+
> `packages/platform-web/src/telemetryChannel.ts`（web sink）+ `packages/telemetry/src/wxChannel.ts`（wx 通道类）。
> 本会话按派发纪律**未触碰** `packages/game` / `apps/web/src` / `packages/platform-wx`（S5/S6 并行）——
> boot/mainFlow/runnerScene 的埋点接线延后到整合会话（S20），本文给出逐点位说明与可粘贴代码。
> 类型契约与 spec 的偏差清单见 §7（验收要求项）。

## 0. API 速览

```ts
// 装配（web，两步）：
import { createWebTelemetry } from '@tr/platform-web/telemetryChannel.js';
const th = createWebTelemetry(adapter, { params: gameJson.params, debug, t0, navOffsetMs: t0 });
// th.telemetry —— Telemetry 接口（log/metric/error/withScope/measure/flush/recent/destroy）
// th.sdk     —— 埋点 SDK（markBoot/frameTime/memory/configSource/unhandledError/runStart/runEnd…）
// th.common  —— 可变公共维度（配置加载后回填 configHash/quality，信封组装时读当前值）
// th.uninstall() —— pagehide/crash 捕获退订 + destroy（最终 flush）

// 底层（wx / 自定义装配）：
import { readTelemetryConfig, TELEMETRY_CONFIG_DEFAULTS } from '@tr/telemetry/config.js';
import { createTelemetry } from '@tr/telemetry/pipeline.js';
import { createNoopTelemetry } from '@tr/telemetry/noop.js';
import { createTelemetrySdk } from '@tr/telemetry/sdk.js';
import { assembleWxSinks } from '@tr/telemetry/wxChannel.js';
```

SDK 五个规定面（派发任务 4）与 spec 事件的映射：

| SDK 方法 | spec 事件 | 说明 |
|---|---|---|
| `sdk.markBoot(stage, ms?)` | `boot.phase`(metric/timer) + `boot.summary`(log/info) | ms 缺省 = now()-T0；标到 interactive 自动派生 total 并发 summary（每 boot 1 条） |
| `sdk.frameTime(dtMs)` | （零逐帧事件）→ `perf.frameDist`(metric/histogram) | 逐帧入桶 O(1)；`sdk.emitFrameDist(scene,{runId,cumulative,reset})` 收尾发事件 |
| `sdk.memory(bytes\|null, extra?)` | `perf.memory`(metric/gauge)；`sdk.memWarn(level)` → `perf.memWarn` | null = 读不到 → src:'unavailable' 每 boot 1 条；本局高水位 `sdk.maxUsedMB()` |
| `sdk.configSource(hit)` | `config.load`(log/info)；`sdk.configSummary(…)` → `config.loadSummary` | hit = ConfigLoadPayload{file,source,ms,…}（configLoader LoadReport 直喂） |
| `sdk.unhandledError(err, ctx?, name?)` | `crash.uncaught`/`crash.rejection`/`crash.wxError`(error/fatal) | priority:'now' 内建；capture 层已自动调用（见 §2.1/§4），业务兜底才手动调 |

另有 `sdk.bootStart()`（session.boot，管线豁免采样/限流）、`sdk.runStart/runEnd/anticheatReject`
（payload 形状 = spec §8，S18 同源）、`sdk.debugProbe(fields)`（debug.probe，缺省采样 0%）。

## 1. 交付边界（本会话 vs 整合会话）

| 已交付（本会话） | 留给整合会话（S5/S6 合流后） |
|---|---|
| packages/telemetry 全部纯逻辑 + 单测 | §2 的 web 埋点接线（apps/web/src/bootstrap.ts、packages/game/src/mainFlow.ts、packages/render/src/runnerScene.ts） |
| platform-web telemetryChannel.ts（console/环缓冲/beacon/crash 捕获/装配面） | §2.4 ?debug 探针并入（__trRun 读 recent(n)，兼容窗口 spec §12.6） |
| wxChannel.ts 类 + 单测（结构化注入，零宿主全局） | §4 的 platform-wx 注册文件（薄层）+ 真机验证回填 spec §4.3 |
| config/game.json params.telemetry + configValidator 技术段校验 | §6 设计库三处同步（schema/参数表——本机无设计库路径，片段已备好） |
| docs/telemetry-wiring.md（本文） | collector 端点（Vite dev 中间件，spec §10 PR③ / §12.1 归 S8/S9 网络线） |

## 2. web 端接线（S5 合流后执行）

### 2.1 apps/web/src/bootstrap.ts（入口）

```html
<!-- index.html：module script 之前加一行（T0 = 入口脚本开始执行，spec §4.1；
     含 bundle 下载耗时，可与服务端 navigation timing 对齐） -->
<script>globalThis.__trT0 = performance.now();</script>
```

```ts
// bootstrap.ts 模块体顶端（import 链已完成 = modulesReady 时点）：
const tReady = performance.now();
const T0 = (globalThis as { __trT0?: number }).__trT0 ?? tReady;

const adapter = createWebPlatform({ mount: document.getElementById('screen')! });

// 配置时序二选一（telemetry 配置本身在 game.json 里，先有鸡先有蛋）：
//   方案 A（推荐，调试壳可接受一次 fetch）：先 await fetch('./game.json') 拿 params 再装配；
//   方案 B：cfg: TELEMETRY_CONFIG_DEFAULTS 直接装配，配置加载完成后仅回填 common（不重建管线）。
const th = createWebTelemetry(adapter, {
  params: gameParams,           // 方案 A；方案 B 改传 cfg
  debug: location.search.includes('debug'),  // ?debug → minLevel 钳 trace（spec §3.1）
  t0: T0, navOffsetMs: T0,      // web 的 performance.now 原点即 navigation start
  engineVersion: '0.1.0',
  // endpoint: '/telemetry',    // 联调 collector 时覆盖（Vite dev 中间件，spec §5：生产恒 ''）
});
const sdk = th.sdk;
sdk.bootStart({ launchMode: 'web' });            // 每冷启动第一条（100%、限流豁免）
sdk.markBoot('entry', tReady - T0);              // entry/modulesReady 在 ESM 下同点，保阶段链完整
sdk.markBoot('modulesReady', tReady - T0);
sdk.markBoot('adapterInit');                     // adapter 构造完成（此刻 now()-T0 自动计）

// 内存兜底（spec §4.3：读不到也发声）：
import { readWebMemory } from '@tr/platform-web/telemetryChannel.js';
const mem = readWebMemory();
if (mem.src === 'unavailable') sdk.memory(null, { src: 'unavailable' }); // 每 boot 1 条
```

crash 捕获（window.onerror + unhandledrejection）与 pagehide flush 已由 `createWebTelemetry`
自动安装（`installErrorCapture:false` 可关）；`th.uninstall()` 退订。

### 2.2 packages/game/src/mainFlow.ts —— boot()（现 101-123 行）

```ts
async function boot(): Promise<void> {
  sdk.markBoot('configStart');                        // loadAllConfig 调用点前
  const report = await loadAllConfig(/* …不变… */);
  sdk.markBoot('configDone');
  // 逐文件来源打点（spec §4.4：命中率 = 按文件 source 占比；S8 的 'bundle'/F1..F10 加法演进）
  const counts: Record<string, number> = {};
  for (const name of CONTENT_NAMES) {
    const source = report.sources[name];              // FileSource：network|cache|failed（S8 增 bundle）
    counts[source] = (counts[source] ?? 0) + 1;
    sdk.configSource({ file: name, source, ms: 0 /* configLoader 未计时则 0，S8 补 per-file ms */ });
  }
  sdk.configSummary({ countsBySource: counts, manifestSource: 'none' /* S8 接 manifest 后改 fresh|cached */ });
  // 公共维度回填（configHash = 可复现三元组第二元，spec §4.4）：
  th.common.fields!.configHash = configHashBundle(report.content.game.configVersion); // S8 前：bundle:<ver>
  // S8 后改：configHashFromShaList(contentVersion, sha256List按CONTENT_NAMES序)
  th.common.tags!.quality = currentQuality;           // 画质分级选定处（S7）
  …
}
```

注：`GameFlowDeps` 需要加可选 `telemetry?: TelemetrySdk`（或整只 handle）注入——mainFlow 属 S5
所有权，本会话未改；整合会话接线时加依赖并两端（web/wx bootstrap）传入，缺省不传则内部持
`createTelemetrySdk(createNoopTelemetry(), …)` 零开销兜底（调用点零分支，D13 同款思想）。

### 2.3 run 生命周期 —— mainFlow run 场景 + packages/render/src/runnerScene.ts

| 点位 | 代码位置 | 调用 |
|---|---|---|
| `run.start` | mainFlow.ts run.onEnter（lastSeed/charId 已就绪，~66 行） | `sdk.runStart({ runId, seed: lastSeed, charId })`；`sdk.frameDist.reset(); sdk.resetMemory()` |
| 逐帧入桶 | runnerScene.ts tick(nowMs)（~188 行，`last` 更新处） | `sdk.frameTime(nowMs - lastRenderTs)`（rAF 时间戳差分，与 now() 同基准 D12；paused 帧不计） |
| 长局快照 | 同上，累计 ≥30s 时 | `sdk.emitFrameDist('run', { runId, cumulative: true, reset: false })` |
| 内存采样 | 同上，累计 ≥ memory.sampleEveryS 时 | `const m = readWebMemory(); m.src === 'unavailable' ? sdk.memory(null, m) : sdk.memory(m.usedMB!*1048576, { totalBytes:…, limitBytes:…, src: m.src })`（wx 侧数据源见 §4） |
| 菜单帧分布 | S5 菜单渲染循环（每分钟） | `sdk.emitFrameDist('menu', { runId: '' })` |
| `boot.firstFrame` | 首帧 renderer 提交完成（rAF 内渲染后；boot 期无 renderer pass 则在 menu 首帧标，或留缺——BootSummaryPayload 是 Partial） | `sdk.markBoot('firstFrame')` |
| `boot.interactive` | S5 主菜单首屏绘制完成、可接受首个输入处 | `sdk.markBoot('interactive')`（自动派生 total + 发 boot.summary；`mirrorOfficial=true` 时 wx 侧另镜像 wx.reportPerformance，§4） |
| `run.end` | mainFlow.ts onEnd 回调（machine.go('result') 前） | `sdk.runEnd(payload)`——payload 组装见下 |
| 退出路径 | run.onExit / pagehide | `void sdk.telemetry.flush()`（pagehide 已自动，run.end 后建议手动一次） |

`run.end` payload（spec §8 规范形状）：`frames/summary/eventCounts` 来自 sim（runnerScene 的
consumeEvents 处累计 `eventLog.push([frame, ev])` 即可得 eventsSha256 = `digestEventLog(eventLog)`）；
`inputsSha256` 需要局内输入录制——S18 落地前用 `digestInputs(recordedInputs)`（S19a 格式的录制）
或空数组占位 `digestInputs([])` 并在 fields 标注；`frameDist` = `sdk.frameDist.payload(runId,'run')`
（去掉 runId/scene/cumulative 三键）；`maxUsedMB` = `sdk.maxUsedMB()`；`revives` 来自结算逻辑。
嵌套结构入信封时由 `runEndFields()` 统一 canonicalJson 成字符串（fields 只收标量，spec §2）。

### 2.4 ?debug 探针并入（spec §4.6）

- `__trRun.state/probe` 对外形状**保持不动**（调试脚本依赖）；整合会话把帧内快照的实现数据源
  切到 `th.telemetry.recent(n)`（管线级环缓冲，含全部通道被接受事件，容量 256）或
  `th.consoleSink.recent(n)`（sink 本地视图，容量 ringSize=200）。推荐前者。
- `sdk.debugProbe(fields)` = runDebugProbe 现有字段形状（r2 圆整后），config 缺省采样 0%，
  云侧回放调试时把 `sampleRates['debug.probe']` 调高即可（无需改码）。
- 埋点侧禁止再散落 console.log：`?debug` 时 Console Sink 即所有通道的 echo（`[tr.<level>] <name>`）。

## 3. 事件 → 打点位总表（spec §4 逐条）

| 事件 | 通道/级别 | 打点位（整合会话落码） |
|---|---|---|
| session.boot | log/info（豁免） | bootstrap.ts 装配后第一条（§2.1） |
| boot.phase / boot.summary | metric/timer + log/info | §2.1/§2.2/§2.3 各阶段点 |
| config.load / config.loadSummary | log/info | mainFlow.boot()（§2.2） |
| perf.frameDist | metric/histogram | runnerScene.tick + 菜单循环（§2.3） |
| perf.memory / perf.memWarn | metric/gauge + log/warn | §2.3 采样 / wx.onMemoryWarning（§4） |
| run.start / run.end | log/info | mainFlow run.onEnter / onEnd（§2.3） |
| crash.uncaught / crash.rejection | error/fatal | 已自动（createWebTelemetry 内建 capture） |
| crash.wxError | error/fatal | §4 注册文件 installWxErrorCapture |
| anticheat.reject | log/warn | S18 排行榜门禁回调（形状已备：sdk.anticheatReject） |
| debug.probe | log/trace（采样 0%） | §2.4 |
| telemetry.dropped / telemetry.flush | 自监控 | 管线内建，无需接线 |

## 4. wx 端接线 TODO 清单（S6 合入后 · 整合会话执行）

wxChannel.ts 的类已就绪且 node 直测通过（结构化注入 `WxTelemetryApi`，本包零处触碰宿主全局）。
注册 = 在 **packages/platform-wx 新增 `src/telemetry.ts`**（该包是唯一可触宿主全局的边界，R5）：

1. `import { assembleWxSinks, type WxTelemetryApi } from '@tr/telemetry/wxChannel.js'`，
   宿主 API 对象 = 全局 `wx` 本身（getRealtimeLogManager/onError/offError/onUnhandledRejection/
   offUnhandledRejection 结构满足；缺项自动降级不装）。
2. `cfg = readTelemetryConfig(params, w => console.warn(w))`——params 经 `extras.readJson`
   读分包内 config/game.json（S6 已通）；时序方案同 §2.1（A：先读配置；B：DEFAULTS 先装配）。
3. `const { sinks, installErrorCapture } = assembleWxSinks(wx, cfg.transport, cloudInvoke)`：
   - **cloudInvoke 在 S9 云环境就绪前传 `undefined`**（→ degraded sink：内存批丢弃、零噪音，
     spec §7/D10）。S9 后改传 `(name, data) => adapter.extras!.cloud.callFunction(name, data)`。
   - realtime sink 构造失败（基础库过老无 getRealtimeLogManager）→ null 自动不注册。
4. `telemetry = createTelemetry(adapter, cfg, sinks, common)`（common.tags.env='wx'、
   device = `wx.getDeviceInfo()` 摘要截断 64 字符）；随后 `installErrorCapture(telemetry)`
   （crash.wxError / crash.rejection；RealtimeLogManager.error 同步镜像由管线 mirror 自动完成，
   不用在 capture 里双写）。bootId 过滤词（setFilterMsg）经 sink.init 自动设置，无需接线。
5. onHide flush：**无需单独接**——wxPlatform 的 onVisibility 已映射 onHide，管线按
   `batch.flushOnHide` 自动订阅（spec §7「只接一次」满足）。
6. 内存三档（spec §4.3/D11）：`wx.onMemoryWarning(res => sdk.memWarn(res.level))` 在注册文件订阅；
   `wx.getPerformance()` 的 memory 条目能力**真机矩阵验证后**回填 spec §4.3 并启用
   `sdk.memory(bytes, { src: 'getPerformance' })`，验证前 web 同款 `sdk.memory(null, { src: 'unavailable' })` 每 boot 1 条。
7. `cfg.transport.mirrorOfficial=true` 时：`wx.reportPerformance(<bootTotalId>, totalMs)` 镜像
   boot.total（指标 id 需先在 MP 后台创建——接线时在注册文件顶部常量注明）。
8. T0：入口 game.js 第一行 `wx.getPerformance().now()` 存模块级变量（冷启动基准，spec §4.1），
   `createTelemetrySdk(telemetry, { now: () => adapter.now(), t0 })`。

## 5. 与 S18 / S19b 的复用导出（任务 5）

```ts
// S19b perf bench（spec §8：只 import buckets.js，纯逻辑零 DOM，node 可直测）：
import { FRAME_BUCKET_EDGES_MS, FRAME_BUCKET_COUNT, percentileFromBuckets, bucketIndexOf } from '@tr/telemetry/buckets.js';
// bench 输出记录为 scene:'bench' 的 perf.frameDist（sdk.emitFrameDist('bench', …)），与线上同表。

// S18 防作弊（云函数/CI/客户端一份实现，哈希一致是三线对齐前提）：
import { canonicalJson, sha256Hex } from '@tr/telemetry/canonical.js';       // 与 tools/replay/runner.mjs 逐字节同语义（单测对拍锁定）
import { digestEventLog, digestInputs } from '@tr/telemetry/digests.js';     // eventsSha256/inputsSha256
import { configHashFromShaList, configHashBundle } from '@tr/telemetry/digests.js'; // 可复现三元组第二元
import { runEndFields, anticheatRejectFields } from '@tr/telemetry/digests.js';
import type { RunResultSummary, RunEndPayload, AnticheatRejectPayload } from '@tr/telemetry/types.js';
```

- S18 上报体 `{ engineVersion, configHash, replay, result }`（replay-format §7）的 `result` 子结构
  = `RunResultSummary`（frames/summary/eventCounts/eventsSha256/inputsSha256），与 run.end 事件同源；
  telemetry 不携带完整重放（体积），`inputsSha256` 供快速一致性预检。
- 收口建议（整合会话）：`tools/replay/runner.mjs` 改 import `@tr/telemetry/dist/canonical.js`
  的 canonicalJson/sha256Hex，删本地副本——在此之前 `tests/telemetry-config.test.mjs` 用对拍
  用例锁定两份实现逐字节一致。

## 6. config 技术段同步清单（任务 3 收尾）

已落（本会话）：① `config/game.json` 增 `params.telemetry`（值 = spec §5 缺省逐项一致）；
② `packages/core/src/config/configValidator.ts` 增 `validateTelemetryParams`（缺省段不报错、
出现即校验类型与范围，范围 = readTelemetryConfig 钳制区间；`error.sample` 仅 0|100）。
validator 对 game 的既有「params 非空对象」检查不变（spec §5.1：新增节本不需改校验器，
本次按派发任务 3 加了严格版技术段校验，与 params.ui 的 S4 先例同款）。

**待整合会话/维护者执行（设计库 `D:\gpt-6\work\酷跑小游戏`，本机不存在该路径）**：
③ `schema/config.schema.json` 的 `game.params.telemetry` 定义（技术段标注），片段：

```json
"telemetry": {
  "type": "object",
  "x-section": "technical",
  "description": "遥测与日志框架（S16，docs/telemetry-spec.md §5）。框架侧只改本节，缺省值即推荐值。",
  "properties": {
    "enabled": { "type": "boolean", "default": true },
    "minLevel": { "enum": ["trace", "debug", "info", "warn", "error", "fatal"], "default": "info" },
    "sampleRates": {
      "type": "object", "description": "整数百分比 0..100（对齐 antiCheat.replaySampleRate 语义）；按事件名覆盖，未命中用 default",
      "properties": { "default": { "type": "integer", "minimum": 0, "maximum": 100 } },
      "additionalProperties": { "type": "integer", "minimum": 0, "maximum": 100 }
    },
    "rateLimit": {
      "type": "object",
      "properties": {
        "perNamePerMin": { "type": "integer", "minimum": 1, "default": 30 },
        "maxBytesPerMin": { "type": "integer", "minimum": 1024, "default": 65536 }
      }
    },
    "batch": {
      "type": "object",
      "properties": {
        "maxEvents": { "type": "integer", "minimum": 1, "maximum": 200, "default": 30 },
        "maxBytesPerFlush": { "type": "integer", "minimum": 1024, "maximum": 65536, "default": 16384 },
        "maxDelayMs": { "type": "integer", "minimum": 0, "default": 5000 },
        "flushOnHide": { "type": "boolean", "default": true },
        "retry": { "type": "integer", "minimum": 0, "maximum": 3, "default": 1 }
      }
    },
    "error": {
      "type": "object",
      "properties": {
        "sample": { "enum": [0, 100], "default": 100, "description": "应急总开关不半采（D4）" },
        "maxStackBytes": { "type": "integer", "minimum": 256, "default": 4096 },
        "dedupWindowMs": { "type": "integer", "minimum": 0, "default": 60000 }
      }
    },
    "memory": { "type": "object", "properties": { "sampleEveryS": { "type": "integer", "minimum": 1, "default": 10 } } },
    "transport": {
      "type": "object",
      "properties": {
        "webEndpoint": { "type": "string", "default": "", "description": "空串 = web 只 console echo 不发网络" },
        "wxRealtimeLog": { "type": "boolean", "default": true },
        "wxCloudCollection": { "type": "string", "default": "telemetry" },
        "mirrorOfficial": { "type": "boolean", "default": false }
      }
    }
  }
}
```

④ 设计库 docs/03 参数表加 `params.telemetry` 行（技术段，框架侧维护）；⑤ 里程碑合入 main 后
按 roadmap §4 发「框架变更通告」知会作者侧。

## 7. 类型契约与 spec/草案的偏差清单（验收要求项）

签名基线 = `drafts/telemetry.ts`（已迁入 `packages/telemetry/src/types.ts`）。全部偏差为**加法或
落位调整**，无破坏性改动；逐项理由如下：

| # | 偏差 | 理由 |
|---|---|---|
| 1 | `EmitOptions` 增可选 `name` | 草案 `error(err, context?, opts?)` 无事件名参数，而 spec §4.5 需要 crash.uncaught/rejection/wxError 三名分流；加法扩展，按草案签名的调用仍编译 |
| 2 | `createTelemetry` 增第 4 可选参 `common?: TelemetryCommonDimensions` | spec §2 要求管线统一注入 tags{env,quality}/fields{engineVersion,configHash,device}，草案签名无载体；设计为**可变对象、组装时读当前值**（configHash 配置加载后回填） |
| 3 | `readTelemetryConfig` 增第 2 可选参 `onWarn` | spec §5.3「钳制发生即 warn 一条」需要出口；纯逻辑包不触 console（D1），由调用方注入（web 装配面接 console.warn） |
| 4 | `createBeaconSink`/`createRealtimeLogSink` 返回 `TelemetrySink \| null` | 草案注释「endpoint 空串 = 本 sink 不注册」但签名非空；null 是「不注册」的唯一诚实表达（wx 侧同理：宿主缺 getRealtimeLogManager → null） |
| 5 | wx sink 工厂落位 `packages/telemetry/src/wxChannel.ts` 且签名带注入参数（`createRealtimeLogSink(api)`、`createCloudDbSink(collection, invoke?)`、`installWxErrorCapture(api, telemetry)`） | spec §9 原定 platform-wx；本波次 S6 并行锁定该包 → 类以结构化注入实现（`WxTelemetryApi`，零宿主全局、node 可直测），platform-wx 注册薄层留 TODO（wxChannel.ts 文件头 + 本文 §4）。纯逻辑纪律（D1）不破 |
| 6 | 桶语义定稿：桶 0 = 负值/NaN 异常哨兵；桶 1..10 = [EDGES[i-1], EDGES[i])；桶 11 = [200,∞) 溢出 | spec §4.2 边界列表字面是 11 个区间，与草案/​spec 三处钉死的 `FRAME_BUCKET_COUNT=12`、「末桶 >200ms」矛盾；取满足全部硬约束的唯一读法（定义见 buckets.ts 头注释，服务端/S19b 以此为准） |
| 7 | `TelemetrySink` 增可选 `init?(info)` | sink 构造先于管线（bootId 未知），而 wx `setFilterMsg(bootId)` 需要它；管线构造时回传 {bootId,sid} |
| 8 | error 通道信封带 `level`（crash.* = fatal，其余 = error） | spec §2 表：level 对 log/error 必填；§3.1「fatal 仅 crash 通道」；草案未定取法 |
| 9 | metric 事件的标量字段经 `withScope()` 并入 | 草案 `metric()` 无 fields 参数，而 spec §4.1-4.3 的 metric 事件都带 fields；withScope 共享父管线（草案语义），单事件不翻倍、签名不动 |
| 10 | `ConsoleTelemetrySink extends TelemetrySink` 增 `recent(n)` | ringSize 选项需要读出口；__trRun 探针建议用管线级 `telemetry.recent(n)`（含未 flush 事件） |
| 11 | `dropped{reason:'disabled'}` 在管线构造时发一次（count=0） | spec §5「仍计数一条」无触发时机定义；构造时发保证「关了有确认」；count=0 语义 = 不逐条计数 |
| 12 | seq 在全部过滤（级别/采样/限流）之后分配 | spec 未定分配时机；过滤丢弃不占号 → seq 空洞只来自 overflow/transport，断流检测语义纯净 |
| 13 | 桶内插值取中点法 `(k+0.5)/count` | spec「桶内均匀假设线性插值」未钉公式；中点法是无偏估计，∞ 桶按 400ms 封顶并置 approx（p95Approx）照 spec |
| 14 | 指纹 = `sha256Hex(ch+name+message+栈顶2帧)` 前 16 hex；去重取「在队信封就地更新 dupCount，已发出则批末快照重发 ≤1 条/窗」 | spec §3.3 说 hash 未钉算法（sha256 与 S18 线共用实现）；「二选一」spec 明许，取混合式（风暴收敛为 1 事件 + 计数） |
| 15 | degraded 云 sink 的 send 视为成功（void） | spec §7「云未就绪 → realtime-only + 内存批丢弃」：退化是预期状态而非传输失败，不应刷 dropped{transport}/重试噪音 |
| 16 | `tools/check-import-rules.mjs` 未把 packages/telemetry 并入纯逻辑禁令集 | spec §10 将该项排在 PR⑥（基建收口，依赖 ①~⑤）；tools/ 不在本派发所有权内。本包已自律零 DOM/零宿主全局（wxChannel 结构化注入），telemetry*.test.mjs 有纯逻辑断言兜底 |

## 8. 验证

- `npm run check` 全绿（编译 + 单测 + 配置校验 + 架构禁令 + wx bundle --dry）。
- 新增单测：`tests/telemetry.test.mjs`（管线矩阵：信封/seq/级别/采样稳定性/限流/字节预算/
  指纹去重/批量触发/溢出/重试/dropped 聚合/noop 与 disabled 零开销）、`tests/telemetry-buckets.test.mjs`
  （桶/百分位/收集器）、`tests/telemetry-config.test.mjs`（readTelemetryConfig 钳制 + validator +
  canonicalJson/sha256 与 runner.mjs 对拍 + S18 摘要导出）、`tests/telemetry-web.test.mjs`
  （console/beacon/capture/装配，DOM 桩注入）、`tests/telemetry-wx.test.mjs`（wx 通道类 mock 直测）。
- 手工冒烟（web）：`npm run dev` → `?debug` 控制台可见 `[tr.info] session.boot` 等 echo；
  `transport.webEndpoint` 填 URL 后 Network 面板可见 beacon POST（payload = 信封数组 canonicalJson）。
