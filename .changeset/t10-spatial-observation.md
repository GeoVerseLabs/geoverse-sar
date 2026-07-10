---
'@geoverse-sar/agent': patch
'@geoverse-sar/capabilities-geo': patch
---

空间观察增强（阶段二 T10，ROADMAP P0-3）：agent 新增 `enrichObservation` 钩子（AgentObservation 增 `extra` 扩展位；钩子异常按 policy_error 收敛，observe 事件携带增强后观察）；capabilities-geo 新增 `createSpatialObserver`（零依赖 grid-binning 摘要：bbox/几何类型分布/密度格子 + token 白名单裁剪（maxCells/maxPropValues），可选经 GeoViewService 新增的 `getViewport?()` 携带视野；不依赖 agent 包，结构兼容其 ObservationEnricher）。
