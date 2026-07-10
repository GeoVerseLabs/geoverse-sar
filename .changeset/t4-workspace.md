---
'@geoverse-sar/workspace': patch
---

新包：`openWorkspace` 工作区生命周期（目标架构 R4）——组装 kernel + SarStore + 录制/恢复（实体快照 seed 重建引擎 + journal tail 重放，seq 连续性/格式版本/引擎类型校验）+ checkpoint（先写快照与 meta 再截断；撤销地平线=checkpoint，明示不承诺重启撤销更早历史；自动 everyTx 默认 200）+ Web Locks 单写者（双开后来者只读，写/action 拒绝）+ conversations 快照 + close（flush→checkpoint→释放锁→dispose→关 store）；`runtime.checkpoint` 能力经服务注入自动接线。
