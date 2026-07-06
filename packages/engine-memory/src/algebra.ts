import type { DiffAlgebra, EntityStore } from '@geoverse-sar/kernel';
import {
  cloneRecord,
  type RecordDiff,
  type RecordEntity,
  type RecordModification,
} from './types';

/**
 * RecordDiff 的 diff 代数（ADR-0011/0012）。
 * merge 按序折叠（宏撤销的正确性核心）：
 * - add → modify   折叠进 added（after 态）
 * - modify → modify 首 before / 末 after
 * - add → remove   相消
 * - modify → remove removed 保留原始 before
 * - remove → add   折叠为 modified（before=被删前，after=新添）
 */
export class RecordDiffAlgebra implements DiffAlgebra<RecordEntity, RecordDiff> {
  merge(diffs: RecordDiff[], label?: string): RecordDiff {
    const added = new Map<string, RecordEntity>();
    const removed = new Map<string, RecordEntity>();
    const modified = new Map<string, RecordModification>();

    for (const d of diffs) {
      for (const a of d.added) {
        const r = removed.get(a.id);
        if (r) {
          removed.delete(a.id);
          modified.set(a.id, { id: a.id, before: r, after: cloneRecord(a) });
        } else {
          added.set(a.id, cloneRecord(a));
        }
      }
      for (const m of d.modified) {
        if (added.has(m.id)) {
          added.set(m.id, cloneRecord(m.after));
        } else {
          const prev = modified.get(m.id);
          modified.set(m.id, {
            id: m.id,
            before: prev ? prev.before : cloneRecord(m.before),
            after: cloneRecord(m.after),
          });
        }
      }
      for (const r of d.removed) {
        if (added.has(r.id)) {
          added.delete(r.id);
        } else {
          const prev = modified.get(r.id);
          modified.delete(r.id);
          removed.set(r.id, prev ? prev.before : cloneRecord(r));
        }
      }
    }

    return {
      label,
      added: [...added.values()],
      removed: [...removed.values()],
      modified: [...modified.values()],
    };
  }

  invert(d: RecordDiff): RecordDiff {
    return {
      label: d.label,
      added: d.removed.map(cloneRecord),
      removed: d.added.map(cloneRecord),
      modified: d.modified.map((m) => ({
        id: m.id,
        before: cloneRecord(m.after),
        after: cloneRecord(m.before),
      })),
    };
  }

  apply(base: EntityStore<RecordEntity>, d: RecordDiff): void {
    for (const r of d.removed) base.delete(r.id);
    for (const a of d.added) base.set(a.id, cloneRecord(a));
    for (const m of d.modified) base.set(m.id, cloneRecord(m.after));
  }
}
