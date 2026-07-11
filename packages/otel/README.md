# @geoverse-sar/otel

SAR 的 OpenTelemetry 导出器（RFC-0009 F4，可选包）。只依赖 `@opentelemetry/api`（peer）——provider/exporter 宿主自带（BYO SDK），本包零厂商绑定。

```ts
import { createOtelMiddleware, bridgeEventsToOtel } from '@geoverse-sar/otel';

const kernel = createKernel({
  // invoke → span：中间件包裹整个漏斗，审计维度全上属性
  middleware: [createOtelMiddleware(tracer, { attributes: { 'sar.ws': 'proj-1' } })],
});
const off = bridgeEventsToOtel(kernel.events, tracer); // workflow/事务 → span
```

- **`createOtelMiddleware(tracer)`**：每次 invoke 一个 span（`sar.invoke <capabilityId>`）——capability/kind/entry/callerId/dryRun/ok/errorCode/durationMs/hasDiff 全上属性，能力失败置 ERROR 状态。中间件形态包裹整个漏斗，天然精确关联（无事件配对问题）。
- **`bridgeEventsToOtel(events, tracer)`**：`workflow:start/end` 成对开合 span、`engine:transaction` 记零时长 span（origin=dispatch/undo/redo + label——撤销/重做也进 trace）。返回解绑函数。
- 与审计的分工：audit 是**取证面**（全量入账、JSON 往返、落 store）；OTel 是**观测面**（采样、分布式关联、接现有 APM）。两者同挂互不影响。
