/**
 * SarStore 契约测试（目标架构 R1）：同一套断言跑 memory / idb / file 三适配器——
 * "测试绿了换适配器不翻车"是端口成立的判据。持久化适配器另测重开恢复；
 * file 适配器另测崩溃一致性（末尾残行丢弃 + 完整行损坏报错）。
 */
import 'fake-indexeddb/auto';
import { mkdtemp, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { memoryStore, type SarStore } from '../src/store';
import { idbStore } from '../src/store-idb';
import { fileStore } from '../src/store-file';

interface AdapterHarness {
  name: string;
  /** 每用例一个隔离的底层存储；open 可对同一底层重复调用（重开）。 */
  create(): Promise<{ open(): SarStore }>;
  persistent: boolean;
}

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const fn of cleanups) await fn();
});

let idbSerial = 0;

const adapters: AdapterHarness[] = [
  {
    name: 'memoryStore',
    persistent: false,
    create: async () => {
      const store = memoryStore();
      return { open: () => store };
    },
  },
  {
    name: 'idbStore',
    persistent: true,
    create: async () => {
      const name = `sar-store-test-${++idbSerial}`;
      return { open: () => idbStore(name) };
    },
  },
  {
    name: 'fileStore',
    persistent: true,
    create: async () => {
      const dir = await mkdtemp(join(tmpdir(), 'sar-store-'));
      cleanups.push(() => rm(dir, { recursive: true, force: true }));
      return { open: () => fileStore(dir, { fsync: false }) };
    },
  },
];

describe.each(adapters)('SarStore 契约：$name', (harness) => {
  it('append 分配从 1 起的单调 seq，read 按序返回', async () => {
    const store = (await harness.create()).open();
    expect(await store.append('journal', [{ op: 'a' }, { op: 'b' }])).toBe(2);
    expect(await store.append('journal', [{ op: 'c' }])).toBe(3);
    const rows = await store.read('journal');
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(rows.map((r) => (r.record as { op: string }).op)).toEqual(['a', 'b', 'c']);
    await store.close();
  });

  it('流之间 seq 独立', async () => {
    const store = (await harness.create()).open();
    await store.append('journal', ['j1']);
    expect(await store.append('audit', ['a1', 'a2'])).toBe(2);
    expect((await store.read('journal')).length).toBe(1);
    await store.close();
  });

  it('read 支持 fromSeq（含）与 limit', async () => {
    const store = (await harness.create()).open();
    await store.append('s', ['a', 'b', 'c', 'd']);
    expect((await store.read('s', { fromSeq: 3 })).map((r) => r.seq)).toEqual([3, 4]);
    expect((await store.read('s', { fromSeq: 2, limit: 2 })).map((r) => r.seq)).toEqual([
      2, 3,
    ]);
    expect(await store.read('s', { fromSeq: 99 })).toEqual([]);
    await store.close();
  });

  it('空批 append 返回当前 lastSeq 且不产生写入', async () => {
    const store = (await harness.create()).open();
    expect(await store.append('s', [])).toBe(0);
    await store.append('s', ['a']);
    expect(await store.append('s', [])).toBe(1);
    expect((await store.read('s')).length).toBe(1);
    await store.close();
  });

  it('truncate 删头部保尾部，之后 append 编号不回退', async () => {
    const store = (await harness.create()).open();
    await store.append('s', ['a', 'b', 'c', 'd']);
    await store.truncate('s', 2);
    expect((await store.read('s')).map((r) => r.seq)).toEqual([3, 4]);
    expect(await store.append('s', ['e'])).toBe(5);
    await store.close();
  });

  it('全量 truncate 后 append 仍继续编号（seq 不复用）', async () => {
    const store = (await harness.create()).open();
    await store.append('s', ['a', 'b', 'c']);
    await store.truncate('s', 3);
    expect(await store.read('s')).toEqual([]);
    expect(await store.append('s', ['d'])).toBe(4);
    await store.close();
  });

  it('快照整体替换：put/get/覆盖/缺省 undefined', async () => {
    const store = (await harness.create()).open();
    expect(await store.getSnapshot('nope')).toBeUndefined();
    await store.putSnapshot('entities', { list: [1, 2] });
    expect(await store.getSnapshot('entities')).toEqual({ list: [1, 2] });
    await store.putSnapshot('entities', { list: [3] });
    expect(await store.getSnapshot('entities')).toEqual({ list: [3] });
    await store.close();
  });

  it('JSON 值语义：写入后改原对象不串改存储；undefined 属性剔除', async () => {
    const store = (await harness.create()).open();
    const record: { a: number; b?: string; c: undefined } = {
      a: 1,
      b: 'x',
      c: undefined,
    };
    await store.append('s', [record]);
    record.a = 999;
    delete record.b;
    const [row] = await store.read('s');
    expect(row.record).toEqual({ a: 1, b: 'x' }); // c: undefined 被 JSON 语义剔除
    await store.close();
  });

  it('close 后一切操作拒绝，close 幂等', async () => {
    const store = (await harness.create()).open();
    await store.append('s', ['a']);
    await store.close();
    await store.close();
    await expect(store.append('s', ['b'])).rejects.toThrow('已关闭');
    await expect(store.read('s')).rejects.toThrow('已关闭');
    await expect(store.putSnapshot('k', 1)).rejects.toThrow('已关闭');
  });

  if (harness.persistent) {
    it('重开恢复：流内容、续号、快照都在（恢复等价的存储层前提）', async () => {
      const backing = await harness.create();
      const first = backing.open();
      await first.append('journal', [{ op: 'a' }, { op: 'b' }]);
      await first.putSnapshot('meta', { checkpointSeq: 0 });
      await first.close();

      const second = backing.open();
      expect((await second.read('journal')).map((r) => r.seq)).toEqual([1, 2]);
      expect(await second.getSnapshot('meta')).toEqual({ checkpointSeq: 0 });
      expect(await second.append('journal', [{ op: 'c' }])).toBe(3);
      await second.close();
    });

    it('全量 truncate → 重开 → append 续号（lastSeq 持久化）', async () => {
      const backing = await harness.create();
      const first = backing.open();
      await first.append('journal', ['a', 'b', 'c']);
      await first.truncate('journal', 3);
      await first.close();

      const second = backing.open();
      expect(await second.read('journal')).toEqual([]);
      expect(await second.append('journal', ['d'])).toBe(4);
      await second.close();
    });
  }
});

describe('fileStore 崩溃一致性', () => {
  async function makeDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'sar-store-crash-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    return dir;
  }

  it('末尾无换行残行：装载时丢弃 + 告警 + 后续 append 不黏连', async () => {
    const dir = await makeDir();
    const first = fileStore(dir, { fsync: false });
    await first.append('journal', [{ op: 'a' }, { op: 'b' }]);
    await first.close();
    // 模拟写入中途断电：追加半条 JSON 且无换行
    await appendFile(join(dir, 'streams', 'journal.jsonl'), '{"seq":3,"rec', 'utf8');

    const warns: string[] = [];
    const second = fileStore(dir, { fsync: false, onWarn: (m) => warns.push(m) });
    expect((await second.read('journal')).map((r) => r.seq)).toEqual([1, 2]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('残行');
    expect(await second.append('journal', [{ op: 'c' }])).toBe(3);
    await second.close();

    // 再次冷开：文件未被残行污染，三条完整可读
    const third = fileStore(dir, { fsync: false });
    expect((await third.read('journal')).map((r) => r.seq)).toEqual([1, 2, 3]);
    await third.close();
  });

  it('完整行损坏（非末尾残行）＝存储损坏，装载报错提示用快照恢复', async () => {
    const dir = await makeDir();
    const first = fileStore(dir, { fsync: false });
    await first.append('journal', [{ op: 'a' }]);
    await first.close();
    await appendFile(
      join(dir, 'streams', 'journal.jsonl'),
      'not-json\n{"seq":3}\n',
      'utf8',
    );

    const second = fileStore(dir, { fsync: false });
    await expect(second.read('journal')).rejects.toThrow('存储已损坏');
    await second.close();
  });

  it('流名/快照键做文件名安全编码（Windows 非法字符不落盘）', async () => {
    const dir = await makeDir();
    const store = fileStore(dir, { fsync: false });
    await store.append('conv:2026/07*', ['x']);
    await store.putSnapshot('ws:main', { ok: true });
    expect((await store.read('conv:2026/07*')).length).toBe(1);
    expect(await store.getSnapshot('ws:main')).toEqual({ ok: true });
    await store.close();
  });
});

describe('idbStore 环境防呆', () => {
  it('无 indexedDB 环境直接报错并指路 fileStore', () => {
    expect(() =>
      idbStore('x', { indexedDB: undefined as unknown as IDBFactory }),
    ).not.toThrow();
    // 注：显式传 undefined 会回退 globalThis（测试环境已由 fake-indexeddb/auto 提供），
    // 真正的"无 IDB"分支由下面的构造校验覆盖：
    const saved = globalThis.indexedDB;
    // @ts-expect-error 故意抹掉全局
    delete globalThis.indexedDB;
    try {
      expect(() => idbStore('x')).toThrow('fileStore');
    } finally {
      globalThis.indexedDB = saved;
    }
  });
});
