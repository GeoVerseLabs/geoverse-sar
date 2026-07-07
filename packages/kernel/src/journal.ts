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
import { ReplayDiffCommand } from './txgroup';

export type JournalEntry<TDiff> =
  | { seq: number; at: string; op: 'dispatch'; label?: string; diff: TDiff }
  | { seq: number; at: string; op: 'undo' }
  | { seq: number; at: string; op: 'redo' };

export interface Journal<TDiff> {
  entries(): JournalEntry<TDiff>[];
  readonly size: number;
  /** 解绑事件订阅（停止录制；已录条目保留）。 */
  stop(): void;
  clear(): void;
  toJSON(): string;
}

/** 开始录制（客人式：不影响引擎；dispose 语义 = stop）。 */
export function createJournal<TEntity, TDiff>(
  kernel: SarKernel<TEntity, TDiff>,
): Journal<TDiff> {
  let seq = 0;
  let log: JournalEntry<TDiff>[] = [];
  const off = kernel.events.on((e) => {
    if (e.type !== 'engine:transaction') return;
    const at = new Date().toISOString();
    if (e.origin === 'dispatch') {
      log.push({ seq: ++seq, at, op: 'dispatch', label: e.label, diff: e.diff });
    } else {
      log.push({ seq: ++seq, at, op: e.origin });
    }
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
