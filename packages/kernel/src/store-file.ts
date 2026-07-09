/**
 * 文件适配器（子导出 `@geoverse-sar/kernel/store-file`，Node 宿主专用——
 * 唯一豁免"禁 Node 内置模块"lint 门的内核模块，不进浏览器主入口）。
 *
 * 布局：`<dir>/streams/<流名>.jsonl`（每行 {seq,record}）+ `<流名>.meta.json`
 * （truncate 时落 lastSeq，保证清空流后编号不回退）+ `<dir>/snapshots/<键>.json`。
 *
 * 崩溃一致性（目标架构 §六）：追加流天然安全——启动装载时丢弃末尾无换行残行
 * （告警 + 物理截掉，避免后续 append 黏连损坏）；完整行解析失败=存储损坏，直接抛错。
 * 快照/截断走 tmp+rename 原子替换。fsync 可配（默认每批）。
 */
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { assertOpen, jsonClone, type SarStore, type StoreRecord } from './store';

export interface FileStoreOptions {
  /** append/truncate/快照写入后是否 fsync（默认 true，每批一次）。 */
  fsync?: boolean;
  /** 残行告警回调（默认 console.warn）。 */
  onWarn?: (message: string) => void;
}

/** 文件名安全编码：非 [A-Za-z0-9._-] 一律 %XX（含 % 自身，无碰撞）。 */
function safeName(raw: string): string {
  return Array.from(raw)
    .map((ch) =>
      /[A-Za-z0-9._-]/.test(ch)
        ? ch
        : `%${ch.codePointAt(0)!.toString(16).padStart(2, '0')}`,
    )
    .join('');
}

interface StreamState {
  records: StoreRecord[];
  lastSeq: number;
}

async function writeFileAtomic(
  path: string,
  text: string,
  fsync: boolean,
): Promise<void> {
  const tmp = `${path}.tmp`;
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(text, 'utf8');
    if (fsync) await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, path);
}

export function fileStore(dir: string, options?: FileStoreOptions): SarStore {
  const fsync = options?.fsync ?? true;
  const warn = options?.onWarn ?? ((msg: string) => console.warn(msg));
  const streamsDir = join(dir, 'streams');
  const snapshotsDir = join(dir, 'snapshots');
  const streamPath = (stream: string) => join(streamsDir, `${safeName(stream)}.jsonl`);
  const metaPath = (stream: string) => join(streamsDir, `${safeName(stream)}.meta.json`);
  const snapshotPath = (key: string) => join(snapshotsDir, `${safeName(key)}.json`);

  const cache = new Map<string, StreamState>();
  let closed = false;

  // 单写者串行队列：seq 分配依赖"读缓存→写文件→更新缓存"不被并发交错。
  let queue: Promise<unknown> = Promise.resolve();
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function readIfExists(path: string): Promise<Buffer | undefined> {
    try {
      return await readFile(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  async function loadStream(stream: string): Promise<StreamState> {
    const cached = cache.get(stream);
    if (cached) return cached;

    const path = streamPath(stream);
    const records: StoreRecord[] = [];
    let metaSeq = 0;
    const metaBuf = await readIfExists(metaPath(stream));
    if (metaBuf)
      metaSeq = (JSON.parse(metaBuf.toString('utf8')) as { lastSeq: number }).lastSeq;

    const buf = await readIfExists(path);
    if (buf) {
      const lastNewline = buf.lastIndexOf(0x0a);
      const validLength = lastNewline + 1; // 无换行 → 0，整文件视作残行
      if (validLength < buf.length) {
        warn(
          `SarStore(file) 流 "${stream}"：丢弃末尾 ${buf.length - validLength} 字节残行（疑为上次写入中断）`,
        );
        const fh = await open(path, 'r+');
        try {
          await fh.truncate(validLength);
          if (fsync) await fh.sync();
        } finally {
          await fh.close();
        }
      }
      const lines = buf.toString('utf8', 0, validLength).split('\n');
      for (const line of lines) {
        if (!line) continue;
        let parsed: StoreRecord;
        try {
          parsed = JSON.parse(line) as StoreRecord;
        } catch {
          throw new Error(
            `SarStore(file) 流 "${stream}" 存在损坏的完整行（非末尾残行）——存储已损坏，请用最近一次完整快照恢复`,
          );
        }
        records.push(parsed);
      }
    }

    const state: StreamState = {
      records,
      lastSeq: Math.max(
        metaSeq,
        records.length > 0 ? records[records.length - 1].seq : 0,
      ),
    };
    cache.set(stream, state);
    return state;
  }

  return {
    async append(stream, records) {
      assertOpen(closed, 'file');
      return enqueue(async () => {
        assertOpen(closed, 'file');
        await mkdir(streamsDir, { recursive: true });
        const state = await loadStream(stream);
        if (records.length === 0) return state.lastSeq;
        const batch: StoreRecord[] = records.map((record) => ({
          seq: ++state.lastSeq,
          record: jsonClone(record),
        }));
        const text = batch.map((row) => JSON.stringify(row)).join('\n') + '\n';
        const fh = await open(streamPath(stream), 'a');
        try {
          await fh.writeFile(text, 'utf8');
          if (fsync) await fh.sync();
        } finally {
          await fh.close();
        }
        state.records.push(...batch);
        return state.lastSeq;
      });
    },
    async read(stream, opts) {
      assertOpen(closed, 'file');
      return enqueue(async () => {
        assertOpen(closed, 'file');
        const state = await loadStream(stream);
        const fromSeq = opts?.fromSeq ?? 0;
        const limit = opts?.limit ?? Infinity;
        const out: StoreRecord[] = [];
        for (const row of state.records) {
          if (row.seq < fromSeq) continue;
          out.push({ seq: row.seq, record: jsonClone(row.record) });
          if (out.length >= limit) break;
        }
        return out;
      });
    },
    async truncate(stream, uptoSeq) {
      assertOpen(closed, 'file');
      return enqueue(async () => {
        assertOpen(closed, 'file');
        await mkdir(streamsDir, { recursive: true });
        const state = await loadStream(stream);
        const kept = state.records.filter((row) => row.seq > uptoSeq);
        if (kept.length === state.records.length) return;
        const text =
          kept.length > 0 ? kept.map((row) => JSON.stringify(row)).join('\n') + '\n' : '';
        await writeFileAtomic(streamPath(stream), text, fsync);
        // lastSeq 落 meta：流被清空后重启也不回退编号（seq 连续性校验的前提）
        await writeFileAtomic(
          metaPath(stream),
          JSON.stringify({ lastSeq: state.lastSeq }),
          fsync,
        );
        state.records = kept;
      });
    },
    async putSnapshot(key, data) {
      assertOpen(closed, 'file');
      return enqueue(async () => {
        assertOpen(closed, 'file');
        await mkdir(snapshotsDir, { recursive: true });
        await writeFileAtomic(snapshotPath(key), JSON.stringify(jsonClone(data)), fsync);
      });
    },
    async getSnapshot<T = unknown>(key: string) {
      assertOpen(closed, 'file');
      return enqueue(async () => {
        assertOpen(closed, 'file');
        const buf = await readIfExists(snapshotPath(key));
        return buf === undefined ? undefined : (JSON.parse(buf.toString('utf8')) as T);
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      await queue.catch(() => undefined);
    },
  };
}
