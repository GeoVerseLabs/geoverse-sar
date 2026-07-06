import {
  MapEntityStore,
  type Command,
  type DispatchResult,
  type Snapshot,
  type StateEngine,
  type TxEvent,
} from '@geoverse-sar/kernel';
import { RecordDiffAlgebra } from './algebra';
import { cloneRecord, type RecordDiff, type RecordEntity } from './types';

/**
 * MVP 引擎（RFC-0008 §4.2）：Map 存储 + undo/redo 栈。
 * dispatch 同步完成 plan→校验→apply→入撤销栈→emit（一个 diff = 一个原子撤销单元）。
 */
export class InMemoryStateEngine implements StateEngine<RecordEntity, RecordDiff> {
  private store = new MapEntityStore<RecordEntity>();
  private algebra = new RecordDiffAlgebra();
  private undoStack: RecordDiff[] = [];
  private redoStack: RecordDiff[] = [];
  private listeners = new Set<(e: TxEvent<RecordDiff>) => void>();

  constructor(seed: RecordEntity[] = []) {
    for (const r of seed) this.store.set(r.id, cloneRecord(r));
  }

  /** 撤销栈深度——宏撤销折叠断言（undoDepth===1）的观测点。 */
  get undoDepth(): number {
    return this.undoStack.length;
  }

  get redoDepth(): number {
    return this.redoStack.length;
  }

  dispatch(cmd: Command<RecordEntity, RecordDiff>): DispatchResult<RecordDiff> {
    let diff: RecordDiff;
    try {
      diff = cmd.plan(this.store);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    for (const a of diff.added) {
      if (this.store.has(a.id)) return { ok: false, error: `新增记录 id 冲突: ${a.id}` };
    }
    for (const m of diff.modified) {
      if (!this.store.has(m.id)) return { ok: false, error: `修改的记录不存在: ${m.id}` };
    }
    for (const r of diff.removed) {
      if (!this.store.has(r.id)) return { ok: false, error: `删除的记录不存在: ${r.id}` };
    }

    this.algebra.apply(this.store, diff);
    this.undoStack.push(diff);
    this.redoStack = [];
    const label = cmd.label ?? diff.label;
    this.emit({ origin: 'dispatch', diff, label });
    return { ok: true, diff, label };
  }

  undo(): boolean {
    const d = this.undoStack.pop();
    if (!d) return false;
    const inv = this.algebra.invert(d);
    this.algebra.apply(this.store, inv);
    this.redoStack.push(d);
    this.emit({ origin: 'undo', diff: inv, label: d.label });
    return true;
  }

  redo(): boolean {
    const d = this.redoStack.pop();
    if (!d) return false;
    this.algebra.apply(this.store, d);
    this.undoStack.push(d);
    this.emit({ origin: 'redo', diff: d, label: d.label });
    return true;
  }

  /** 快照做深拷贝：调用方持有的快照与后续变更彻底隔离。 */
  snapshot(): Snapshot<RecordEntity> {
    return {
      entities: new Map(
        this.store.ids().map((id) => [id, cloneRecord(this.store.get(id)!)]),
      ),
    };
  }

  onTransaction(fn: (e: TxEvent<RecordDiff>) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: TxEvent<RecordDiff>): void {
    for (const fn of this.listeners) fn(e);
  }
}
