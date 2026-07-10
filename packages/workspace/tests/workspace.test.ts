/**
 * openWorkspace（R4）：恢复等价 / checkpoint 撤销地平线 / 自动 checkpoint /
 * seq 断档校验 / 格式与引擎类型校验 / 只读模式 / conversations 快照 /
 * runtime.checkpoint 能力接线。引擎用 engine-memory（devDep，仅测试）。
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { memoryStore, type SarStore, type StoreRecord } from '@geoverse-sar/kernel';
import { InMemoryStateEngine, RecordDiffAlgebra } from '@geoverse-sar/engine-memory';
import { createRecordsPack } from '@geoverse-sar/capabilities-records';
import { openWorkspace, type Workspace } from '../src/index';

type Rec = { id: string; x: number; y: number; props: Record<string, unknown> };

function open(
  store: SarStore,
  opts: Parameters<typeof openWorkspace>[0]['persist'] = {},
) {
  return openWorkspace({
    store,
    engine: (seed?: unknown[]) => new InMemoryStateEngine((seed ?? []) as Rec[]),
    algebra: new RecordDiffAlgebra(),
    packs: [createRecordsPack()],
    engineKind: 'records',
    persist: opts,
    closeStore: false, // 测试要对同一 memoryStore 重开
    onWarn: () => {},
  });
}

async function addRecord(ws: Workspace<unknown, unknown>, x: number, y: number) {
  const out = await ws.kernel.invoke('records.add', { records: [{ x, y }] });
  expect(out.ok).toBe(true);
  return out;
}

const entityCount = (ws: Workspace<unknown, unknown>) =>
  ws.kernel.engine.snapshot().entities.size;

describe('openWorkspace 恢复等价', () => {
  it('首开：空工作区 + meta 落盘；编辑→close→重开恢复实体与撤销粒度', async () => {
    const store = memoryStore();
    const ws1 = await open(store);
    expect(ws1.restored).toEqual({ fromSnapshot: false, replayed: 0 });

    await addRecord(ws1, 1, 1);
    await addRecord(ws1, 2, 2);
    ws1.kernel.engine.undo(); // 留 redo 位
    const before = {
      count: entityCount(ws1),
      undoDepth: ws1.kernel.engine.undoDepth,
      redoDepth: ws1.kernel.engine.redoDepth,
    };
    await ws1.close();

    // close 默认 checkpoint → 重开走快照，journal 已截断
    const ws2 = await open(store);
    expect(ws2.restored.fromSnapshot).toBe(true);
    expect(ws2.restored.replayed).toBe(0);
    expect(entityCount(ws2)).toBe(before.count);
    // 撤销地平线 = checkpoint：checkpoint 之前的历史不可撤销（明示语义）
    expect(ws2.kernel.engine.undoDepth).toBe(0);
    await ws2.close();
  });

  it('不 checkpoint 关闭：重开经 journal tail 重放，undo/redo 栈完整复现', async () => {
    const store = memoryStore();
    const ws1 = await open(store, { checkpointOnClose: false });
    await addRecord(ws1, 1, 1);
    await addRecord(ws1, 2, 2);
    ws1.kernel.engine.undo();
    const before = {
      count: entityCount(ws1),
      undoDepth: ws1.kernel.engine.undoDepth,
      redoDepth: ws1.kernel.engine.redoDepth,
    };
    await ws1.close();

    const ws2 = await open(store, { checkpointOnClose: false });
    expect(ws2.restored.replayed).toBe(3); // add + add + undo
    expect(entityCount(ws2)).toBe(before.count);
    expect(ws2.kernel.engine.undoDepth).toBe(before.undoDepth);
    expect(ws2.kernel.engine.redoDepth).toBe(before.redoDepth);
    expect(ws2.kernel.engine.redo()).toBe(true);
    expect(entityCount(ws2)).toBe(2);
    await ws2.close();
  });

  it('checkpoint 后继续编辑再崩溃（不 close）：重开=快照+增量 tail', async () => {
    const store = memoryStore();
    const ws1 = await open(store, { checkpointOnClose: false });
    await addRecord(ws1, 1, 1);
    const { checkpointSeq } = await ws1.checkpoint();
    expect(checkpointSeq).toBe(1);
    await addRecord(ws1, 2, 2);
    await ws1.journal?.flush();
    // 模拟崩溃：不调 ws1.close()，直接重开同一 store

    const ws2 = await open(store, { checkpointOnClose: false });
    expect(ws2.restored.fromSnapshot).toBe(true);
    expect(ws2.restored.replayed).toBe(1); // 只重放 checkpoint 之后的增量
    expect(entityCount(ws2)).toBe(2);
    expect(ws2.kernel.engine.undoDepth).toBe(1); // 地平线=checkpoint
    await ws2.close();
  });
});

describe('checkpoint 语义', () => {
  it('截断 journal 头部（keepTail=0 默认），流内只剩位点之后的条目', async () => {
    const store = memoryStore();
    const ws = await open(store, { checkpointOnClose: false });
    await addRecord(ws, 1, 1);
    await addRecord(ws, 2, 2);
    await ws.checkpoint();
    await addRecord(ws, 3, 3);
    await ws.journal?.flush();
    const rows: StoreRecord[] = await store.read('journal');
    expect(rows.map((r) => r.seq)).toEqual([3]); // 1/2 已归档，3 是增量
    await ws.close();
  });

  it('自动 checkpoint：everyTx 达到即触发（快照落盘、journal 回落）', async () => {
    const store = memoryStore();
    const ws = await open(store, {
      checkpoint: { everyTx: 2 },
      checkpointOnClose: false,
    });
    await addRecord(ws, 1, 1);
    await addRecord(ws, 2, 2); // 第 2 个事务 → 触发自动 checkpoint
    await new Promise((r) => setTimeout(r, 0)); // 让异步 checkpoint 落定
    const metaAfter = await store.getSnapshot<{ checkpointSeq: number }>('workspace');
    expect(metaAfter?.checkpointSeq).toBe(2);
    expect(await store.read('journal')).toEqual([]);
    await ws.close();
  });

  it('runtime.checkpoint 能力接线：invoke 即保存进度', async () => {
    const store = memoryStore();
    const ws = await open(store, { checkpointOnClose: false });
    await addRecord(ws, 1, 1);
    const out = await ws.kernel.invoke('runtime.checkpoint', {});
    expect(out.ok).toBe(true);
    expect(out.output).toEqual({ checkpointSeq: 1 });
    expect((await store.getSnapshot<unknown[]>('entities'))!.length).toBe(1);
    await ws.close();
  });
});

describe('装载校验', () => {
  it('journal seq 断档 → 打开报错并指路快照恢复', async () => {
    const store = memoryStore();
    const ws1 = await open(store, { checkpointOnClose: false });
    await addRecord(ws1, 1, 1);
    await addRecord(ws1, 2, 2);
    await ws1.close();
    await store.truncate('journal', 1); // 人为掐掉头部制造断档（meta.checkpointSeq 仍是 0）

    await expect(open(store)).rejects.toThrow('断档');
  });

  it('引擎类型不匹配 → 拒绝打开', async () => {
    const store = memoryStore();
    const ws1 = await open(store);
    await ws1.close();
    await expect(
      openWorkspace({
        store,
        engine: () => new InMemoryStateEngine([]),
        algebra: new RecordDiffAlgebra(),
        engineKind: 'geo',
        closeStore: false,
      }),
    ).rejects.toThrow('引擎类型不匹配');
  });

  it('格式版本不支持 → 拒绝打开并提示迁移', async () => {
    const store = memoryStore();
    await store.putSnapshot('workspace', {
      formatVersion: 2,
      engineKind: 'records',
      checkpointSeq: 0,
    });
    await expect(open(store)).rejects.toThrow('格式版本');
  });

  it('传引擎实例：禁用恢复退化纯录制，告警提示', async () => {
    const store = memoryStore();
    const ws1 = await open(store, { checkpointOnClose: false });
    await addRecord(ws1, 1, 1);
    await ws1.close();

    const warns: string[] = [];
    const ws2 = await openWorkspace({
      store,
      engine: new InMemoryStateEngine([]),
      algebra: new RecordDiffAlgebra(),
      packs: [createRecordsPack()],
      engineKind: 'records',
      persist: { checkpointOnClose: false },
      closeStore: false,
      onWarn: (m) => warns.push(m),
    });
    expect(ws2.restored).toEqual({ fromSnapshot: false, replayed: 0 });
    expect(entityCount(ws2)).toBe(0); // 未恢复
    expect(warns.some((m) => m.includes('纯录制'))).toBe(true);
    await ws2.close();
  });
});

describe('Web Locks 单写者', () => {
  function fakeLocks(): LockManager {
    const held = new Set<string>();
    return {
      async request(name: string, opts: unknown, cb: (lock: Lock | null) => unknown) {
        if (held.has(name)) return cb(null);
        held.add(name);
        const done = cb({ name, mode: 'exclusive' } as Lock);
        void Promise.resolve(done).finally(() => held.delete(name));
        return done;
      },
    } as unknown as LockManager;
  }

  it('后开实例拿不到锁 → 只读：写被拒、read 可用；先开实例 close 后可再获锁', async () => {
    // node 的 globalThis.navigator 是只读 getter → 走 vitest stubGlobal
    vi.stubGlobal('navigator', { locks: fakeLocks() });
    try {
      const store1 = memoryStore();
      const store2 = memoryStore();
      const base = {
        engine: () => new InMemoryStateEngine([]),
        algebra: new RecordDiffAlgebra(),
        packs: [createRecordsPack()],
        engineKind: 'records',
        lock: 'ws-lock-test',
        onWarn: () => {},
      };
      const writer = await openWorkspace({ ...base, store: store1 });
      expect(writer.readOnly).toBe(false);

      const reader = await openWorkspace({ ...base, store: store2 });
      expect(reader.readOnly).toBe(true);
      const write = await reader.kernel.invoke('records.add', {
        records: [{ x: 1, y: 1 }],
      });
      expect(write.ok).toBe(false);
      expect(write.error?.code).toBe('permission_denied');
      const read = await reader.kernel.invoke('runtime.stats', {});
      expect(read.ok).toBe(true);
      await expect(reader.checkpoint()).rejects.toThrow('只读');

      await reader.close();
      await writer.close();
      const again = await openWorkspace({ ...base, store: memoryStore() });
      expect(again.readOnly).toBe(false);
      await again.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('conversations 快照', () => {
  it('按会话 id 存取，close→重开仍在', async () => {
    const store = memoryStore();
    const ws1 = await open(store);
    await ws1.saveConversation('chat-1', [{ role: 'user', text: '你好' }]);
    await ws1.close();

    const ws2 = await open(store);
    expect(await ws2.loadConversation('chat-1')).toEqual([
      { role: 'user', text: '你好' },
    ]);
    expect(await ws2.loadConversation('ghost')).toBeUndefined();
    await ws2.close();
  });
});

describe('ws.client（T12/R5 远程化切面）', () => {
  it('catalog/invoke 与 kernel 平价；runtime.stats 经切面可用', async () => {
    const store = memoryStore();
    const ws = await open(store);

    const catalog = await ws.client.catalog();
    expect(catalog.map((d) => d.id)).toEqual(ws.kernel.describeAll().map((d) => d.id));
    expect(catalog.some((d) => d.id === 'runtime.stats')).toBe(true);

    const out = await ws.client.invoke('records.add', { records: [{ x: 1, y: 2 }] });
    expect(out.ok).toBe(true);
    const stats = await ws.client.invoke<{ entityCount: number }>('runtime.stats');
    expect(stats.ok).toBe(true);
    expect(stats.output?.entityCount).toBe(1);
    await ws.close();
  });

  it('clientCaller 绑定身份：白名单裁剪目录且硬调被拒', async () => {
    const store = memoryStore();
    const ws = await openWorkspace({
      store,
      engine: (seed?: unknown[]) => new InMemoryStateEngine((seed ?? []) as Rec[]),
      algebra: new RecordDiffAlgebra(),
      packs: [createRecordsPack()],
      engineKind: 'records',
      closeStore: false,
      clientCaller: { entry: 'ui', grantedPermissions: [] },
      onWarn: () => {},
    });
    ws.kernel.registry.register({
      id: 'records.locked',
      title: '受限',
      description: '需要 admin 权限的测试能力。',
      category: 'records',
      kind: 'read',
      permissions: ['admin'],
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      handler: async () => ({ output: {} }),
    });

    const catalog = await ws.client.catalog();
    expect(catalog.some((d) => d.id === 'records.locked')).toBe(false);
    const denied = await ws.client.invoke('records.locked');
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe('permission_denied');
    await ws.close();
  });
});
