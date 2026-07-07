import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createAuditLog,
  createJournal,
  createKernel,
  replayJournal,
  type Capability,
  type Middleware,
  type SarKernel,
} from '../src/index';
import {
  allItemCapabilities,
  ItemAlgebra,
  ItemEngine,
  SetValueCommand,
  type Item,
  type ItemDiff,
} from './helpers';

function setup(opts: { middleware?: Middleware[]; seed?: Item[]; extra?: Capability[] } = {}): {
  kernel: SarKernel<Item, ItemDiff>;
  engine: ItemEngine;
} {
  const engine = new ItemEngine(opts.seed ?? [{ id: 'a', value: 1 }]);
  const kernel = createKernel<Item, ItemDiff>({
    engine,
    algebra: new ItemAlgebra(),
    packs: [{ id: 'item', capabilities: [...allItemCapabilities(), ...(opts.extra ?? [])] }],
    middleware: opts.middleware,
  });
  return { kernel, engine };
}

describe('AbortSignal（M4 治理）', () => {
  it('已中止的 signal → 错误码 aborted，handler 不执行、状态不动', async () => {
    const { kernel, engine } = setup();
    const aborter = new AbortController();
    aborter.abort();
    const out = await kernel.invoke('item.set', { id: 'a', value: 9 }, { signal: aborter.signal });
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('aborted');
    expect(engine.snapshot().entities.get('a')!.value).toBe(1);
    expect(engine.undoDepth).toBe(0);
  });

  it('handler 执行期间中止 → 写路由前兜底，变更不落地；ctx.signal 可协作检查', async () => {
    const aborter = new AbortController();
    let sawSignal: AbortSignal | undefined;
    const slow: Capability<Record<string, never>, Record<string, never>, Item, ItemDiff> = {
      id: 'item.slow',
      title: '慢写',
      description: '测试替身：handler 内主动 abort，验证写路由前兜底不落地。',
      category: 'item',
      kind: 'write',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      handler: async (ctx) => {
        sawSignal = ctx.signal;
        aborter.abort(); // 模拟 handler await 期间外部取消
        return { output: {}, commands: [new SetValueCommand('a', 99)] };
      },
    };
    const { kernel, engine } = setup({ extra: [slow as Capability] });
    const out = await kernel.invoke('item.slow', {}, { signal: aborter.signal });
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('aborted');
    expect(sawSignal).toBe(aborter.signal); // handler 能拿到信号协作取消
    expect(engine.snapshot().entities.get('a')!.value).toBe(1);
    expect(engine.undoDepth).toBe(0);
  });
});

describe('createAuditLog（审计中间件）', () => {
  it('每次 invoke 入账：主体归因/结果/dryRun/入参；失败与 permission_denied 也可见', async () => {
    const audit = createAuditLog();
    const { kernel } = setup({ middleware: [audit.middleware] });

    await kernel.invoke('item.set', { id: 'a', value: 5 }, { caller: { entry: 'ai', id: 'bot-1' } });
    await kernel.invoke('item.get', { id: 'a' }, { dryRun: false });
    await kernel.invoke('item.secret', {}, { caller: { entry: 'agent', grantedPermissions: [] } });
    await kernel.invoke('item.set', { id: 'a', value: 6 }, { dryRun: true });
    await kernel.invoke('nope', {});

    expect(audit.size).toBe(5);
    const [set, get, denied, dry, missing] = audit.entries();
    expect(set).toMatchObject({
      capabilityId: 'item.set',
      kind: 'write',
      entry: 'ai',
      callerId: 'bot-1',
      ok: true,
      hasDiff: true,
      input: { id: 'a', value: 5 },
    });
    expect(get).toMatchObject({ capabilityId: 'item.get', ok: true, hasDiff: false });
    expect(denied).toMatchObject({
      entry: 'agent',
      ok: false,
      errorCode: 'permission_denied',
    });
    expect(dry).toMatchObject({ dryRun: true, ok: true, hasDiff: true });
    // 未注册能力也走完整漏斗 → 审计可见（模型幻觉工具名归因）
    expect(missing).toMatchObject({ capabilityId: 'nope', errorCode: 'capability_not_found' });

    // 过滤 + 持久化往返
    expect(audit.entries({ ok: false })).toHaveLength(2);
    expect(audit.entries({ entry: 'ai' })).toHaveLength(1);
    const json = audit.toJSON();
    const restored = createAuditLog();
    restored.load(json);
    expect(restored.entries()).toEqual(audit.entries());
  });

  it('环形上限丢最旧；captureInput=false 不留入参', async () => {
    const audit = createAuditLog({ maxEntries: 2, captureInput: false });
    const { kernel } = setup({ middleware: [audit.middleware] });
    await kernel.invoke('item.get', { id: 'a' });
    await kernel.invoke('item.get', { id: 'a' });
    await kernel.invoke('item.set', { id: 'a', value: 2 });
    expect(audit.size).toBe(2);
    expect(audit.entries()[1].capabilityId).toBe('item.set');
    expect(audit.entries()[1].input).toBeUndefined();
  });
});

describe('createJournal / replayJournal（工作流持久化/回放）', () => {
  it('录 dispatch/undo/redo → JSON 往返 → 同 seed 新内核重放：终态与撤销粒度一致', async () => {
    const seed: Item[] = [{ id: 'a', value: 1 }];
    const { kernel, engine } = setup({ seed });
    const journal = createJournal(kernel);

    await kernel.invoke('item.set', { id: 'a', value: 5 });
    await kernel.invoke('item.addTwice', { a: 'x', b: 'y' }); // 隐式组 → 单条事务
    engine.undo();
    engine.redo();
    await kernel.invoke('item.set', { id: 'x', value: 7 });
    journal.stop();

    expect(journal.entries().map((e) => e.op)).toEqual([
      'dispatch',
      'dispatch',
      'undo',
      'redo',
      'dispatch',
    ]);

    // 回放：同 seed 全新内核
    const fresh = setup({ seed });
    const res = replayJournal(fresh.kernel, journal.toJSON());
    expect(res).toEqual({ ok: true, applied: 5 });
    expect(fresh.engine.snapshot().entities).toEqual(engine.snapshot().entities);
    // 撤销粒度复现：3 个 dispatch 单元（addTwice 折叠为 1）
    expect(fresh.engine.undoDepth).toBe(engine.undoDepth);
    fresh.engine.undo();
    expect(fresh.engine.snapshot().entities.get('x')!.value).toBe(1);
  });

  it('工作流宏撤销在录制时已折叠：回放后一次 undo 全回退', async () => {
    const { kernel } = setup();
    const journal = createJournal(kernel);
    const group = kernel.beginGroup('组合操作');
    await kernel.invoke('item.set', { id: 'a', value: 10 }, { txGroupId: group.id });
    await kernel.invoke('item.add', { items: [{ id: 'b', value: 2 }] }, { txGroupId: group.id });
    expect(group.commit().ok).toBe(true);
    journal.stop();

    // 整组只出一条事务
    expect(journal.entries()).toHaveLength(1);

    const fresh = setup();
    expect(replayJournal(fresh.kernel, journal.entries()).ok).toBe(true);
    expect(fresh.engine.undoDepth).toBe(1);
    fresh.engine.undo();
    expect(fresh.engine.snapshot().entities.get('a')!.value).toBe(1);
    expect(fresh.engine.snapshot().entities.has('b')).toBe(false);
  });

  it('起点不一致 → 首错即停并报出条目位置', async () => {
    const { kernel } = setup();
    const journal = createJournal(kernel);
    await kernel.invoke('item.set', { id: 'a', value: 5 });
    journal.stop();

    const empty = setup({ seed: [] }); // 缺 seed 实体 a
    const res = replayJournal(empty.kernel, journal.toJSON());
    expect(res.ok).toBe(false);
    expect(res.applied).toBe(0);
    expect(res.error).toContain('第 1 条');
  });
});
