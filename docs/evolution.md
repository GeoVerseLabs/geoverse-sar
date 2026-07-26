# 自进化起步：L1 调优 / L2 workflow 合成 / 知识端口（RFC-0009）

> 红线：**进化数据，不进化代码**。runtime 用运行数据改善"对能力的使用"（L1）与"能力的编排"（L2）；生成新 handler 代码只允许 dev-time 形态（人审进仓），内核永不自改（L3/L4 边界）。

## L1：调优报告（kernel `createTuningReport`）

传感器早已建成（ErrorMonitor / audit / explainError），T15 补上执行器——**离线、确定性、零 LLM** 的报告生成：

```ts
import { createTuningReport, formatTuningReport } from '@geoverse-sar/kernel';

const report = createTuningReport({
  audit: audit.entries(), // 全量轨迹（few-shot 素材 + 失败率统计）
  monitor: monitor.report(), // 失败聚合（参数路径 / 错误码 / 幻觉名单）
  catalog: kernel.describeAll(),
});
console.log(formatTuningReport(report));
```

三类建议（都带 evidence 供人核对）：

| kind          | 触发模式                                      | 修订动作（人执行）                                 |
| ------------- | --------------------------------------------- | -------------------------------------------------- |
| `schema`      | 同一参数路径反复 `validation_failed`          | 补 `.describe()` 取值约定 / 放宽 schema            |
| `description` | `capability_not_found` 高频（模型幻觉工具名） | 在被误指向的能力 description 补"何时该调/别名提示" |
| `usage`       | 某能力失败率异常（样本 ≥5）                   | 按错误码分布定位（schema/权限/实现）               |

`fewShot` 是 audit 成功轨迹里的真实入参样本——宿主可注入 system prompt 做示例（`captureInput:false` 时自动缺席）。

## L2：workflow 合成闭环（`@geoverse-sar/evolution`）

RFC-0009 规范流程的完整实现：

```
audit 轨迹 ──mineSequences──▶ 高频序列 ──draftWorkflow(LLM)──▶ 草稿(纯 JSON)
   ──validateDraft──▶ 静态引用检查 + 逐步 dryRun 干跑
   ──approve?──▶ enable: workflows.register + 目录即刻投影
   （全程产物带 provenance 落 synthesized-workflows 流；缺省停在 pending 不进目录）
```

```ts
const synthesis = createSynthesis({ kernel, llm, store });
const records = await synthesis.run(audit.entries(), { approve: askHuman });
// 重启：
await loadSynthesizedWorkflows(kernel, store); // 只装 enabled，同 id 最新状态为准
```

结构性安全边界（为什么敢让 runtime 自己攒工作流）：

1. 草稿是**声明式数据**——只能组合已注册已校验的能力，模板语言只有取值引用（`$input.x` / `$steps.id.x` / `*` 投影 / `$$` 转义），不图灵完备；
2. 注册后仍走**单漏斗**——权限裁剪、审计归因、dryRun 预览对合成 workflow 一视同仁；
3. `undo: 'macro'`——一次调用一个撤销单元，爆炸半径兜住；
4. 隐私面：挖掘只看能力 id 序列，`captureInput: false` 下同样可用。

### enable 准入门（阶段四 U2，RFC-0011）

approve 通过 ≠ 可以 enable：**enable 的前置是评测集全绿**——用 `@geoverse-sar/eval` 的 `runScenarios` 在含该合成物的**沙箱 kernel** 上跑域 scenario 集，任一失败停在 pending。evolution 与 eval 互不依赖，准入是组装根的纪律：

```ts
import { runScenarios } from '@geoverse-sar/eval';

const gate = await runScenarios(admissionScenarios(record.draft)); // 沙箱装配见 eval 文档
if (gate.ok) await synthesis.enable(record);
// 否则停 pending——端到端形态见 packages/eval/tests/evolution-admission.test.ts
```

L1 调优报告的修订（description/schema）同理：落地前后对同一 scenario 集跑两遍对比，eval 提供回归证据（修订仍由人执行）。

## 知识端口（runtime RAG）与摄取原型

- **kb 服务 + `kb.search`**：`createKnowledgePack()` + `KB_SERVICE_KEY` 服务注入（`createMemoryKb` 是零依赖参考实现，生产换向量检索零改动）；`createKbEnricher(kb)` 挂 agent `enrichObservation`——goal 命中领域约定自动注入观察面。零内核改动。
- **能力摄取原型（dev-time）**：`ingestCapability(签名, {idPrefix, llm?})` → 能力文件 + 测试骨架源码串。边界：SAR 编排仓库暴露的能力、不给仓库写代码——产物经 doctor + 人审 + commit 进仓（ts-morph 提取签名是预期前端）。

## 可观测出口（F4，`@geoverse-sar/otel`）

`createOtelMiddleware(tracer)`（invoke → span，审计维度全上属性）+ `bridgeEventsToOtel(events, tracer)`（workflow 开合 / 事务含 undo/redo）。只依赖 `@opentelemetry/api`，SDK 宿主自带。与 audit 分工：audit=取证面（全量、落 store），OTel=观测面（采样、接 APM）。
