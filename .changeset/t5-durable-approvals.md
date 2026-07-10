---
'@geoverse-sar/kernel': patch
'@geoverse-sar/workspace': patch
---

durable workflow run + 审批持久化（RFC-0009 F1+F2）：kernel `WorkflowRegistry.run` 新增 `onStep`（每步落定回调，await 后才进下一步）与 `resume`（stepId→output 跳已完成步；macro 原子单元带 resume 直接拒绝）；workspace 新增 `createDurableRunner`（进度逐步落 store、崩溃后 per-step 跳步续跑 / macro 整体重跑、pendingRuns 崩溃遗留枚举）与 `createApprovalGate`（审批请求先落 store 再等决策，进程内 deferred 放行、重启后遗留可读出决策——continuation=宿主凭记录重新 invoke；可直接挂 agent approve）。
