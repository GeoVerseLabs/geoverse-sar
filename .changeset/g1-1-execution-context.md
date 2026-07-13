---
'@geoverse-sar/kernel': patch
'@geoverse-sar/skill': patch
'@geoverse-sar/agent': patch
'@geoverse-sar/workspace': patch
'@geoverse-sar/server': patch
'@geoverse-sar/otel': patch
---

阶段三 Gate 1 · G1-1：Execution Contract Freeze——runId/traceId/mode 全链贯穿。

修复外部复评 P0-2「取消、runId、traceId 没有贯穿组合调用，一个长任务无法用单一标识回答调了哪些步骤/等哪个审批」。

- **kernel**：新增 `ids.ts`（`newTraceId`/`newRunId`/`ExecutionMode`/`ExecutionIdentity`）。`InvokeOptions`/`InvokeOutcome`/`MiddlewareContext`/`CapabilityContext` 增 `traceId`（缺省生成）/`runId`（可选）/`mode`（`execute`|`preview`）。`traceId` = 一次顶层操作；**一条工作流全程共享一个 traceId，内部步骤（含以能力形式调用/嵌套）继承**——投影 handler 透传 `ctx.traceId`。身份进 `SarEvent`（invoke/workflow/dispatch 事务）、`AuditEntry`（`AuditFilter` 支持按 traceId/runId 过滤取全）、`Journal`（写路由 dispatch 事务携带；undo/redo 不带——经 dispatcher 同步写路由 ambient `getCurrentExecution()` 关联，无 async 串号）。`WorkflowRunOptions`/`WorkflowRunResult` 增 traceId/runId。`ClientInvokeOptions` + `client-remote` 透传身份。
- **skill**：`HandleToolCallOptions`/`HandleToolCallViaOptions` 增 traceId/runId 透传。
- **agent**：一次 `run()` 的全部 invoke（观察 stats / 审批预览 / 动作）共享一个 runId；`AgentRunResult.runId` 回写，审批 preview 带 runId。
- **workspace**：durable 运行的 runId 即工作流执行 runId（崩溃恢复后按 runId 重建时间线）；`PendingApproval.runId` 关联发起运行。
- **server**：invoke 请求体透传 traceId/runId 并回写（caller 仍只由 token 注入——身份关联位 ≠ 权限位）。
- **otel**：invoke span 上 `sar.trace_id`/`sar.run_id`/`sar.mode`；workflow span 带 traceId/runId。

新增契约测试：kernel `execution-context.test.ts`（6 测：原子身份/显式回写+审计过滤/工作流全程一 trace/以能力形式继承/事件与日志关联/journal dispatch 带身份 undo 不带）+ server 身份透传用例。全仓 305 测四门禁全绿。
