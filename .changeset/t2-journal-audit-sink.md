---
'@geoverse-sar/kernel': patch
---

journal/audit 流化（目标架构 R2）：`createJournal`/`createAuditLog` 新增 `sink: { store, stream?, onError? }` 选项——每录一条即 append 进 SarStore（双写：内存查询面照旧，store 为持久化取证面；串行保序、写失败吞错不断 invoke 主流程），并新增 `flush()` 等待落定。playground geo 页接入 idbStore 裸恢复（启动 read+replay，S1「刷新不丢」）。
