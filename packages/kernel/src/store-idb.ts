/**
 * IndexedDB 适配器（子导出 `@geoverse-sar/kernel/store-idb`，浏览器宿主）。
 * 单 DB 三 objectStore：
 * - `streams`：keyPath [stream, seq] 复合键——read 用键区间、truncate 用范围删除；
 * - `seqs`：stream → lastSeq——seq 分配与记录写入同一事务，truncate 清空流后编号不回退；
 * - `snapshots`：key → 整体替换值。
 * 值先过 jsonClone 归一（与 memory/file 同一 JSON 值语义，而非结构化克隆语义）。
 */
import { assertOpen, jsonClone, type SarStore, type StoreRecord } from './store';

export interface IdbStoreOptions {
  /** 注入 IDBFactory（测试用 fake-indexeddb；缺省 globalThis.indexedDB）。 */
  indexedDB?: IDBFactory;
}

const DB_VERSION = 1;

function requestOf<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 请求失败'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务中止'));
  });
}

interface StreamRow {
  stream: string;
  seq: number;
  record: unknown;
}

export function idbStore(name: string, options?: IdbStoreOptions): SarStore {
  const factory = options?.indexedDB ?? globalThis.indexedDB;
  if (!factory) {
    throw new Error(
      '当前环境无 indexedDB——Node 宿主请改用 fileStore（store-file 子导出）',
    );
  }
  let dbPromise: Promise<IDBDatabase> | undefined;
  let closed = false;

  function open(): Promise<IDBDatabase> {
    dbPromise ??= new Promise((resolve, reject) => {
      const req = factory.open(name, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('streams')) {
          db.createObjectStore('streams', { keyPath: ['stream', 'seq'] });
        }
        if (!db.objectStoreNames.contains('seqs')) db.createObjectStore('seqs');
        if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error(`打开 IndexedDB "${name}" 失败`));
    });
    return dbPromise;
  }

  const streamRange = (stream: string, fromSeq: number, uptoSeq: number) =>
    IDBKeyRange.bound([stream, fromSeq], [stream, uptoSeq]);

  return {
    async append(stream, records) {
      assertOpen(closed, 'idb');
      const db = await open();
      const tx = db.transaction(['streams', 'seqs'], 'readwrite');
      const seqsStore = tx.objectStore('seqs');
      let seq = ((await requestOf(seqsStore.get(stream))) as number | undefined) ?? 0;
      if (records.length === 0) return seq;
      const streamsStore = tx.objectStore('streams');
      for (const record of records) {
        const row: StreamRow = { stream, seq: ++seq, record: jsonClone(record) };
        streamsStore.put(row);
      }
      seqsStore.put(seq, stream);
      await txDone(tx);
      return seq;
    },
    async read(stream, opts) {
      assertOpen(closed, 'idb');
      const db = await open();
      const tx = db.transaction('streams', 'readonly');
      const range = streamRange(stream, opts?.fromSeq ?? 0, Infinity);
      const rows = (await requestOf(
        tx.objectStore('streams').getAll(range, opts?.limit),
      )) as StreamRow[];
      return rows.map((row): StoreRecord => ({ seq: row.seq, record: row.record }));
    },
    async truncate(stream, uptoSeq) {
      assertOpen(closed, 'idb');
      const db = await open();
      const tx = db.transaction('streams', 'readwrite');
      tx.objectStore('streams').delete(streamRange(stream, 0, uptoSeq));
      await txDone(tx);
    },
    async putSnapshot(key, data) {
      assertOpen(closed, 'idb');
      const db = await open();
      const tx = db.transaction('snapshots', 'readwrite');
      tx.objectStore('snapshots').put(jsonClone(data), key);
      await txDone(tx);
    },
    async getSnapshot<T = unknown>(key: string) {
      assertOpen(closed, 'idb');
      const db = await open();
      const tx = db.transaction('snapshots', 'readonly');
      return (await requestOf(tx.objectStore('snapshots').get(key))) as T | undefined;
    },
    async close() {
      if (closed) return;
      closed = true;
      if (dbPromise) (await dbPromise).close();
    },
  };
}
