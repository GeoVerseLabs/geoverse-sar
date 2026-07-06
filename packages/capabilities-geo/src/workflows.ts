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

const foundIds = (scope: WorkflowScope<Input>): string[] =>
  (
    (scope.steps.find as { features: { id: string }[] } | undefined)?.features ?? []
  ).map((f) => f.id);

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
      matchedIds: z.array(z.string()),
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
        when: (s) => foundIds(s).length > 0,
        input: (s: WorkflowScope<Input>) => ({ ids: foundIds(s) }),
      },
      {
        id: 'highlight',
        capability: 'features.setProps',
        when: (s) => foundIds(s).length > 0,
        input: (s: WorkflowScope<Input>) => ({
          ids: foundIds(s),
          props: { highlighted: true },
        }),
      },
      {
        id: 'nudge',
        capability: 'features.translate',
        when: (s) => foundIds(s).length > 0,
        input: (s: WorkflowScope<Input>) => ({
          ids: foundIds(s),
          dx: s.input.dx,
          dy: s.input.dy,
        }),
      },
    ],
    output: (s) => ({ matchedIds: foundIds(s), count: foundIds(s).length }),
  };
}
