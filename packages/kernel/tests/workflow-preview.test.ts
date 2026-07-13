/**
 * Gate 0 契约测试（阶段三 G0-1）：Workflow 以能力形式被调用时，
 * dryRun / signal / 外层事务组必须与原子能力同语义——
 * 预览零写入、中止无半写、嵌套并入外层组保原子性。
 * 背景：2026-07-11 外部复评 P0-1——此前 dryRun 调 workflow 内部步骤仍真实提交。
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  clientOf,
  createKernel,
  type Capability,
  type SarEvent,
  type SarKernel,
  type Workflow,
  type WorkflowScope,
} from '../src/index';
import {
  allItemCapabilities,
  ItemAlgebra,
  ItemEngine,
  SetValueCommand,
  type Item,
  type ItemDiff,
} from './helpers';

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

const perStepSet: Workflow = {
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

function setup(
  workflows: Workflow[] = [],
  extra: Capability<never, never, Item, ItemDiff>[] = [],
): { kernel: SarKernel<Item, ItemDiff>; engine: ItemEngine } {
  const engine = new ItemEngine([{ id: 'a', value: 1 }]);
  const kernel = createKernel<Item, ItemDiff>({
    engine,
    algebra: new ItemAlgebra(),
    packs: [{ id: 'item', capabilities: [...allItemCapabilities(), ...extra] }],
    workflows,
  });
  return { kernel, engine };
}

describe('Workflow 预览契约（Gate 0）', () => {
  it('复评 P0-1 回归：macro workflow 经 invoke dryRun——返回合并 diff 但引擎零写入、undo 栈不长', async () => {
    const { kernel, engine } = setup([doubleWrite]);
    const out = await kernel.invoke(
      'wf.doubleWrite',
      { newId: 'n1', setTo: 9 },
      { dryRun: true },
    );

    expect(out.ok).toBe(true);
    expect(out.dryRun).toBe(true);
    expect(out.output).toEqual({ added: ['n1'] });
    // 步间投影可见：第二步 set 的是仅存在于预览组投影里的 n1，合并后折叠进 added
    expect(out.diff?.added).toEqual([{ id: 'n1', value: 9 }]);
    expect(out.diff?.modified).toEqual([]);
    // 预览不落地：实体没进引擎、撤销栈不长、既有实体不被改
    expect(engine.snapshot().entities.has('n1')).toBe(false);
    expect(engine.snapshot().entities.get('a')!.value).toBe(1);
    expect(engine.undoDepth).toBe(0);
  });

  it('per-step workflow 经 invoke dryRun 同样零写入（预览组不分 undo 模式）', async () => {
    const { kernel, engine } = setup([perStepSet]);
    const out = await kernel.invoke('wf.perStep', {}, { dryRun: true });

    expect(out.ok).toBe(true);
    expect(out.dryRun).toBe(true);
    // 两步 set 折叠：before=初值 1、after=末值 6
    expect(out.diff?.modified).toEqual([
      { id: 'a', before: { id: 'a', value: 1 }, after: { id: 'a', value: 6 } },
    ]);
    expect(engine.snapshot().entities.get('a')!.value).toBe(1);
    expect(engine.undoDepth).toBe(0);
  });

  it('runWorkflow 直调 dryRun 与 invoke 同语义，且不触发 onStep（预览不是持久化进度）', async () => {
    const { kernel, engine } = setup([doubleWrite]);
    const stepCalls: string[] = [];
    const run = await kernel.runWorkflow(
      'wf.doubleWrite',
      { newId: 'n1', setTo: 9 },
      { dryRun: true, onStep: (id) => void stepCalls.push(id) },
    );

    expect(run.ok).toBe(true);
    expect(run.dryRun).toBe(true);
    expect(run.diff?.added).toEqual([{ id: 'n1', value: 9 }]);
    expect(run.steps.set).toEqual({ previous: 0 });
    expect(stepCalls).toEqual([]);
    expect(engine.undoDepth).toBe(0);
    expect(engine.snapshot().entities.has('n1')).toBe(false);
  });

  it('SarClient 切面 dryRun 调 workflow 同样零写入（审批门预览路径）', async () => {
    const { kernel, engine } = setup([doubleWrite]);
    const client = clientOf(kernel, { entry: 'agent', id: 'bot' });
    const out = await client.invoke(
      'wf.doubleWrite',
      { newId: 'n1', setTo: 9 },
      { dryRun: true },
    );

    expect(out.ok).toBe(true);
    expect(out.diff).toBeDefined();
    expect(engine.snapshot().entities.has('n1')).toBe(false);
    expect(engine.undoDepth).toBe(0);
  });

  it('workflow 事件带 dryRun 标记，真实执行不带', async () => {
    const { kernel } = setup([doubleWrite]);
    const events: SarEvent<ItemDiff>[] = [];
    kernel.events.on((e) => {
      if (e.type === 'workflow:start' || e.type === 'workflow:end') events.push(e);
    });

    await kernel.invoke('wf.doubleWrite', { newId: 'p1', setTo: 2 }, { dryRun: true });
    await kernel.invoke('wf.doubleWrite', { newId: 'r1', setTo: 2 });

    expect(events.map((e) => ('dryRun' in e ? e.dryRun : undefined))).toEqual([
      true,
      true,
      undefined,
      undefined,
    ]);
  });
});

describe('Workflow 取消信号（Gate 0）', () => {
  /** 第一步执行途中触发取消：写路由前兜底应拦下本步，后续步不再执行。 */
  function abortingCapability(
    controller: AbortController,
  ): Capability<{ value: number }, { done: boolean }, Item, ItemDiff> {
    return {
      id: 'item.abortThenSet',
      title: '中途取消',
      description: '测试替身：handler 内触发取消再返回写命令。',
      category: 'item',
      kind: 'write',
      inputSchema: z.object({ value: z.number() }),
      outputSchema: z.object({ done: z.boolean() }),
      handler: async (_ctx, input) => {
        controller.abort();
        return {
          output: { done: true },
          commands: [new SetValueCommand('a', input.value)],
        };
      },
    };
  }

  const abortWf: Workflow = {
    id: 'wf.aborts',
    title: '取消传播',
    description: '第一步触发取消，第二步不应执行。',
    inputSchema: z.object({}),
    undo: 'macro',
    steps: [
      { id: 'trigger', capability: 'item.abortThenSet', input: { value: 5 } },
      { id: 'after', capability: 'item.set', input: { id: 'a', value: 6 } },
    ],
  };

  it('signal 逐步透传：中止后错误码 aborted、宏组 abort 无半写', async () => {
    const controller = new AbortController();
    const { kernel, engine } = setup(
      [abortWf],
      [
        abortingCapability(controller) as unknown as Capability<
          never,
          never,
          Item,
          ItemDiff
        >,
      ],
    );

    const run = await kernel.runWorkflow('wf.aborts', {}, { signal: controller.signal });
    expect(run.ok).toBe(false);
    expect(run.error?.code).toBe('aborted');
    expect(run.failedStepId).toBe('trigger');
    expect(engine.snapshot().entities.get('a')!.value).toBe(1);
    expect(engine.undoDepth).toBe(0);
  });

  it('经 invoke 调 workflow 时 signal 同样贯穿，错误码保真为 aborted', async () => {
    const controller = new AbortController();
    const { kernel, engine } = setup(
      [abortWf],
      [
        abortingCapability(controller) as unknown as Capability<
          never,
          never,
          Item,
          ItemDiff
        >,
      ],
    );

    const out = await kernel.invoke('wf.aborts', {}, { signal: controller.signal });
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('aborted');
    expect(engine.snapshot().entities.get('a')!.value).toBe(1);
    expect(engine.undoDepth).toBe(0);
  });
});

describe('嵌套 Workflow（Gate 0）', () => {
  const inner: Workflow = {
    id: 'wf.inner',
    title: '内层写',
    description: '单步 set。',
    inputSchema: z.object({ value: z.number() }),
    undo: 'macro',
    steps: [
      {
        id: 'set',
        capability: 'item.set',
        input: (s: WorkflowScope) => ({
          id: 'a',
          value: (s.input as { value: number }).value,
        }),
      },
    ],
  };

  const outer: Workflow = {
    id: 'wf.outer',
    title: '外层组合',
    description: '先直写再调内层 workflow。',
    inputSchema: z.object({}),
    undo: 'macro',
    steps: [
      { id: 'direct', capability: 'item.set', input: { id: 'a', value: 3 } },
      { id: 'nested', capability: 'wf.inner', input: { value: 5 } },
    ],
  };

  it('内层 workflow 并入外层宏组：整体单一撤销单元，一次 undo 全回退', async () => {
    const { kernel, engine } = setup([inner, outer]);
    const run = await kernel.runWorkflow('wf.outer', {});

    expect(run.ok).toBe(true);
    expect(engine.snapshot().entities.get('a')!.value).toBe(5);
    // 此前缺陷形态：内层自建组提前 commit → 撤销单元被击穿成多个
    expect(engine.undoDepth).toBe(1);
    engine.undo();
    expect(engine.snapshot().entities.get('a')!.value).toBe(1);
  });

  it('嵌套 dryRun：外层预览时内层步骤同样零写入，合并 diff 反映末态', async () => {
    const { kernel, engine } = setup([inner, outer]);
    const out = await kernel.invoke('wf.outer', {}, { dryRun: true });

    expect(out.ok).toBe(true);
    expect(out.diff?.modified).toEqual([
      { id: 'a', before: { id: 'a', value: 1 }, after: { id: 'a', value: 5 } },
    ]);
    expect(engine.snapshot().entities.get('a')!.value).toBe(1);
    expect(engine.undoDepth).toBe(0);
  });

  it('内层步骤失败 → 外层整组 abort，引擎零污染', async () => {
    const badInner: Workflow = {
      ...inner,
      id: 'wf.innerBad',
      steps: [{ id: 'set', capability: 'item.set', input: { id: 'ghost', value: 1 } }],
    };
    const outerBad: Workflow = {
      ...outer,
      id: 'wf.outerBad',
      steps: [
        { id: 'direct', capability: 'item.set', input: { id: 'a', value: 3 } },
        { id: 'nested', capability: 'wf.innerBad', input: { value: 5 } },
      ],
    };
    const { kernel, engine } = setup([badInner, outerBad]);
    const run = await kernel.runWorkflow('wf.outerBad', {});

    expect(run.ok).toBe(false);
    expect(run.failedStepId).toBe('nested');
    expect(engine.snapshot().entities.get('a')!.value).toBe(1);
    expect(engine.undoDepth).toBe(0);
  });
});
