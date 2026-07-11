---
'@geoverse-sar/planner': patch
---

会话恢复入参（T6b，目标架构 §3.5）：`createPlanner(sar, { history })` 用 workspace conversations 快照恢复模型上下文（PlannerMessage 本就是 JSON 中立格式，快照即历史；种子被拷贝不持有外部数组）+ `createChatController(planner, { items })` 恢复时间线展示面（残留 `streaming` 位清零）。两份快照配对存取，playground `/chat.html` 为样板。
