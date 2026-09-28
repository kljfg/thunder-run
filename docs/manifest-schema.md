# 配置热更新 manifest schema（S14 原型 → S8 实施依据）

> 状态：原型定稿（feat/s14-manifest）。参考实现：`tools/publish-content.mjs`（生成/发布/降级链语义）；
> 单测：`tests/manifest.test.mjs`。S8 接 CDN/云存储时以本文档 + 参考实现语义为准，**不要**另起一套键名。
> 对应设计：docs/wx-minigame-redesign.md §3.5（T2.5 升级为 CDN + wx.downloadFile，M8 落地）。
> 提醒：`config/*.json` 数值改动需与 docs 库（`D:\gpt-6\work\酷跑小游戏`）双向同步，发布工具只读不改配置。

## 1. manifest.json 结构（schemaVersion = 1）

```json
{
  "schemaVersion": 1,
  "contentVersion": 3,
  "minClient": "0.0.0",
  "baseUrl": "https://cdn.example.com/thunder-run/content/",
  "files": {
    "game": {
      "sha256": "9f86d081884c7d65…（64 位十六进制全文）",
      "size": 1234,
      "url": "https://cdn.example.com/thunder-run/content/game.9f86d081884c.json"
    }
  }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `schemaVersion` | int | 本 schema 的版本，当前 1。客户端遇到大于自身支持的版本 → 整份 manifest 视为不可用，直接走降级（不按字段猜测兼容）。 |
| `contentVersion` | int | 内容版本号，**仅在 files 集合实际变化时 +1**；内容不变重复发布保持原值。用于埋点/日志与「是否有新内容」的粗判断，细粒度以每文件 sha256 为准。版本状态存于上次发布的 `out/manifest.json`（S8 上线后应持久化到 CI 工件或云端，防止本地 out/ 丢失导致版本回退）。 |
| `minClient` | string | 点分数字版本（如 `1.4.0`）。客户端版本 < minClient → 整份新 manifest 不可用，走缓存/包内兜底（防止旧客户端读到不认识的配置结构）。比较规则：逐段转数字，缺段按 0。 |
| `baseUrl` | string | files[].url 的公共前缀，本地模拟为 `./`。 |
| `files` | map | 键 = 配置名（CONTENT_NAMES：game/characters/skills/items/obstacles/themes/events/economy），按名称字典序排列。 |
| `files.<name>.sha256` | string | 文件**原始字节**的 sha256（hex 小写）。完整性校验 + 缓存键组成部分。 |
| `files.<name>.size` | int | 字节数，用于下载前预判与埋点。 |
| `files.<name>.url` | string | 完整或相对 URL，指向内容寻址文件名。 |

**确定性约定**（有单测锁定）：manifest 不含时间戳；files 按名称排序；2 空格缩进 + 末尾换行 → 同一份 config 两次生成**字节一致**。生成侧禁止引入任何随机/时间因素。

## 2. CDN 目录布局（内容寻址）

```
out/                      # 本地目录模拟 CDN；S8 原样上传到云存储
├── manifest.json         # 唯一可变文件：CDN 缓存必须短（≤5min）或每次回源
├── game.9f86d081884c.json      # <name>.<sha256 前 12 位>.json
├── characters.a1b2c3d4e5f6.json
└── …
```

- 内容文件名含哈希前缀 → **不可变**，CDN 可设永久缓存；改配置 = 出新文件名，天然免缓存击穿与半更新。
- 微信侧用 `wx.downloadFile` 拉取，落 `wx.getFileSystemManager` 用户目录；web 调试壳直接 fetch。
- 上传顺序约定（S8）：**先传内容文件，后传 manifest.json**，保证 manifest 引用的 URL 必已可达。

## 3. 缓存键规范（兼容现有 `thunderrun:config:` 前缀）

| 代 | 键 | 值 | 说明 |
|---|---|---|---|
| v0（现网） | `thunderrun:config:<name>` | 配置 JSON 字符串 | 现 `configLoader.ts` 写入的键。**保留只读**，作为降级链第 3 级；不再新写。 |
| v1 | `thunderrun:config:v1:manifest` | 上次成功使用的 manifest JSON | manifest 拉取失败时的本地副本。 |
| v1 | `thunderrun:config:v1:<name>:<sha256 前 12 位>` | 该哈希版本的配置 JSON | 内容寻址缓存：键含哈希 → 命中即免校验、免清理旧值（自然失效）。 |

演进方案：
1. v1 前缀是 v0 前缀的超集字符串（`thunderrun:config:v1:…`），任何按前缀清理/遍历的逻辑不冲突。
2. 客户端升级后**不做主动迁移**：v0 旧值继续当兜底数据用；一旦网络链成功，数据落在 v1 键，v0 键自然过期。
3. S8 可选优化：v1 写入成功后删除对应 v0 键（`cacheDelete`），减小 storage 占用（wx 单键/总量有限额）。
4. 存储容量告警时按「v0 先删、v1 按 contentVersion 旧者优先」清理，manifest 键最后删。

## 4. 客户端拉取降级链（manifest → CDN 新哈希 → 包内兜底）

参考实现：`tools/publish-content.mjs` 的 `resolveConfigFile(name, deps)`（纯函数、依赖注入、可单测；S8 将其语义移植进 configLoader v2）。`FileSource` 在现有 `'network'|'cache'|'failed'` 上**新增 `'bundle'`**（包内兜底命中），UI 展示「配置从哪来」时区分。

逐级流程（单文件粒度，每个文件独立降级）：

1. **拉 manifest**：CDN `manifest.json`（请求带 `?v=<contentVersion 或随机数>` 防缓存）。失败或 `minClient` 不满足 → 读 `v1:manifest` 缓存副本。
2. **解析该文件条目**：manifest（任一来源）中无此文件条目 → 跳到第 4 级。
3. **哈希缓存**：查 `v1:<name>:<hash12>` → 命中且过 schema 校验 → 用之（source=`cache`）。未命中 → `wx.downloadFile`/fetch 拉 `entry.url` → **sha256 全文校验** → schema 校验（复用 `validateFile`）→ 通过则写 v1 缓存 + 写回 manifest 缓存（source=`network`）。
4. **v0 旧缓存**：查 `thunderrun:config:<name>` → 过校验 → 用之（source=`cache`）。
5. **包内兜底**：wx 分包内置 / web `./config/<name>.json`（构建时随包携带的发布快照）→ 过校验 → 用之（source=`bundle`）。
6. 全部失败 → source=`failed`，该文件计入 `LoadReport.errors`（沿用现语义：任一文件 failed → `ok=false`）。

**铁律（沿袭现 configLoader）**：任何来源的数据都必须先过 `validateFile`/`validateRefs`，坏数据宁可不落地、不写缓存。

### 失败策略表

| # | 场景 | 动作 | 最终 source |
|---|---|---|---|
| F1 | manifest 网络失败 | 用 `v1:manifest` 缓存副本继续 | cache / bundle（视后续级） |
| F2 | manifest 拿到但 `minClient` > 客户端版本 | 整份视为不可用，等同 F1 | cache / bundle |
| F3 | manifest 与缓存副本均无 | 直接跳 v0 旧缓存 → 包内兜底 | cache / bundle |
| F4 | `schemaVersion` 大于客户端支持 | 同 F2（不猜测兼容） | cache / bundle |
| F5 | 哈希缓存命中但 schema 校验失败 | 视为未命中（可能存储损坏），继续下载 | network / … |
| F6 | 下载成功但 sha256 不匹配 | **丢弃且不写缓存**（CDN 污染/半更新），降级 v0 → 包内 | cache / bundle |
| F7 | 下载+校验成功但 schema 校验失败 | 丢弃、不写缓存、埋点上报（发布侧事故），降级 | cache / bundle |
| F8 | v0 旧缓存校验失败 | 继续包内兜底 | bundle / failed |
| F9 | 包内兜底缺失或校验失败 | failed，计入 errors | failed |
| F10 | 全部文件 failed | `ok=false`，UI 走现有失败路径（重试/提示） | — |

## 5. 给 S8 的接口预留点

| 预留点 | 位置 | S8 要做的事 |
|---|---|---|
| `uploadFiles(outDir, manifest)` | tools/publish-content.mjs | 替换函数体为云存储上传（微信云开发存储起步）；保持入参与「失败必须 reject」约定，CLI 退出码 3 = 上传失败/未实装。 |
| `resolveConfigFile(name, deps)` | 同上 | 语义移植进 `packages/core` configLoader v2（deps 即 ConfigHost 扩展：+`fetchText`/`bundleGet`/`clientVersion`）；`FileSource` 增 `'bundle'`。 |
| `--base-url` | CLI | 换成真实 CDN 域名；manifest.json 设短缓存，内容文件设永久缓存。 |
| `contentVersion` 状态 | out/manifest.json | 迁到持久化存储（CI 工件/云端），避免本地 out/ 丢失导致版本回退。 |
| 包内兜底快照 | apps/wx 构建（S6） | 分包内置 config 必须是**某次发布的产物**（建议构建时直接拷 out/ 内容文件），保证兜底数据过得了校验。 |
| 资产扩展 | files map | 当前仅 config/*.json；角色模型/贴图等资产热更沿用同一 manifest（新增条目即可），schema 不变。 |
