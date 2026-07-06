import { describe, expect, it } from 'vitest';
import {
  createKernel,
  type Middleware,
  type SarEvent,
  type SarKernel,
} from '../src/index';
import {
  allItemCapabilities,
  ItemAlgebra,
  ItemEngine,
  type Item,
  type ItemDiff,
} from './helpers';

function setup(opts: { middleware?: Middleware[]; seed?: Item[] } = {}): {
  kernel: SarKernel<Item, ItemDiff>;
  engine: ItemEngine;
} {
  const engine = new ItemEngine(opts.seed ?? [{ id: 'a', value: 1 }]);
  const kernel = createKernel<Item, ItemDiff>({
    engine,
    algebra: new ItemAlgebra(),
    packs: [{ id: 'item', capabilities: allItemCapabilities() }],
    middleware: opts.middleware,
  });
  return { kernel, engine };
}

describe('Dispatcher.invoke 单一漏斗', () => {
  it('read 能力：返回 output，无 diff，不产生撤销单元', async () => {
    const { kernel, engine } = setup();
    const out = await kernel.invoke<{ value: number | null }>('item.get', { id: 'a' });
    expect(out.ok).toBe(true);
    expect(out.output).toEqual({ value: 1 });
    expect(out.diff).toBeUndefined();
    expect(engine.undoDepth).toBe(0);
  });

  it('write 能力：命令经引擎应用，outcome 带 diff，可撤销', async () => {
    const { kernel, engine } = setup();
    const out = await kernel.invoke('item.set', { id: 'a', value: 5 });
    expect(out.ok).toBe(true);
    expect(out.output).toEqual({ previous: 1 });
    expect(out.diff?.modified[0]).toMatchObject({ id: 'a', after: { value: 5 } });
    expect(engine.undoDepth).toBe(1);
    expect(engine.snapshot().entities.get('a')!.value).toBe(5);
  });

  it('未注册能力 → capability_not_found', async () => {
    const { kernel } = setup();
    const out = await kernel.invoke('nope', {});
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('capability_not_found');
  });

  it('入参校验失败 → validation_failed + 结构化 issues（供 AI 自纠）', async () => {
    const { kernel, engine } = setup();
    const out = await kernel.invoke('item.set', { id: 'a', value: '不是数' });
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('validation_failed');
    expect(out.issues?.length).toBeGreaterThan(0);
    expect(out.issues![0].path).toBe('value');
    expect(engine.undoDepth).toBe(0);
  });

  it('权限不足 → permission_denied；有授权则通过', async () => {
    const { kernel } = setup();
    const denied = await kernel.invoke('item.secret', {}, {
      caller: { entry: 'ai', grantedPermissions: [] },
    });
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe('permission_denied');

    const ok = await kernel.invoke('item.secret', {}, {
      caller: { entry: 'ai', grantedPermissions: ['admin'] },
    });
    expect(ok.ok).toBe(true);

    // 未显式配授权（宿主自身）= 全授
    const host = await kernel.invoke('item.secret', {});
    expect(host.ok).toBe(true);
  });

  it('handler 抛异常 → handler_error，状态零污染', async () => {
    const { kernel, engine } = setup();
    const out = await kernel.invoke('item.boom', {});
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('handler_error');
    expect(out.error?.message).toContain('boom');
    expect(engine.undoDepth).toBe(0);
  });

  it('输出违约 → handler_error + issues', async () => {
    const { kernel } = setup();
    const out = await kernel.invoke('item.badOutput', {});
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('handler_error');
    expect(out.issues?.length).toBeGreaterThan(0);
  });

  it('dryRun：返回将要发生的 diff，但快照不变、撤销栈不长', async () => {
    const { kernel, engine } = setup();
    const before = engine.snapshot();
    const out = await kernel.invoke('item.set', { id: 'a', value: 9 }, { dryRun: true });
    expect(out.ok).toBe(true);
    expect(out.dryRun).toBe(true);
    expect(out.diff?.modified[0]).toMatchObject({ id: 'a', after: { value: 9 } });
    expect(engine.undoDepth).toBe(0);
    expect(engine.snapshot().entities.get('a')!.value).toBe(before.entities.get('a')!.value);
  });

  it('一次 invoke 多命令 → 隐式组折叠为一个撤销单元', async () => {
    const { kernel, engine } = setup();
    const out = await kernel.invoke('item.addTwice', { a: 'x', b: 'y' });
    expect(out.ok).toBe(true);
    expect(out.diff?.added.map((i) => i.id).sort()).toEqual(['x', 'y']);
    expect(engine.undoDepth).toBe(1);
    engine.undo();
    expect(engine.snapshot().entities.has('x')).toBe(false);
    expect(engine.snapshot().entities.has('y')).toBe(false);
  });

  it('txGroupId：写步缓冲进组，commit 前引擎不变', async () => {
    const { kernel, engine } = setup();
    const group = kernel.beginGroup('组测试');
    const out = await kernel.invoke('item.set', { id: 'a', value: 7 }, { txGroupId: group.id });
    expect(out.ok).toBe(true);
    expect(out.diff?.modified[0].after.value).toBe(7);
    expect(engine.snapshot().entities.get('a')!.value).toBe(1);
    expect(engine.undoDepth).toBe(0);

    const res = group.commit();
    expect(res.ok).toBe(true);
    expect(engine.snapshot().entities.get('a')!.value).toBe(7);
    expect(engine.undoDepth).toBe(1);
  });

  it('txGroupId 不存在 → tx_group_not_found', async () => {
    const { kernel } = setup();
    const out = await kernel.invoke('item.set', { id: 'a', value: 7 }, { txGroupId: 'ghost' });
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('tx_group_not_found');
  });

  it('组内 read 能力经 ctx.state 看见已缓冲效果（先看后改）', async () => {
    const { kernel } = setup();
    const group = kernel.beginGroup('投影读');
    await kernel.invoke('item.set', { id: 'a', value: 42 }, { txGroupId: group.id });
    const read = await kernel.invoke<{ value: number | null }>('item.get', { id: 'a' }, {
      txGroupId: group.id,
    });
    expect(read.output).toEqual({ value: 42 });
    group.abort();
    // abort 后引擎不变
    const readAfter = await kernel.invoke<{ value: number | null }>('item.get', { id: 'a' });
    expect(readAfter.output).toEqual({ value: 1 });
  });

  it('中间件洋葱：按序进出，可短路', async () => {
    const order: string[] = [];
    const mw1: Middleware = async (_ctx, next) => {
      order.push('mw1:in');
      const out = await next();
      order.push('mw1:out');
      return out;
    };
    const mw2: Middleware = async (_ctx, next) => {
      order.push('mw2:in');
      const out = await next();
      order.push('mw2:out');
      return out;
    };
    const { kernel } = setup({ middleware: [mw1, mw2] });
    await kernel.invoke('item.get', { id: 'a' });
    expect(order).toEqual(['mw1:in', 'mw2:in', 'mw2:out', 'mw1:out']);
  });

  it('中间件短路：不到 handler', async () => {
    const block: Middleware = async (ctx) => ({
      ok: false,
      capabilityId: ctx.capabilityId,
      error: { code: 'permission_denied', message: '审计拦截' },
      durationMs: 0,
    });
    const { kernel, engine } = setup({ middleware: [block] });
    const out = await kernel.invoke('item.set', { id: 'a', value: 5 });
    expect(out.ok).toBe(false);
    expect(out.error?.message).toBe('审计拦截');
    expect(engine.undoDepth).toBe(0);
  });

  it('invoke:start / invoke:end 事件成对发出（人机同栈观测）', async () => {
    const { kernel } = setup();
    const events: SarEvent<ItemDiff>[] = [];
    kernel.events.on((e) => events.push(e));
    await kernel.invoke('item.set', { id: 'a', value: 3 }, { caller: { entry: 'ai' } });
    const types = events.map((e) => e.type);
    expect(types).toContain('invoke:start');
    expect(types).toContain('invoke:end');
    expect(types).toContain('engine:transaction');
    const start = events.find((e) => e.type === 'invoke:start');
    expect(start && 'caller' in start && start.caller.entry).toBe('ai');
  });
});
