# 工作流与宏撤销

Workflow 把多个能力组合成一次调用，核心价值：**步间数据流** + **整条工作流一个撤销单元**。

下面这段是可直接运行的完整最小例子。CI 会执行同一份测试源，并检查本页代码块与测试源逐字同步；这就是 SAR 的 Living Doc 门。

<!-- docs-smoke: packages/eval/tests/docs-snippets/records-workflow.ts -->

```ts
import { createKernel } from '@geoverse-sar/kernel';
import {
  createHighlightAndNudgeWorkflow,
  createMemoryViewService,
  createRecordsPack,
  VIEW_SERVICE_KEY,
} from '@geoverse-sar/capabilities-records';
import {
  InMemoryStateEngine,
  RecordDiffAlgebra,
  type RecordEntity,
} from '@geoverse-sar/engine-memory';

const seed: RecordEntity[] = [
  { id: 'p1', x: 0, y: 0, props: { type: 'poi' } },
  { id: 'p2', x: 10, y: 0, props: { type: 'poi' } },
  { id: 'r1', x: 5, y: 5, props: { type: 'road' } },
];

const engine = new InMemoryStateEngine(seed);
const kernel = createKernel({
  engine,
  algebra: new RecordDiffAlgebra(),
  packs: [createRecordsPack()],
  workflows: [createHighlightAndNudgeWorkflow()],
  services: { [VIEW_SERVICE_KEY]: createMemoryViewService() },
});

export async function runRecordsWorkflowExample() {
  const outcome = await kernel.invoke('workflow.highlightAndNudge', {
    propsEquals: { type: 'poi' },
    dx: 2,
    dy: 0,
  });
  return {
    outcome,
    undoDepth: engine.undoDepth,
    p1: engine.snapshot().entities.get('p1'),
  };
}
```

## 定义（真实例：highlightAndNudge）

```ts
import { z } from 'zod';
import type { Workflow, WorkflowScope } from '@geoverse-sar/kernel';

const wf: Workflow = {
  id: 'workflow.highlightAndNudge',
  title: '高亮并轻移',
  description:
    '按属性找到一批记录，聚焦视野，打高亮标记并平移一小步。一次调用完成多步，可一次撤销全回退。',
  inputSchema: z.object({
    propsEquals: z.record(z.string(), z.unknown()),
    dx: z.number().default(1),
    dy: z.number().default(0),
  }),
  undo: 'macro',
  steps: [
    {
      id: 'find',
      capability: 'records.query',
      input: (s: WorkflowScope) => ({ propsEquals: s.input.propsEquals }),
    },
    {
      id: 'focus',
      capability: 'view.focus',
      when: (s) => foundIds(s).length > 0,
      input: (s) => ({ ids: foundIds(s) }),
    },
    {
      id: 'highlight',
      capability: 'records.setProps',
      when: (s) => foundIds(s).length > 0,
      input: (s) => ({ ids: foundIds(s), props: { highlighted: true } }),
    },
    {
      id: 'nudge',
      capability: 'records.translate',
      when: (s) => foundIds(s).length > 0,
      input: (s) => ({ ids: foundIds(s), dx: s.input.dx, dy: s.input.dy }),
    },
  ],
  output: (s) => ({ matchedIds: foundIds(s), count: foundIds(s).length }),
};
```

- **数据流**：`scope.steps[stepId] = 该步 output`，后步 `input: (scope) => ...` 引用前步结果。
- **条件步**：`when(scope)` 为 false 则跳过（上例无匹配记录时三个后续步全跳过，不产生空撤销单元）。
- **output 投影**：缺省返回整个 `scope.steps`；给 `output(scope)` 可裁出干净出参。

## undo 三档

| 档           | 语义                                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'macro'`    | 全程共享一个 TransactionGroup：write 步的命令 **缓冲不落地**（后步经投影上下文看见前步效果），结束 `merge` 折叠成一个 diff、dispatch 一次 → `undoDepth` 只 +1，一次 undo 全回退 |
| `'per-step'` | 每个 write 步独立撤销单元                                                                                                                                                       |
| `'none'`     | 纯读/action 工作流用（macro 且无写步时 doctor 会提醒改用它）                                                                                                                    |

失败语义：任一步失败 → **整组 abort**，引擎零污染，返回 `failedStepId` + 原始错误/issues。

## 预览 / 取消 / 嵌套（与原子能力同契约）

工作流以能力形式被注册，因此经 `invoke` 调用时享有与原子能力**逐字节相同**的漏斗语义（阶段三 Gate 0 契约冻结）：

- **`dryRun`**：`kernel.invoke(id, input, { dryRun: true })` 或 `runWorkflow(id, input, { dryRun: true })` → 全部步骤在一个**预览事务组**里 stage（步间投影可见，第 N 步看得见第 N-1 步的效果），终局取合并 `diff` 后整组 abort——**引擎零写入、`undoDepth` 不长**。返回结果带 `dryRun: true` 与合并 `diff`，供 Agent 审批门/UI 做"这一步会改什么"的预览。（注意：与原子能力一致，read/action 步的 handler 仍会执行，只拦状态写入；效应级预览待 Gate 1 的 EffectDescriptor。）预览下不触发 `onStep`。
- **`signal`**：`{ signal }` 步间检查并逐步透传给内部 `dispatcher.invoke`——中止后错误码 `aborted`、宏组 abort 无半写。
- **嵌套**：工作流作为另一工作流的步骤时，写步自动**并入外层事务组**，不自建组、不提前 commit——外层原子性支配，整条组合仍是一个撤销单元（一次 undo 全回退）。

> 修复背景：此前"以能力形式 + `dryRun` 调工作流"内部步骤仍真实写入（预览不是预览）。现由 `CapabilityContext` 携带 `dryRun`/`txGroupId`、投影 handler 全量透传给 `run()` 修复，跨入口（invoke / runWorkflow / SarClient / Agent 审批门）同语义。契约测试见 `packages/kernel/tests/workflow-preview.test.ts`。

## 执行身份：一条工作流一个 traceId（G1-1）

一条工作流全程共享一个 `traceId`，**内部每一步都继承它**——`run(id, input)` 返回 `{ traceId, runId, ... }`，`runWorkflow`/`invoke`（以能力形式）/嵌套调用皆然。审计按 `runId` 或 `traceId` 即可取出这条长任务的全部步骤：

```ts
const run = await kernel.runWorkflow('workflow.highlightAndNudge', input);
// 该次运行的每一步都记在同一 run 下
const steps = auditLog.entries({ runId: run.runId }); // find / focus / highlight / nudge
// 以能力形式调用时，外层 invoke 与内部步骤同一 traceId
const out = await kernel.invoke('workflow.highlightAndNudge', input);
auditLog.entries({ traceId: out.traceId }); // 外层 + 全部步骤
```

缺省自动生成（`traceId` 前缀 `tr_`、`runId` 前缀 `run_`）；宿主也可显式传入以对齐外部请求。详见 [架构与技术明细](./architecture.md) 第四节「执行身份」。

## merge 折叠矩阵（宏撤销正确性）

同一 id 跨步的变更在 `DiffAlgebra.merge` 中折叠：

| 序列            | 结果                                     |
| --------------- | ---------------------------------------- |
| add → modify    | 折进 added（after 态），无 modified 残留 |
| modify → modify | 首 before / 末 after                     |
| add → remove    | 相消                                     |
| modify → remove | removed 保留原始 before                  |
| remove → add    | 折成 modified                            |

上例中 `highlight`（setProps）+ `nudge`（translate）作用于同一批 id → 合并 diff 里每条记录只有一条 modified（before=原始态，after=高亮+位移后），undo 一步全还原。

## 工作流即工具

`workflows.register(wf)`（或 `createKernel({ workflows })`）会同时把工作流注册为**同 id 的能力**：它出现在 `describeAll` / `toPaletteItems` / `toToolSpecs` / MCP `tools/list` 里，AI/UI 一次调用即可执行多步——这是给模型"高层动词"的正确方式（比让它自己编排 4 个低层调用更稳、更省轮次，且可一键回滚）。

也可编程运行拿完整明细：`kernel.runWorkflow(id, input)` → `{ ok, output, diff?, failedStepId?, steps }`。
