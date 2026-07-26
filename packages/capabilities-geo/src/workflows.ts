import { z } from 'zod';
import type { Workflow, WorkflowScope } from '@geoverse-sar/kernel';

const inputSchema = z.object({
  propsEquals: z
    .record(z.string(), z.unknown())
    .describe('属性全等匹配目标要素，如 {"type":"building"}'),
  dx: z.number().default(1).describe('轻移 x 分量'),
  dy: z.number().default(0).describe('轻移 y 分量'),
});

type Input = z.infer<typeof inputSchema>;

// U3-C：find 步回包已句柄化——后续步骤用 target:{setId} 指代整批命中，
// 不再抄写 id 列表（命名集寻址的第一位内部用户）。
const foundSet = (scope: WorkflowScope<Input>) =>
  scope.steps.find as { setId: string; count: number } | undefined;
const foundCount = (scope: WorkflowScope<Input>): number => foundSet(scope)?.count ?? 0;

/** geo 版高亮并轻移：与 records 版同构——跨引擎验证"同一工作流心智"。 */
export function createGeoHighlightAndNudgeWorkflow(): Workflow<Input> {
  return {
    id: 'workflow.highlightAndNudge',
    title: '高亮并轻移',
    description:
      '按属性找到一批要素，视野聚焦过去，打上 highlighted 标记并平移一小步。一次调用完成多步，可一次撤销全回退。',
    category: 'workflow',
    inputSchema,
    outputSchema: z.object({
      setId: z.string().describe('命中集句柄（后续可继续用 target:{setId} 指代）'),
      count: z.number(),
    }),
    undo: 'macro',
    tags: ['features', 'demo'],
    steps: [
      {
        id: 'find',
        capability: 'features.query',
        input: (s: WorkflowScope<Input>) => ({ propsEquals: s.input.propsEquals }),
      },
      {
        id: 'focus',
        capability: 'view.focus',
        when: (s) => foundCount(s) > 0,
        input: (s: WorkflowScope<Input>) => ({
          target: { setId: foundSet(s)!.setId },
        }),
      },
      {
        id: 'highlight',
        capability: 'features.setProps',
        when: (s) => foundCount(s) > 0,
        input: (s: WorkflowScope<Input>) => ({
          target: { setId: foundSet(s)!.setId },
          props: { highlighted: true },
        }),
      },
      {
        id: 'nudge',
        capability: 'features.translate',
        when: (s) => foundCount(s) > 0,
        input: (s: WorkflowScope<Input>) => ({
          target: { setId: foundSet(s)!.setId },
          dx: s.input.dx,
          dy: s.input.dy,
        }),
      },
    ],
    output: (s) => ({
      setId: foundSet(s)?.setId ?? '',
      count: foundCount(s),
    }),
  };
}
