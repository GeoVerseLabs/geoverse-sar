# SAR 指南（仓内文档）

> 读者视角的使用文档（D0/D1 层，Markdown 先行；VitePress 站按 `../../docs/SAR_DOCS_PLAN.md` 后续升级）。设计决策原文见共享 vault 的 RFC-0008 与 ADR-0010~0013。

| 篇                                   | 内容                                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| [concepts.md](./concepts.md)         | 全景：端口-适配器、三原语、单一漏斗、宏撤销、客人式生命周期                      |
| [capabilities.md](./capabilities.md) | 写一个能力包：schema、kind 三态、description 怎么写、requires 服务声明           |
| [workflows.md](./workflows.md)       | 工作流：步间数据流、条件步、宏撤销语义与折叠矩阵                                 |
| [entries.md](./entries.md)           | 四个入口：程序化 / UI 面板 / AI（LLM tool-use，含密钥代理模式）/ MCP             |
| [planner.md](./planner.md)           | NL→能力路由 planner（M3）：LlmClient 端口、流式进度事件、无头聊天控制器          |
| [agent.md](./agent.md)               | 自治 Agent 与治理（M4）：observe→plan→act、权限/审批门/审计/中止、事务日志回放   |
| [engines.md](./engines.md)           | 接入自有引擎：`StateEngine` + `DiffAlgebra` 契约清单与测试模板                   |
| [persistence.md](./persistence.md)   | 持久化：SarStore 存储端口（追加流+快照）、memory/idb/file 三适配器、崩溃一致性   |
| [remote.md](./remote.md)             | 远程模式（T13/R7）：server 薄层、createRemoteClient、token→caller、本地/远程平价 |
| [doctor.md](./doctor.md)             | 自检与错误分析：runDoctor、ErrorMonitor、explainError、错误码表                  |

各包 README：[kernel](../packages/kernel/README.md) · [workspace](../packages/workspace/README.md) · [server](../packages/server/README.md) · [engine-memory](../packages/engine-memory/README.md) · [engine-geo](../packages/engine-geo/README.md) · [capabilities-records](../packages/capabilities-records/README.md) · [capabilities-geo](../packages/capabilities-geo/README.md) · [skill](../packages/skill/README.md) · [planner](../packages/planner/README.md) · [agent](../packages/agent/README.md) · [mcp](../packages/mcp/README.md)

可运行示例：`pnpm playground:dev`（`/index.html` 两面板 · `/chat.html` 真实 LLM · `/geo.html` 真地图 · `/agent.html` 自治 Agent · `/remote.html` 远程模式，配 `pnpm playground:server`）。
