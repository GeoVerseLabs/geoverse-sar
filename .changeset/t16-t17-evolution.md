---
'@geoverse-sar/evolution': patch
---

新包：自进化起步（RFC-0009 T16+T17）。**L2 workflow 合成闭环**：`mineSequences`（audit 按 caller 分轨挖高频能力 n-gram，只看 id 序列、排除 history/runtime/workflow 前缀与失败调用）→ `draftWorkflow`（DraftLlm 端口起草纯 JSON 草稿，zod 严格校验）→ `validateDraft`（静态引用检查 + 逐步 dryRun 干跑）→ 审批 → `createSynthesis.enable`（compileDraft 编译注册，undo 固定 macro、tags 带 synthesized）+ provenance 落 `synthesized-workflows` 流；缺省停 pending 不进目录；`loadSynthesizedWorkflows` 重启装载。模板语言只有取值引用（`$input.x` / `$steps.id.x` / `*` 数组投影 / `$$` 转义），不图灵完备。**知识端口**：`createKnowledgePack`（kb.search read 能力，requires 'kb' 服务）+ `createMemoryKb`（零依赖关键词计分参考实现）+ `createKbEnricher`（agent 观察增强，goal 命中注入 extra.kb）。**能力摄取原型（dev-time）**：`ingestCapability`（API 签名→Zod schema→description→能力文件+测试骨架源码串，LLM 仅润色描述）。
