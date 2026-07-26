/**
 * U4-D CompositeStateEngine（ADR-0017）：多图层单撤销时间线——
 * 跨两图层 workflow undoDepth 恰 +1、一次 undo 全回退；子引擎不对外暴露
 * （能力面无法直达其撤销栈）；事件流每次复合操作恰一帧。kernel 端口零改动。
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createCompositeEngine,
  createKernel,
  type Capability,
  type CompositeDiff,
  type SarEvent,
  type Workflow,
} from '../src/index';
import { ItemAlgebra, ItemEngine, type Item, type ItemDiff } from './helpers';

function makeComposite() {
  return createCompositeEngine<Item, ItemDiff>({
    roads: {
      engine: new ItemEngine([{ id: 'r1', value: 1 }]),
      algebra: new ItemAlgebra(),
    },
    pois: {
      engine: new ItemEngine([{ id: 'p1', value: 10 }]),
      algebra: new ItemAlgebra(),
    },
  });
}

const bump = (
  id: string,
  layer: string,
  capId: string,
): Capability<{ delta: number }, { ok: boolean }, Item, CompositeDiff<ItemDiff>> => ({
  id: capId,
  title: `${layer} 层加值`,
  description: `把 ${layer} 层的 ${id} 值加 delta（复合层写入，用于多图层时间线测试）。`,
  category: 'compo',
  kind: 'write',
  inputSchema: z.object({ delta: z.number() }),
  outputSchema: z.object({ ok: z.boolean() }),
  handler: async (_ctx, input) => ({
    output: { ok: true },
    commands: [
      {
        label: `${layer} 加值`,
        plan: (state) => {
          const before = state.get(`${layer}/${id}`);
          if (!before) throw new Error(`不存在: ${layer}/${id}`);
          return [
            {
              layer,
              diff: {
                added: [],
                removed: [],
                modified: [
                  { id, before, after: { ...before, value: before.value + input.delta } },
                ],
              },
            },
          ];
        },
      },
    ],
  }),
});

describe('createCompositeEngine', () => {
  it('复合快照按 layer/id 寻址；精读端口跨层 O(1)；entityCount 求和', () => {
    const { engine } = makeComposite();
    expect(engine.snapshot().entities.get('roads/r1')).toMatchObject({ value: 1 });
    expect(engine.snapshot().entities.get('pois/p1')).toMatchObject({ value: 10 });
    expect(engine.getEntity!('pois/p1')).toMatchObject({ value: 10 });
    expect(engine.getEntity!('ghost/x')).toBeUndefined();
    expect(engine.entityCount!()).toBe(2);
  });

  it('一次复合 dispatch 跨两层 → 时间线恰一帧、一次 undo 双层全回退、redo 复现', () => {
    const { engine } = makeComposite();
    const frames: string[] = [];
    engine.onTransaction((e) => frames.push(e.origin));

    const res = engine.dispatch({
      label: '双层写',
      plan: () => [
        {
          layer: 'roads',
          diff: {
            added: [{ id: 'r2', value: 2 }],
            removed: [],
            modified: [],
          },
        },
        {
          layer: 'pois',
          diff: {
            added: [{ id: 'p2', value: 20 }],
            removed: [],
            modified: [],
          },
        },
      ],
    });
    expect(res.ok).toBe(true);
    expect(engine.undoDepth).toBe(1); // 跨两层恰一个撤销单元
    expect(frames).toEqual(['dispatch']);

    engine.undo();
    expect(engine.snapshot().entities.has('roads/r2')).toBe(false);
    expect(engine.snapshot().entities.has('pois/p2')).toBe(false);
    engine.redo();
    expect(engine.snapshot().entities.has('roads/r2')).toBe(true);
    expect(engine.snapshot().entities.has('pois/p2')).toBe(true);
    expect(frames).toEqual(['dispatch', 'undo', 'redo']);
  });

  it('分量层拒绝 → 已落地分量回滚、整体 ok:false（跨层原子性）', () => {
    const { engine } = makeComposite();
    const res = engine.dispatch({
      plan: () => [
        {
          layer: 'roads',
          diff: { added: [{ id: 'r9', value: 9 }], removed: [], modified: [] },
        },
        // pois 层新增撞已有 id → 引擎拒绝
        {
          layer: 'pois',
          diff: { added: [{ id: 'p1', value: 0 }], removed: [], modified: [] },
        },
      ],
    });
    expect(res.ok).toBe(false);
    expect(engine.snapshot().entities.has('roads/r9')).toBe(false); // 已落地的 roads 分量被回滚
    expect(engine.undoDepth).toBe(0);
  });

  it('子引擎不对外暴露（能力面/宿主无法直达子撤销栈）', () => {
    const handle = makeComposite();
    expect(handle.layers().sort()).toEqual(['pois', 'roads']);
    const opaque = handle as unknown as Record<string, unknown>;
    expect(opaque.layerMap).toBeUndefined();
    expect(opaque.engines).toBeUndefined();
    expect(Object.keys(handle).sort()).toEqual([
      'algebra',
      'engine',
      'forLayer',
      'layers',
    ]);
  });
});

describe('composite × kernel（宏撤销/事件——kernel 零改动的直接红利）', () => {
  it('跨两图层的 macro workflow → undoDepth 恰 +1，一次 undo 双层全回退', async () => {
    const { engine, algebra } = makeComposite();
    const wf: Workflow = {
      id: 'workflow.crossLayer',
      title: '跨层双写',
      description: '先加 roads 再加 pois，宏撤销折叠为一个撤销单元。',
      inputSchema: z.object({}),
      undo: 'macro',
      steps: [
        { id: 's1', capability: 'compo.bumpRoad', input: { delta: 5 } },
        { id: 's2', capability: 'compo.bumpPoi', input: { delta: 7 } },
      ],
    };
    const kernel = createKernel<Item, CompositeDiff<ItemDiff>>({
      engine,
      algebra,
      packs: [
        {
          id: 'compo',
          capabilities: [
            bump('r1', 'roads', 'compo.bumpRoad'),
            bump('p1', 'pois', 'compo.bumpPoi'),
          ],
        },
      ],
      workflows: [wf],
    });
    const events: SarEvent[] = [];
    kernel.events.on((e) => {
      if (e.type === 'engine:transaction') events.push(e);
    });

    const run = await kernel.runWorkflow('workflow.crossLayer', {});
    expect(run.ok).toBe(true);
    expect(engine.undoDepth).toBe(1); // 验收判据：跨两图层 workflow undoDepth 恰 +1
    expect(engine.snapshot().entities.get('roads/r1')).toMatchObject({ value: 6 });
    expect(engine.snapshot().entities.get('pois/p1')).toMatchObject({ value: 17 });
    expect(events.filter((e) => e.type === 'engine:transaction')).toHaveLength(1);

    engine.undo(); // 一次 undo 双层全回退
    expect(engine.snapshot().entities.get('roads/r1')).toMatchObject({ value: 1 });
    expect(engine.snapshot().entities.get('pois/p1')).toMatchObject({ value: 10 });
  });

  it('dryRun 预览跨层工作流：引擎零写入、撤销栈不长（既有投影机制自动成立）', async () => {
    const { engine, algebra } = makeComposite();
    const kernel = createKernel<Item, CompositeDiff<ItemDiff>>({
      engine,
      algebra,
      packs: [{ id: 'compo', capabilities: [bump('r1', 'roads', 'compo.bumpRoad')] }],
    });
    const out = await kernel.invoke('compo.bumpRoad', { delta: 3 }, { dryRun: true });
    expect(out.ok).toBe(true);
    expect(out.diff).toBeDefined();
    expect(engine.undoDepth).toBe(0);
    expect(engine.snapshot().entities.get('roads/r1')).toMatchObject({ value: 1 });
  });
});
