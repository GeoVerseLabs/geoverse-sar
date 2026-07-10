---
'@geoverse-sar/kernel': patch
'@geoverse-sar/skill': patch
'@geoverse-sar/planner': patch
'@geoverse-sar/agent': patch
'@geoverse-sar/workspace': patch
---

SarClient 远程化切面（阶段二 T12，目标架构 R5+R6；**planner/agent 入参 breaking，趁未发布做对**）：

- **kernel（R5）**：`SarClient` 接口（catalog 异步 + invoke + onEvent 的可序列化最小子集）+ `clientOf(kernel, caller)` 本地实现——caller 构造绑定（目录裁剪与 invoke 强制同一身份，方法参数无处伪造）；`explainError`/`suggestCapabilityIds` 支持目录数组作相似建议来源（client 侧无 registry）。
- **skill**：`toToolSpecsOf(descriptors)` 纯投影 + `handleToolCallVia(client, name, args, { catalog })` client 版回灌（工具名消歧与失败 hint 走目录数组），与 kernel 版逐字节平价（平价测试钉死）。
- **planner（R6，breaking）**：`createPlanner(sarClient, options)`——目录经 `client.catalog()` 异步获取（每 run 重取）、回灌走 handleToolCallVia 并透传 signal；`toolSpecs` 选项改为 `catalogFilter`（caller 不可再指定）。
- **agent（R6，breaking）**：`createAgent(sarClient, options)` / `createLlmPolicy(sarClient, options)`——`caller` 选项移除（构造绑定）；审批门 kind 判定与观察目录同源自 catalog；`AgentObservation.entityCount` 改可选（未注册 runtimePack 时缺席，切面下无 engine 可回退戳探）。
- **workspace**：`ws.client`（`clientCaller` 选项，默认 `{ entry: 'program' }`）——入口层应依赖它。
