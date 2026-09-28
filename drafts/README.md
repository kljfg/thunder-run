# drafts/ —— 契约草案的去向

| 草案 | 状态 |
|---|---|
| `platform-adapter-v2.ts`（S10） | **已定稿移入 `packages/platform/src/`**（S3）：接口拆为 canvas.ts / input.ts / extras.ts / platformAdapter.ts（含再导出 barrel），共享手势内核实现在 gestureClassifier.ts。规格文档仍为 `docs/platform-adapter-v2.md`。 |
| `telemetry.ts`（S16a） | **已定稿移入 `packages/telemetry/src/`**（S16b）：类型契约在 types.ts，实现在 canonical/buckets/frameDist/config/errorSerialize/limiter/pipeline/noop/digests/sdk/wxChannel.ts，barrel 在 index.ts。规格文档仍为 `docs/telemetry-spec.md`。 |
