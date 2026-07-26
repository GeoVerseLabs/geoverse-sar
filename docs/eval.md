# 评测闭环（eval，阶段四 U2）

`@geoverse-sar/eval` 把「回放等价」资产升格为**确定性回归门**：后续每一项通用化改进（目录检索、观察预算、prompt profile、L1 修订、L2 合成 enable）都要过它——否则改进只是"感觉变好了"。设计定案见 vault `docs/rfc/0011-sar-eval-harness.md`。

## scenario 模型

scenario = 装配工厂 + 计划 + **声明式断言**：

```ts
import { runScenario, createScriptedLlm, type EvalScenario } from '@geoverse-sar/eval';

const scenario: EvalScenario = {
  id: 'records-macro-workflow',
  // 每次运行全新世界（确定性前提）；必须把 ctx.middleware 传进 createKernel——
  // runner 的审计观察由此注入，不旁路漏斗
  setup: ({ middleware }) => ({
    kernel: createKernel({ engine, algebra, packs, workflows, middleware }),
  }),
  plan: [
    {
      invoke: {
        capabilityId: 'workflow.highlightAndNudge',
        input: { propsEquals: { type: 'poi' }, dx: 2 },
      },
    },
  ],
  expect: {
    undoDepth: 1, // 宏撤销折叠
    entities: [{ id: 'p1', match: { x: 2 } }],
    auditSequence: ['workflow.highlightAndNudge'],
  },
};
const r = await runScenario(scenario);
// r = { ok, failures[], stateHash, auditIds[], entityCount, undoDepth }
```

`plan` 二选一：脚本化动作序列（`invoke`/`undo`/`redo` 步），或 `{ goal, llm }` 走 planner tool-use 循环——配 `createScriptedLlm` 仍是确定性（goal 驱动 deterministic 档），配真实 LLM 即 live 档。

## 断言纪律：白名单靠构造

`ScenarioExpect` 是声明式数据，只有这些形状——自由函数与"对 LLM 输出文本做字符串匹配"在类型上就不存在（比 lint 更硬）：

| 字段                                | 判什么                                |
| ----------------------------------- | ------------------------------------- |
| `entityCount` / `undoDepth`         | 终态计数与撤销栈深                    |
| `entities[{ id, absent?, match? }]` | 实体存在性 + 部分深比较（子集匹配）   |
| `auditSequence`                     | capabilityId 按序子序列（治理完整性） |
| `outcomes[{ capabilityId, ok }]`    | 关键能力最后一次调用的结局            |

## 确定性判据

runner 把终态规范化（实体按 id 排序 + 键排序 JSON）后 FNV-1a 哈希——**同一 scenario 跑三遍 `stateHash` 逐字节相同**（CI 钉死；`records-scenarios.test.ts` 有现成写法）。deterministic 档随 `pnpm verify` 进 CI；live 档（真 LLM/多厂商对比报告）随 Provider 恢复后补——报告是数据不是门。

## 场景分布

- records 域（geoverse-free）：`packages/eval/tests/records-scenarios.test.ts`（脚本化 6 + goal 驱动 2）——CI geoverse-free 子集也跑；
- geo 域：`packages/capabilities-geo/tests/eval-scenarios.test.ts`（4 个，真实 editor-core 引擎）——本地 `pnpm verify` 全量跑。
- 纪律：U3 起每个新能力面配套补 scenario。

## evolution 准入接线

- **L2 合成 workflow 的 enable 必过 scenario 集**：`runScenarios` 在含合成物的沙箱 kernel 上全绿才允许 `synthesis.enable`，任一失败停在 pending。evolution 与 eval 互不依赖——准入是**组装根的纪律**；端到端形态见 `packages/eval/tests/evolution-admission.test.ts`（故意劣化的合成 workflow 被判红拦下）。
- **L1 调优修订**（description/schema 改动）落地前后对同一 scenario 集跑两遍对比——修订仍由人执行（红线"进化数据不进化代码"），eval 提供回归证据。
