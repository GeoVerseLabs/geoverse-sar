---
'@geoverse-sar/kernel': patch
'@geoverse-sar/skill': patch
'@geoverse-sar/agent': patch
---

M4 自治 Agent + 治理：kernel 新增 AbortSignal 贯穿（InvokeOptions.signal，handler 前+写路由前双检查，错误码 aborted）、createAuditLog 审计中间件（每次 invoke 按 entry/callerId 归因入账，JSON 往返）、createJournal/replayJournal 事务日志持久化/回放（录 dispatch/undo/redo，同 seed 重放出相同终态与撤销粒度）；skill handleToolCall 透传 signal；新包 @geoverse-sar/agent：observe→plan→act 循环 + AgentPolicy 端口 + createLlmPolicy + 审批门（写动作 dryRun diff 预览过 approve）。
