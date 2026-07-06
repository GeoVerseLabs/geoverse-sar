import { z } from 'zod';
import type { Workflow, WorkflowScope } from '@geoverse-sar/kernel';
import type { RecordEntity } from '@geoverse-sar/engine-memory';

const inputSchema = z.object({
  propsEquals: z
    .record(z.string(), z.unknown())
    .describe('属性全等匹配目标记录，如 {"type":"poi"}'),
  dx: z.number().default(1).describe('轻移 x 分量'),
  dy: z.number().default(0).describe('轻移 y 分量'),
});

type Input = z.infer<typeof inputSchema>;

const foundIds = (scope: WorkflowScope<Input>): string[] =>
  ((scope.steps.find as { records: RecordEntity[] } | undefined)?.records ?? []).map(
    (r) => r.id,
  );

/**
 * MVP 演示工作流（RFC-0008 §4.3）：查询 → 视野聚焦 → 打高亮 → 轻移。
 * 含两个写步（setProps + translate），undo:'macro' 折叠为一个撤销单元——
 * M1 验收点"宏撤销折叠 undoDepth===1"的载体。
 */
export function createHighlightAndNudgeWorkflow(): Workflow<Input> {
  return {
    id: 'workflow.highlightAndNudge',
    title: '高亮并轻移',
    description:
      '按属性找到一批记录，把视野聚焦过去，给它们打上 highlighted 标记并平移一小步。一次调用完成多步，可一次撤销全回退。',
    category: 'workflow',
    inputSchema,
    outputSchema: z.object({
      matchedIds: z.array(z.string()),
      count: z.number(),
    }),
    undo: 'macro',
    tags: ['records', 'demo'],
    steps: [
      {
        id: 'find',
        capability: 'records.query',
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
        capability: 'records.setProps',
        when: (s) => foundIds(s).length > 0,
        input: (s: WorkflowScope<Input>) => ({
          ids: foundIds(s),
          props: { highlighted: true },
        }),
      },
      {
        id: 'nudge',
        capability: 'records.translate',
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
