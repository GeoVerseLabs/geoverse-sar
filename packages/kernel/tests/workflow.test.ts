import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createKernel,
  type SarKernel,
  type Workflow,
  type WorkflowScope,
} from '../src/index';
import {
  allItemCapabilities,
  ItemAlgebra,
  ItemEngine,
  type Item,
  type ItemDiff,
} from './helpers';

function setup(
  workflows: Workflow[] = [],
  seed: Item[] = [{ id: 'a', value: 1 }],
): {
  kernel: SarKernel<Item, ItemDiff>;
  engine: ItemEngine;
} {
  const engine = new ItemEngine(seed);
  const kernel = createKernel<Item, ItemDiff>({
    engine,
    algebra: new ItemAlgebra(),
    packs: [{ id: 'item', capabilities: allItemCapabilities() }],
    workflows,
  });
  return { kernel, engine };
}

const doubleWrite: Workflow = {
  id: 'wf.doubleWrite',
  title: '两步写',
  description: '新增一条再改一条；宏撤销折叠为一个撤销单元。',
  inputSchema: z.object({ newId: z.string(), setTo: z.number() }),
  undo: 'macro',
  steps: [
    {
      id: 'add',
      capability: 'item.add',
      input: (s: WorkflowScope) => ({
        items: [{ id: (s.input as { newId: string }).newId, value: 0 }],
      }),
    },
    {
      id: 'set',
      capability: 'item.set',
      input: (s: WorkflowScope) => ({
        id: (s.input as { newId: string }).newId,
        value: (s.input as { setTo: number }).setTo,
      }),
    },
  ],
  output: (s) => ({ added: (s.steps.add as { ids: string[] }).ids }),
};

describe('Workflow', () => {
  it('步间数据流：后步经 scope 引用前步输出；宏撤销 undoDepth===1', async () => {
    const { kernel, engine } = setup([doubleWrite]);
    const run = await kernel.runWorkflow('wf.doubleWrite', { newId: 'n1', setTo: 9 });
    expect(run.ok).toBe(true);
    expect(run.output).toEqual({ added: ['n1'] });
    // add-then-modify 折叠进 added：合并 diff 无 modified 残留
    expect(run.diff?.added).toEqual([{ id: 'n1', value: 9 }]);
    expect(run.diff?.modified).toEqual([]);
    expect(engine.undoDepth).toBe(1);

    engine.undo();
    expect(engine.snapshot().entities.has('n1')).toBe(false);
  });

  it('when 条件步：false 则跳过', async () => {
    const wf: Workflow = {
      id: 'wf.cond',
      title: '条件步',
      description: '仅当 flag 为真时写。',
      inputSchema: z.object({ flag: z.boolean() }),
      undo: 'macro',
      steps: [
        {
          id: 'maybe',
          capability: 'item.set',
          when: (s) => (s.input as { flag: boolean }).flag,
          input: { id: 'a', value: 100 },
        },
      ],
    };
    const { kernel, engine } = setup([wf]);
    const run = await kernel.runWorkflow('wf.cond', { flag: false });
    expect(run.ok).toBe(true);
    expect(run.steps.maybe).toBeUndefined();
    expect(engine.undoDepth).toBe(0);

    const run2 = await kernel.runWorkflow('wf.cond', { flag: true });
    expect(run2.ok).toBe(true);
    expect(engine.snapshot().entities.get('a')!.value).toBe(100);
  });

  it('步骤失败 → abort 整组，引擎零污染，返回 failedStepId', async () => {
    const wf: Workflow = {
      id: 'wf.fails',
      title: '中途失败',
      description: '第二步引用不存在实体。',
      inputSchema: z.object({}),
      undo: 'macro',
      steps: [
        { id: 's1', capability: 'item.set', input: { id: 'a', value: 5 } },
        { id: 's2', capability: 'item.set', input: { id: 'ghost', value: 1 } },
      ],
    };
    const { kernel, engine } = setup([wf]);
    const run = await kernel.runWorkflow('wf.fails', {});
    expect(run.ok).toBe(false);
    expect(run.failedStepId).toBe('s2');
    expect(engine.undoDepth).toBe(0);
    expect(engine.snapshot().entities.get('a')!.value).toBe(1);
  });

  it("undo:'per-step' 每写步独立撤销单元", async () => {
    const wf: Workflow = {
      id: 'wf.perStep',
      title: '逐步撤销',
      description: '两个独立撤销单元。',
      inputSchema: z.object({}),
      undo: 'per-step',
      steps: [
        { id: 's1', capability: 'item.set', input: { id: 'a', value: 5 } },
        { id: 's2', capability: 'item.set', input: { id: 'a', value: 6 } },
      ],
    };
    const { kernel, engine } = setup([wf]);
    const run = await kernel.runWorkflow('wf.perStep', {});
    expect(run.ok).toBe(true);
    expect(engine.undoDepth).toBe(2);
    engine.undo();
    expect(engine.snapshot().entities.get('a')!.value).toBe(5);
  });

  it('工作流入参校验失败 → issues', async () => {
    const { kernel } = setup([doubleWrite]);
    const run = await kernel.runWorkflow('wf.doubleWrite', { newId: 123 });
    expect(run.ok).toBe(false);
    expect(run.error?.code).toBe('validation_failed');
    expect(run.issues?.length).toBeGreaterThan(0);
  });

  it('未注册工作流 → workflow_not_found', async () => {
    const { kernel } = setup();
    const run = await kernel.runWorkflow('wf.ghost', {});
    expect(run.ok).toBe(false);
    expect(run.error?.code).toBe('workflow_not_found');
  });

  it('工作流即工具：注册后可经 invoke 单次调用（出现在能力目录）', async () => {
    const { kernel, engine } = setup([doubleWrite]);
    expect(kernel.describeAll().map((d) => d.id)).toContain('wf.doubleWrite');

    const out = await kernel.invoke('wf.doubleWrite', { newId: 'n2', setTo: 3 });
    expect(out.ok).toBe(true);
    expect(out.output).toEqual({ added: ['n2'] });
    expect(engine.snapshot().entities.get('n2')!.value).toBe(3);
    expect(engine.undoDepth).toBe(1);
  });

  it('工作流 id 与既有能力冲突时注册抛错', () => {
    const wf: Workflow = {
      id: 'item.get',
      title: '冲突',
      description: '与能力同 id。',
      inputSchema: z.object({}),
      undo: 'none',
      steps: [],
    };
    expect(() => setup([wf])).toThrowError(/已注册/);
  });
});
