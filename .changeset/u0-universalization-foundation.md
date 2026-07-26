---
'@geoverse-sar/kernel': patch
'@geoverse-sar/geo-profile': patch
'@geoverse-sar/capabilities-geo': patch
'@geoverse-sar/engine-memory': patch
'@geoverse-sar/engine-geo': patch
'@geoverse-sar/planner': patch
---

阶段四 U0「规范与地基」：

- kernel：能力生命周期元数据 `since/deprecated/replacedBy`（additive）+ doctor 弃用与 effects 非法组合体检；ctx.state 换惰性只读视图（单实体读走引擎精读端口 `getEntity` 零快照、枚举首次触达才物化、实体浅冻结变异防护）；`StateEngine` 增可选 `getEntity/entityCount`；`catalog.search` 目录检索元能力（内建 `runtime.catalog` 服务，权限裁剪与 invoke 同判定）。
- 新包 `@geoverse-sar/geo-profile`：能力层共享 geo schema 底座（position/bbox/geometry/feature/featureRef/featureSummary/crsRef/quantity + bbox 纯工具 + `distanceSchema`/`resolveQuantity` 单位归一）；叶子包只依赖 zod；与 EditableFeature 同构不互引（类型级断言钉死）。
- capabilities-geo：共享原语 schema 收敛到 geo-profile（迁移前后 toToolSpecs JSON Schema 快照逐字节一致）；buffer/offset 距离入参接 Quantity（union 过渡；`createGeoPack({ localUnit })` 声明工作区单位，换算不靠猜）。
- engine-memory/engine-geo：实现精读端口（单实体安全副本；memory 版另有 O(1) 计数）。
- planner：`CatalogSelector` 端口 + `createHeuristicSelector`（goal→top-k 收窄，runtime 元能力钉住=分层披露，异常回退全量）。
- 文档：capabilities.md 重写为约束规范 v1（effects 四维语义/四问决策树/非法组合表/Schema 规范/版本弃用）；README 状态改四档口径。
