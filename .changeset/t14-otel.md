---
'@geoverse-sar/otel': patch
---

新包：OpenTelemetry 导出器（RFC-0009 F4，可选）。`createOtelMiddleware(tracer)`——中间件形态给每次 invoke 开 span（包裹整个漏斗天然精确关联；capability/kind/entry/callerId/dryRun/ok/errorCode/durationMs/hasDiff 全上属性，能力失败置 ERROR 状态）+ `bridgeEventsToOtel(events, tracer)`——workflow:start/end 成对开合、engine:transaction 零时长 span（undo/redo 也进 trace）。只依赖 `@opentelemetry/api`（peer），provider/exporter 宿主自带。与 audit 分工：audit=取证面（全量落 store）、OTel=观测面（采样接 APM）。
