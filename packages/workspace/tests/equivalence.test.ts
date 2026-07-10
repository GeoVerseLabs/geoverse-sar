/**
 * 恢复等价 / 回放等价矩阵（T6）：同一套断言跑 memory / idb / file 三适配器——
 * 工作区级别验证「换存储介质，恢复行为不变」（S2 验收）+ checkpoint 后
 * journal 体积回落。
 */
import 'fake-indexeddb/auto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SarStore } from '@geoverse-sar/kernel';
import { idbStore } from '@geoverse-sar/kernel/store-idb';
import { fileStore } from '@geoverse-sar/kernel/store-file';
import { InMemoryStateEngine, RecordDiffAlgebra } from '@geoverse-sar/engine-memory';
import { createRecordsPack } from '@geoverse-sar/capabilities-records';
import { openWorkspace } from '../src/index';

type Rec = { id: string; x: number; y: number; props: Record<string, unknown> };

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const fn of cleanups) await fn();
});

// memoryStore 不持久（重开即空），矩阵只跑两个持久化适配器；
// 内存版恢复行为由 workspace.test.ts 覆盖（同实例不 close）。
let serial = 0;
const backings: { name: string; create(): Promise<() => SarStore> }[] = [
  {
    name: 'idbStore',
    create: async () => {
      const name = `sar-ws-eq-${++serial}`;
      return () => idbStore(name);
    },
  },
  {
    name: 'fileStore',
    create: async () => {
      const dir = await mkdtemp(join(tmpdir(), 'sar-ws-eq-'));
      cleanups.push(() => rm(dir, { recursive: true, force: true }));
      return () => fileStore(dir, { fsync: false });
    },
  },
];

function open(store: SarStore, checkpointOnClose: boolean) {
  return openWorkspace({
    store,
    engine: (seed?: unknown[]) => new InMemoryStateEngine((seed ?? []) as Rec[]),
    algebra: new RecordDiffAlgebra(),
    packs: [createRecordsPack()],
    engineKind: 'records',
    persist: { checkpointOnClose },
    closeStore: false,
    onWarn: () => {},
  });
}

describe.each(backings)('工作区恢复等价矩阵：$name', (backing) => {
  it('编辑→undo→关闭（不 checkpoint）→重开：终态/撤销栈/redo 全等', async () => {
    const openStore = await backing.create();
    const s1 = openStore();
    const ws1 = await open(s1, false);
    await ws1.kernel.invoke('records.add', {
      records: [
        { x: 1, y: 1 },
        { x: 2, y: 2 },
      ],
    });
    await ws1.kernel.invoke('records.add', { records: [{ x: 3, y: 3 }] });
    ws1.kernel.engine.undo();
    const before = {
      count: ws1.kernel.engine.snapshot().entities.size,
      undoDepth: ws1.kernel.engine.undoDepth,
      redoDepth: ws1.kernel.engine.redoDepth,
    };
    await ws1.close();
    await s1.close();

    const s2 = openStore();
    const ws2 = await open(s2, false);
    expect(ws2.restored.replayed).toBe(3);
    expect(ws2.kernel.engine.snapshot().entities.size).toBe(before.count);
    expect(ws2.kernel.engine.undoDepth).toBe(before.undoDepth);
    expect(ws2.kernel.engine.redoDepth).toBe(before.redoDepth);
    expect(ws2.kernel.engine.redo()).toBe(true);
    expect(ws2.kernel.engine.snapshot().entities.size).toBe(3);
    await ws2.close();
    await s2.close();
  });

  it('checkpoint 关闭→重开走快照且 journal 体积回落', async () => {
    const openStore = await backing.create();
    const s1 = openStore();
    const ws1 = await open(s1, true);
    await ws1.kernel.invoke('records.add', { records: [{ x: 1, y: 1 }] });
    await ws1.kernel.invoke('records.add', { records: [{ x: 2, y: 2 }] });
    await ws1.close(); // checkpointOnClose → 快照 + 截断
    expect(await s1.read('journal')).toEqual([]); // 体积回落（S2 验收）
    await s1.close();

    const s2 = openStore();
    const ws2 = await open(s2, true);
    expect(ws2.restored.fromSnapshot).toBe(true);
    expect(ws2.restored.replayed).toBe(0);
    expect(ws2.kernel.engine.snapshot().entities.size).toBe(2);
    await ws2.close();
    await s2.close();
  });
});
