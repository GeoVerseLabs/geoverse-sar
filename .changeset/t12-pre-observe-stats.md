---
'@geoverse-sar/agent': patch
---

agent 观察面去 engine 对象戳探（阶段二 T12-pre，R6 先行小步）：observe 在宿主注册 `createRuntimePack()` 时优先经 `invoke('runtime.stats')` 取实体数与撤销栈深——同一漏斗（可审计、权限一致、可远程化），并透传 AbortSignal；未注册或调用失败回退进程内对象戳探（耦合仅保留在回退路径）。消除 runtime 工程唯一的进程内对象耦合点。
