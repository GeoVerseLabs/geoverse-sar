# 工作流与宏撤销

Workflow 把多个能力组合成一次调用，核心价值：**步间数据流** + **整条工作流一个撤销单元**。

## 定义（真实例：highlightAndNudge）

```ts
import { z } from 'zod';
import type { Workflow, WorkflowScope } from '@geoverse-sar/kernel';

const wf: Workflow = {
  id: 'workflow.highlightAndNudge',
  title: '高亮并轻移',
  description: '按属性找到一批记录，聚焦视野，打高亮标记并平移一小步。一次调用完成多步，可一次撤销全回退。',
  inputSchema: z.object({
    propsEquals: z.record(z.string(), z.unknown()),
    dx: z.number().default(1),
    dy: z.number().default(0),
  }),
  undo: 'macro',
  steps: [
    { id: 'find', capability: 'records.query',
      input: (s: WorkflowScope) => ({ propsEquals: s.input.propsEquals }) },
    { id: 'focus', capability: 'view.focus',
      when: (s) => foundIds(s).length > 0,
      input: (s) => ({ ids: foundIds(s) }) },
    { id: 'highlight', capability: 'records.setProps',
      when: (s) => foundIds(s).length > 0,
      input: (s) => ({ ids: foundIds(s), props: { highlighted: true } }) },
    { id: 'nudge', capability: 'records.translate',
      when: (s) => foundIds(s).length > 0,
      input: (s) => ({ ids: foundIds(s), dx: s.input.dx, dy: s.input.dy }) },
  ],
  output: (s) => ({ matchedIds: foundIds(s), count: foundIds(s).length }),
};
```

- **数据流**：`scope.steps[stepId] = 该步 output`，后步 `input: (scope) => ...` 引用前步结果。
- **条件步**：`when(scope)` 为 false 则跳过（上例无匹配记录时三个后续步全跳过，不产生空撤销单元）。
- **output 投影**：缺省返回整个 `scope.steps`；给 `output(scope)` 可裁出干净出参。

## undo 三档

| 档 | 语义 |
|---|---|
| `'macro'` | 全程共享一个 TransactionGroup：write 步的命令 **缓冲不落地**（后步经投影上下文看见前步效果），结束 `merge` 折叠成一个 diff、dispatch 一次 → `undoDepth` 只 +1，一次 undo 全回退 |
| `'per-step'` | 每个 write 步独立撤销单元 |
| `'none'` | 纯读/action 工作流用（macro 且无写步时 doctor 会提醒改用它） |

失败语义：任一步失败 → **整组 abort**，引擎零污染，返回 `failedStepId` + 原始错误/issues。

## merge 折叠矩阵（宏撤销正确性）

同一 id 跨步的变更在 `DiffAlgebra.merge` 中折叠：

| 序列 | 结果 |
|---|---|
| add → modify | 折进 added（after 态），无 modified 残留 |
| modify → modify | 首 before / 末 after |
| add → remove | 相消 |
| modify → remove | removed 保留原始 before |
| remove → add | 折成 modified |

上例中 `highlight`（setProps）+ `nudge`（translate）作用于同一批 id → 合并 diff 里每条记录只有一条 modified（before=原始态，after=高亮+位移后），undo 一步全还原。

## 工作流即工具

`workflows.register(wf)`（或 `createKernel({ workflows })`）会同时把工作流注册为**同 id 的能力**：它出现在 `describeAll` / `toPaletteItems` / `toToolSpecs` / MCP `tools/list` 里，AI/UI 一次调用即可执行多步——这是给模型"高层动词"的正确方式（比让它自己编排 4 个低层调用更稳、更省轮次，且可一键回滚）。

也可编程运行拿完整明细：`kernel.runWorkflow(id, input)` → `{ ok, output, diff?, failedStepId?, steps }`。
