---
'@geoverse-sar/kernel': patch
---

内建 runtime 能力包（目标架构 R3）：`createRuntimePack()` 提供 `runtime.stats`（read：实体数/撤销重做栈深/canUndo/canRedo——观察面从对象戳探升格为能力，远程入口与 agent 观察面切换的前置）与 `runtime.checkpoint`（action，`requires` CHECKPOINT_SERVICE_KEY，T4 openWorkspace 注入实现）；`StateEngine` 端口新增可选 `undoDepth`/`redoDepth` 只读属性（engine-memory/engine-geo 已有）。
