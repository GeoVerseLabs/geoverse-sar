---
'@geoverse-sar/kernel': patch
'@geoverse-sar/mcp': patch
'@geoverse-sar/planner': patch
'@geoverse-sar/conformance': patch
---

阶段四 U5「生态与规模化」（RFC-0012，收官）：

- conformance：新包——能力包认证套件 `runConformance`（纯函数报告）+ `createCapabilityPackTestSuite`（vitest hooks 注入）8 项检查：doctor 委托 / schema 派生往返 / description lint / dryRun 纯性 / 写能力 invert∘apply 可逆性（fast-check）/ effects 声明一致性探针 / 非法组合 / outputSchema 履约；仓内两能力包自证 + 故意坏包判红。
- mcp：MCP-in 桥 `createMcpCapabilityPack`——外部 MCP server 的 tools 挂载为能力包（`mcp.<ns>.<tool>`），外部 schema 经描述符覆写位直挂不反推 Zod，effects 保守缺省（external:'write'+approval:'policy'）按工具显式降级；外来工具与本地能力同帧序、同权限判定、同审计归因。
- kernel：`inputJsonSchemaOverride`/`outputJsonSchemaOverride` 描述符覆写位（**仅桥用**，常规能力 Zod 派生仍是唯一事实源）；`capabilitiesFromManifest` 声明式清单能力——只读 HTTP 零代码接入（载入即校验、只有取值引用不图灵完备、外访必经注入的 `runtime.fetch` 服务、effects 固定只读）；`PackPromptProfile` 数据类型 + `CapabilityPack.promptProfile`（内核只携带不解释）。
- planner：prompt profile 构造期拼装（`profiles` 选项，不复述目录/schema、usageNotes≤800 字、few-shot≤3 条超限即抛，不传时 system 逐字节不变）；`createKbSelector` kb 检索版目录选择器（结构镜像 kb 端口、输出恒为裁剪后目录子集、runtime 恒钉住、召回不足按目录序补齐）+ `catalogKbDocs` 摄取投影。
