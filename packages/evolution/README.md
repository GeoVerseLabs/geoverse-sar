# @geoverse-sar/evolution

SAR 自进化起步（RFC-0009）：**进化数据，不进化代码**。本包产出的一切都是数据——workflow 草稿（纯 JSON）、调优建议、代码骨架文本——生效永远经过校验/审批/人审。

## L2：workflow 合成闭环（T16）

轨迹挖掘 → LLM 起草 → 机器验证 → 审批 → 注册 + provenance 落流：

```ts
import { createSynthesis, loadSynthesizedWorkflows } from '@geoverse-sar/evolution';

const synthesis = createSynthesis({ kernel, llm, store }); // llm: DraftLlm 端口（单测脚本化）
const records = await synthesis.run(audit.entries(), {
  approve: async (r) => confirmWithHuman(r), // 缺省不审批——一律停在 pending
});

// 重启装载：enabled 的合成 workflow 编译注册回目录
await loadSynthesizedWorkflows(kernel, store);
```

为什么这是"甜点"而非风险：草稿只能组合**已注册已校验**的能力；注册后仍走单漏斗（权限/审计/dryRun 全生效）；`undo: 'macro'` 兜住爆炸半径；默认 `pending` 不进目录；每条产物带 provenance（挖掘序列/次数/时间/创建者）落 `synthesized-workflows` 流可追溯。

- `mineSequences(auditEntries)`：按 caller 分轨提取连续成功调用的高频 n-gram（只看能力 id 序列——`captureInput:false` 下同样可用）；`history.*`/`runtime.*`/`workflow.*` 与失败调用不入序列。
- 草稿 input 模板：`"$input.字段"` / `"$steps.步骤id.字段"` / 路径段 `"*"` 数组投影（`$steps.find.records.*.id`）/ `"$$"` 转义。
- `validateDraft(kernel, draft)`：静态引用检查（步 id 唯一、只引用更早步、$input 字段已声明）+ **逐步 dryRun 干跑**（read 步产真输出供后步引用、写步证明 schema/权限走得通）。

## L1：调优报告（T15，执行器在 kernel）

`createTuningReport({ audit, monitor, catalog })`（`@geoverse-sar/kernel` 导出）：ErrorMonitor + audit → schema/description/usage 三类修订**建议** + 成功轨迹 few-shot 素材。确定性零 LLM，报告可复现可 diff；修订由人执行后过正常门禁。

## 知识端口（T17，runtime RAG）

```ts
import {
  createKnowledgePack,
  createMemoryKb,
  createKbEnricher,
  KB_SERVICE_KEY,
} from '@geoverse-sar/evolution';

const kernel = createKernel({
  packs: [createKnowledgePack()], // kb.search（read，requires 'kb'）
  services: { [KB_SERVICE_KEY]: createMemoryKb(docs) }, // 端口：生产可换向量检索
});
const agent = createAgent(sar, { enrichObservation: createKbEnricher(kb) }); // goal 命中注入 extra.kb
```

## 能力摄取原型（T17，dev-time）

`ingestCapability(signature, { idPrefix, llm? })`：API 签名 → Zod schema →「何时该调」description（LLM 仅润色）→ 能力文件 + 测试骨架源码串。产物经 doctor 体检 + 人审 + commit 进仓——SAR 只消费注册结果，**不做运行时热代码**（L3 红线）。签名提取（ts-morph 扫 `@sar-capability` 注解）是预期前端，本原型钉死「类型→schema→描述→产物」的确定性映射。

指南：[自进化](../../docs/evolution.md) · RFC-0009（共享 vault）
