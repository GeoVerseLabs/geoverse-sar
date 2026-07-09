/**
 * journal/audit 流化 sink（目标架构 R2）：每录一条即 append 进 SarStore（双写——
 * 内存查询面照旧，store 是持久化取证面）。核心断言：
 * 1) 双写一致；2) 裸恢复等价（S1「刷新不丢」的存储层验证：read + replay →
 *    终态与撤销粒度一致）；3) sink 故障吞错不断 invoke 主流程。
 */
import { describe, expect, it } from 'vitest';
import {
  createAuditLog,
  createJournal,
  createKernel,
  memoryStore,
  replayJournal,
  type JournalEntry,
  type SarKernel,
  type SarStore,
} from '../src/index';
import {
  allItemCapabilities,
  ItemAlgebra,
  ItemEngine,
  type Item,
  type ItemDiff,
} from './helpers';

function setup(seed: Item[] = []): {
  kernel: SarKernel<Item, ItemDiff>;
  engine: ItemEngine;
} {
  const engine = new ItemEngine(seed);
  const kernel = createKernel<Item, ItemDiff>({
    engine,
    algebra: new ItemAlgebra(),
    packs: [{ id: 'item', capabilities: allItemCapabilities() }],
  });
  return { kernel, engine };
}

describe('journal sink（R2 流化）', () => {
  it('双写：内存 entries 与 store 流逐条一致（含 undo/redo）', async () => {
    const { kernel, engine } = setup();
    const store = memoryStore();
    const journal = createJournal(kernel, { sink: { store } });

    await kernel.invoke('item.add', { items: [{ id: 'x', value: 1 }] });
    await kernel.invoke('item.set', { id: 'x', value: 2 });
    engine.undo();
    engine.redo();
    await journal.flush();

    const rows = await store.read('journal');
    expect(rows.length).toBe(4);
    expect(rows.map((r) => (r.record as JournalEntry<ItemDiff>).op)).toEqual([
      'dispatch',
      'dispatch',
      'undo',
      'redo',
    ]);
    expect(rows.map((r) => r.record)).toEqual(journal.entries());
  });

  it('裸恢复等价（S1 存储层）：read + replay → 终态与 undoDepth 一致', async () => {
    const first = setup();
    const store = memoryStore();
    const journal = createJournal(first.kernel, { sink: { store } });
    await first.kernel.invoke('item.add', {
      items: [
        { id: 'x', value: 1 },
        { id: 'y', value: 5 },
      ],
    });
    await first.kernel.invoke('item.set', { id: 'x', value: 42 });
    first.engine.undo(); // 留一个 redo 位：验证撤销栈行为也复现
    await journal.flush();

    // "刷新"：同构空引擎新内核，从 store 读日志重放
    const second = setup();
    const tail = (await store.read('journal')).map(
      (r) => r.record as JournalEntry<ItemDiff>,
    );
    const replay = replayJournal(second.kernel, tail);
    expect(replay.ok).toBe(true);

    expect(second.engine.snapshot().entities.get('x')!.value).toBe(1);
    expect(second.engine.snapshot().entities.get('y')!.value).toBe(5);
    expect(second.engine.undoDepth).toBe(first.engine.undoDepth);
    expect(second.engine.redoDepth).toBe(first.engine.redoDepth);
    // redo 在恢复后依然可用且结果一致
    expect(second.engine.redo()).toBe(true);
    expect(second.engine.snapshot().entities.get('x')!.value).toBe(42);
  });

  it('sink 写失败：吞错不断主流程，onError 收到', async () => {
    const { kernel, engine } = setup();
    const errors: unknown[] = [];
    const broken: SarStore = {
      ...memoryStore(),
      append: async () => {
        throw new Error('磁盘满');
      },
    };
    const journal = createJournal(kernel, {
      sink: { store: broken, onError: (e) => errors.push(e) },
    });

    const out = await kernel.invoke('item.add', { items: [{ id: 'x', value: 1 }] });
    await journal.flush();
    expect(out.ok).toBe(true);
    expect(engine.snapshot().entities.has('x')).toBe(true);
    expect(errors).toHaveLength(1);
    expect(journal.size).toBe(1); // 内存录制不受 sink 故障影响
  });

  it('无 sink 时 flush 立即返回（兼容旧用法）', async () => {
    const { kernel } = setup();
    const journal = createJournal(kernel);
    await expect(journal.flush()).resolves.toBeUndefined();
  });
});

describe('audit sink（R2 流化）', () => {
  it('每次 invoke 双写进 store（含失败调用），流名可定制', async () => {
    const engine = new ItemEngine([{ id: 'a', value: 1 }]);
    const store = memoryStore();
    const audit = createAuditLog({ sink: { store, stream: 'audit-2026' } });
    const kernel = createKernel<Item, ItemDiff>({
      engine,
      algebra: new ItemAlgebra(),
      packs: [{ id: 'item', capabilities: allItemCapabilities() }],
      middleware: [audit.middleware],
    });

    await kernel.invoke('item.set', { id: 'a', value: 2 });
    await kernel.invoke('item.boom', {});
    await audit.flush();

    const rows = await store.read('audit-2026');
    expect(rows.length).toBe(2);
    const [okEntry, failEntry] = rows.map(
      (r) => r.record as { capabilityId: string; ok: boolean; entry: string },
    );
    expect(okEntry).toMatchObject({
      capabilityId: 'item.set',
      ok: true,
      entry: 'program',
    });
    expect(failEntry).toMatchObject({ capabilityId: 'item.boom', ok: false });
    // 环形内存面与 store 面同源
    expect(audit.entries().length).toBe(2);
  });
});
