---
'@geoverse-sar/kernel': patch
'@geoverse-sar/agent': patch
'@geoverse-sar/capabilities-geo': patch
---

阶段四 U4「观察与执行通用化」：

- agent：`ObservationProvider` 可注册列表（独立观察段 + token 预算确定性截断 + 失败缺席不掀翻循环；与 enrichObservation 并存）。
- capabilities-geo：`createSpatialSummaryProvider`（provider 形态）+ `spatial.summary` 分层摘要下钻能力（概览→下钻某格→命名集句柄喂 target）；`view.capture` 视口截图能力（GeoViewService.capture 可选端口；多模态接线待 Provider content-parts）。
- kernel：Job 模型（`JobManager` 内建服务 `runtime.jobs` + `jobs.list/status/cancel` 能力 + `job:progress` 事件帧；**回漏斗纪律结构化**——manager 不持引擎引用，作业落地必经 invoke）；`createCompositeEngine` 多图层单撤销时间线（tagged-union CompositeDiff + 逐分量代数 + 层视图投影——kernel 端口零改动，跨图层 macro workflow undoDepth 恰 +1、dryRun 投影自动成立；子引擎闭包私有）。
