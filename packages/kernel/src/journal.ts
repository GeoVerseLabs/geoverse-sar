/**
 * 事务日志（M4 治理——"工作流持久化/回放"落点）：
 * 订阅引擎事务流，把 dispatch/undo/redo 按序录成 JSON 可持久化的日志；
 * `replayJournal` 在同构引擎上逐条重放（dispatch → ReplayDiffCommand）。
 *
 * 为什么录 diff 而不是录 invoke：宏撤销折叠在**录制时已发生**——工作流跑完
 * 只出一条合并事务，重放天然复现相同的最终状态**与撤销粒度**；undo/redo
 * 也入日志，撤销栈行为完整复刻。
 * 约束：TDiff 须 JSON 可序列化（RecordDiff / ChangeSet 均满足）；回放目标
 * 引擎的初始状态须与录制起点一致（通常是空引擎或同一 seed）。
 */
import type { SarKernel } from './kernel';
import type { SarStore } from './store';
import { ReplayDiffCommand } from './txgroup';

export type JournalEntry<TDiff> =
  | {
      seq: number;
      at: string;
      op: 'dispatch';
      label?: string;
      diff: TDiff;
      /** 关联发起 trace/run（G1-1）：写路由事务携带；老日志/回放缺席不影响重放。 */
      traceId?: string;
      runId?: string;
    }
  | { seq: number; at: string; op: 'undo' }
  | { seq: number; at: string; op: 'redo' };

/**
 * 流化出口（目标架构 R2）：每录一条即 append 进 SarStore——
 * 内存数组照旧（查询走内存），store 是持久化取证面（双写）。
 */
export interface StreamSink {
  store: SarStore;
  /** 流名（journal 默认 'journal'，audit 默认 'audit'）。 */
  stream?: string;
  /** sink 写失败回调（**不阻断主流程**；默认 console.error）。 */
  onError?: (err: unknown) => void;
}

export interface CreateJournalOptions {
  sink?: StreamSink;
}

export interface Journal<TDiff> {
  entries(): JournalEntry<TDiff>[];
  readonly size: number;
  /** 解绑事件订阅（停止录制；已录条目保留）。 */
  stop(): void;
  clear(): void;
  toJSON(): string;
  /** 等待 sink 写入落定（无 sink 时立即返回）；close 存储前调用。 */
  flush(): Promise<void>;
}

/** 串行 sink 写手：保序、吞错不断主流程（事件回调纪律）。 */
export function createSinkWriter(sink: StreamSink, defaultStream: string) {
  const stream = sink.stream ?? defaultStream;
  const onError =
    sink.onError ??
    ((err: unknown) => console.error(`SarStore sink(${stream}) 写入失败`, err));
  let chain: Promise<void> = Promise.resolve();
  return {
    write(record: unknown): void {
      chain = chain
        .then(() => sink.store.append(stream, [record]))
        .then(
          () => undefined,
          (err) => onError(err),
        );
    },
    flush: () => chain,
  };
}

/** 开始录制（客人式：不影响引擎；dispose 语义 = stop）。 */
export function createJournal<TEntity, TDiff>(
  kernel: SarKernel<TEntity, TDiff>,
  options: CreateJournalOptions = {},
): Journal<TDiff> {
  let seq = 0;
  let log: JournalEntry<TDiff>[] = [];
  const writer = options.sink ? createSinkWriter(options.sink, 'journal') : undefined;
  const off = kernel.events.on((e) => {
    if (e.type !== 'engine:transaction') return;
    const at = new Date().toISOString();
    const entry: JournalEntry<TDiff> =
      e.origin === 'dispatch'
        ? {
            seq: ++seq,
            at,
            op: 'dispatch',
            label: e.label,
            diff: e.diff,
            ...(e.traceId ? { traceId: e.traceId } : {}),
            ...(e.runId ? { runId: e.runId } : {}),
          }
        : { seq: ++seq, at, op: e.origin };
    log.push(entry);
    writer?.write(entry);
  });
  return {
    entries: () => [...log],
    get size() {
      return log.length;
    },
    stop: off,
    clear() {
      log = [];
    },
    toJSON() {
      return JSON.stringify({ version: 1, entries: log });
    },
    flush: () => writer?.flush() ?? Promise.resolve(),
  };
}

export interface ReplayResult {
  ok: boolean;
  /** 成功重放的条目数。 */
  applied: number;
  error?: string;
}

export function parseJournal<TDiff>(json: string): JournalEntry<TDiff>[] {
  const data = JSON.parse(json) as { version?: number; entries?: JournalEntry<TDiff>[] };
  if (data.version !== 1 || !Array.isArray(data.entries)) {
    throw new Error('事务日志格式不支持（期待 {version:1, entries:[...]}）');
  }
  return data.entries;
}

/** 逐条重放（首错即停，返回已应用数）。 */
export function replayJournal<TEntity, TDiff>(
  kernel: SarKernel<TEntity, TDiff>,
  journal: string | JournalEntry<TDiff>[],
): ReplayResult {
  const entries = typeof journal === 'string' ? parseJournal<TDiff>(journal) : journal;
  let applied = 0;
  for (const entry of entries) {
    if (entry.op === 'dispatch') {
      const res = kernel.engine.dispatch(
        new ReplayDiffCommand<TEntity, TDiff>(entry.diff, entry.label ?? '回放'),
      );
      if (!res.ok) {
        return { ok: false, applied, error: `第 ${entry.seq} 条重放被拒: ${res.error}` };
      }
    } else if (entry.op === 'undo') {
      if (!kernel.engine.undo()) {
        return { ok: false, applied, error: `第 ${entry.seq} 条 undo 无可撤销` };
      }
    } else {
      if (!kernel.engine.redo()) {
        return { ok: false, applied, error: `第 ${entry.seq} 条 redo 无可重做` };
      }
    }
    applied += 1;
  }
  return { ok: true, applied };
}
