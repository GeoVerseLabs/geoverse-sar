/**
 * 内建 runtime 能力包（R3）：观察面/保存进度走能力而非对象戳探——
 * 远程入口（N3）与 agent 观察面切换（R6）的前置。
 */
import { describe, expect, it } from 'vitest';
import {
  CHECKPOINT_SERVICE_KEY,
  createKernel,
  createRuntimePack,
  type CheckpointService,
  type SarKernel,
} from '../src/index';
import {
  allItemCapabilities,
  ItemAlgebra,
  ItemEngine,
  type Item,
  type ItemDiff,
} from './helpers';

function setup(opts: { checkpointSvc?: CheckpointService; seed?: Item[] } = {}): {
  kernel: SarKernel<Item, ItemDiff>;
  engine: ItemEngine;
} {
  const engine = new ItemEngine(opts.seed ?? [{ id: 'a', value: 1 }]);
  const kernel = createKernel<Item, ItemDiff>({
    engine,
    algebra: new ItemAlgebra(),
    packs: [
      { id: 'item', capabilities: allItemCapabilities() },
      createRuntimePack<Item, ItemDiff>(),
    ],
    services: opts.checkpointSvc ? { [CHECKPOINT_SERVICE_KEY]: opts.checkpointSvc } : {},
  });
  return { kernel, engine };
}

describe('runtime.stats（观察面能力化）', () => {
  it('上报实体数与撤销/重做栈深，随编辑与 undo 变化', async () => {
    const { kernel, engine } = setup();
    let out = await kernel.invoke('runtime.stats', {});
    expect(out.ok).toBe(true);
    expect(out.output).toEqual({
      entityCount: 1,
      undoDepth: 0,
      redoDepth: 0,
      canUndo: false,
      canRedo: false,
    });

    await kernel.invoke('item.add', { items: [{ id: 'b', value: 2 }] });
    engine.undo();
    out = await kernel.invoke('runtime.stats', {});
    expect(out.output).toEqual({
      entityCount: 1,
      undoDepth: 0,
      redoDepth: 1,
      canUndo: false,
      canRedo: true,
    });
  });

  it('引擎不暴露栈深时上报 null（可选端口属性）', async () => {
    const engine = new ItemEngine([]);
    // 模拟未实现可选属性的引擎：把 getter 遮蔽为 undefined
    const bare = new Proxy(engine, {
      get(target, prop, receiver) {
        if (prop === 'undoDepth' || prop === 'redoDepth') return undefined;
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const kernel = createKernel<Item, ItemDiff>({
      engine: bare,
      algebra: new ItemAlgebra(),
      packs: [createRuntimePack<Item, ItemDiff>({ checkpoint: false })],
    });
    const out = await kernel.invoke('runtime.stats', {});
    expect(out.output).toMatchObject({
      undoDepth: null,
      redoDepth: null,
      canUndo: null,
      canRedo: null,
    });
  });

  it('在 txGroup 投影态下 entityCount 计入已缓冲新增（ctx.state 一致视图）', async () => {
    const { kernel } = setup();
    const group = kernel.beginGroup('批量');
    await kernel.invoke(
      'item.add',
      { items: [{ id: 'g1', value: 1 }] },
      { txGroupId: group.id },
    );
    const out = await kernel.invoke('runtime.stats', {}, { txGroupId: group.id });
    expect((out.output as { entityCount: number }).entityCount).toBe(2);
    group.abort();
  });
});

describe('runtime.checkpoint（保存进度）', () => {
  it('经服务注入执行并返回位点', async () => {
    const calls: number[] = [];
    const svc: CheckpointService = {
      checkpoint: async () => {
        calls.push(1);
        return { checkpointSeq: 42 };
      },
    };
    const { kernel } = setup({ checkpointSvc: svc });
    const out = await kernel.invoke('runtime.checkpoint', {});
    expect(out.ok).toBe(true);
    expect(out.output).toEqual({ checkpointSeq: 42 });
    expect(calls).toHaveLength(1);
  });

  it('未注入服务 → service_missing（requires 前置校验）', async () => {
    const { kernel } = setup();
    const out = await kernel.invoke('runtime.checkpoint', {});
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('service_missing');
  });

  it('checkpoint: false 时不注册该能力（免 doctor 告警）', async () => {
    const engine = new ItemEngine([]);
    const kernel = createKernel<Item, ItemDiff>({
      engine,
      algebra: new ItemAlgebra(),
      packs: [createRuntimePack<Item, ItemDiff>({ checkpoint: false })],
    });
    const out = await kernel.invoke('runtime.checkpoint', {});
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('capability_not_found');
  });
});
