/**
 * 存储端口 SarStore（目标架构 R1）——runtime 唯一的持久化抽象。
 * 持久数据只有两种形状：**追加流**（journal / audit / 对话——只增不改）与
 * **快照**（实体状态 / 会话元数据——整体替换）。端口按形状定义，刻意不做 ORM/查询。
 *
 * 约束：records / snapshot 必须 JSON 可序列化（journal 的 TDiff 约束自动覆盖）。
 * 三个适配器语义完全一致（同一契约测试套件钉死）：
 * - `memoryStore()`（本文件）——测试/临时会话；
 * - `idbStore(name)`（子导出 `@geoverse-sar/kernel/store-idb`）——浏览器；
 * - `fileStore(dir)`（子导出 `@geoverse-sar/kernel/store-file`）——Node，JSONL。
 *
 * seq 语义：由 store 按流分配、从 1 起单调递增，**truncate 后不回退不复用**
 * （恢复算法靠 seq 连续性校验断档；checkpoint 截断头部后续 append 继续编号）。
 */

export interface StoreRecord {
  seq: number;
  record: unknown;
}

export interface StreamReadOptions {
  /** 起始 seq（含）；缺省从头读。 */
  fromSeq?: number;
  /** 最多返回条数；缺省不限。 */
  limit?: number;
}

export interface SarStore {
  /** 追加一批记录，返回最后一条的 seq（空批返回当前 lastSeq，不产生写入）。 */
  append(stream: string, records: unknown[]): Promise<number>;
  read(stream: string, opts?: StreamReadOptions): Promise<StoreRecord[]>;
  /** 截断流头部（seq ≤ uptoSeq 的记录删除；checkpoint 后回收 journal 用）。 */
  truncate(stream: string, uptoSeq: number): Promise<void>;

  /** 快照：整体替换语义。 */
  putSnapshot(key: string, data: unknown): Promise<void>;
  getSnapshot<T = unknown>(key: string): Promise<T | undefined>;

  /** 关闭后一切操作拒绝（幂等）。 */
  close(): Promise<void>;
}

/**
 * JSON 往返克隆：统一三适配器的值语义（undefined 属性剔除、Date→字符串、
 * 函数/循环引用直接抛错）——内存适配器也走一遍，"测试绿了换持久化适配器才不会翻车"。
 */
export function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function assertOpen(closed: boolean, kind: string): void {
  if (closed) throw new Error(`SarStore 已关闭（${kind}），不再接受操作`);
}

/** 内存适配器：现状"隐式不持久"行为的显式化；语义与持久化适配器逐条对齐。 */
export function memoryStore(): SarStore {
  const streams = new Map<string, StoreRecord[]>();
  const lastSeqs = new Map<string, number>();
  const snapshots = new Map<string, unknown>();
  let closed = false;

  return {
    async append(stream, records) {
      assertOpen(closed, 'memory');
      let seq = lastSeqs.get(stream) ?? 0;
      if (records.length === 0) return seq;
      const list = streams.get(stream) ?? [];
      for (const record of records) {
        list.push({ seq: ++seq, record: jsonClone(record) });
      }
      streams.set(stream, list);
      lastSeqs.set(stream, seq);
      return seq;
    },
    async read(stream, opts) {
      assertOpen(closed, 'memory');
      const fromSeq = opts?.fromSeq ?? 0;
      const limit = opts?.limit ?? Infinity;
      const out: StoreRecord[] = [];
      for (const item of streams.get(stream) ?? []) {
        if (item.seq < fromSeq) continue;
        out.push({ seq: item.seq, record: jsonClone(item.record) });
        if (out.length >= limit) break;
      }
      return out;
    },
    async truncate(stream, uptoSeq) {
      assertOpen(closed, 'memory');
      const list = streams.get(stream);
      if (!list) return;
      streams.set(
        stream,
        list.filter((item) => item.seq > uptoSeq),
      );
    },
    async putSnapshot(key, data) {
      assertOpen(closed, 'memory');
      snapshots.set(key, jsonClone(data));
    },
    async getSnapshot<T = unknown>(key: string) {
      assertOpen(closed, 'memory');
      const data = snapshots.get(key);
      return data === undefined ? undefined : (jsonClone(data) as T);
    },
    async close() {
      closed = true;
    },
  };
}
