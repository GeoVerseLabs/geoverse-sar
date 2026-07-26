---
'@geoverse-sar/kernel': patch
'@geoverse-sar/mcp': patch
'@geoverse-sar/geo-profile': patch
'@geoverse-sar/engine-geo': patch
'@geoverse-sar/capabilities-geo': patch
---

阶段四 U3「数据面与 geoverse 收编」（RFC-0010）：

- kernel：`ResourcePort{list,query}` 第二内核端口（只读世界不进撤销时间线；geo 语义经 meta/ext 剖面，kernel 零 geo 词汇）+ `createMemoryResourcePort` 参考实现 + 提供端口才注入 `runtime.resources` 服务；`NamedSetService`（`runtime.sets` 恒注入）——read 句柄化与 target 寻址的底座。
- mcp：`resources/list`/`resources/read` 投影 ResourcePort（uri `sar://resource/<id>`，read 首页有界 + hasMore）。
- engine-geo：`createSyncBridge` 收编 editor-core `sync/` 栈（SyncClient 乐观锁/409 三路合并——桥只搬运，合并语义零自研）+ regionSelect/shapes/HistoryStore 桥再导出。
- capabilities-geo：`source.list/checkout/commit`（checkout 可撤销+溯源+500 上限防呆；commit `effects{irreversible, external:write, approval:always, keyed}` 结构化上抛 CommitOutcome 与三路合并明细）；`features.query` 回包句柄化 `{setId,count,sample,hasMore}`；六写能力 + view.focus 接 target 三选一寻址（**平价不变量：target:{setId} ≡ 显式 id 列表，diff 逐字节相同**）；指代解析族 view.bbox/selection.get/region.select/view.snapGuide；features.drawRect/drawCircle；history.list/rollback（回滚=普通可逆编辑）。
