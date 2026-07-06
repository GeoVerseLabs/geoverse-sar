import type { DiffAlgebra, EntityStore } from '@geoverse-sar/kernel';
import type {
  ChangeSet,
  EditableFeature,
  PropertyChange,
} from '@geoverse/editor-core';
import type { Geometry } from 'geojson';

const cloneFeature = (f: EditableFeature): EditableFeature => ({
  ...f,
  geometry: structuredClone(f.geometry),
  properties: structuredClone(f.properties),
});

let txSeq = 0;
const nextTxId = (): string => `sar-tx-${Date.now().toString(36)}-${(++txSeq).toString(36)}`;

/**
 * ChangeSet 的 diff 代数（ADR-0011 的 geoverse 侧实现）。
 * apply/invert 语义**镜像 editor-core `EditEngine.applyForward/applyReverse`**
 * （added/removed/modified 几何 + propertyChanges 属性，双通道），merge 按序折叠
 * 复用与 RecordDiffAlgebra 相同的矩阵——add→modify 折进 added、modify 链首 before
 * 末 after、add→remove 相消、modify→remove 保原始 before。
 */
export class ChangeSetAlgebra implements DiffAlgebra<EditableFeature, ChangeSet> {
  merge(diffs: ChangeSet[], label = '合并操作'): ChangeSet {
    const added = new Map<string, EditableFeature>();
    const removed = new Map<string, EditableFeature>();
    const geom = new Map<string, { id: string; before: Geometry; after: Geometry }>();
    const props = new Map<string, PropertyChange>();

    const dropFolded = (id: string) => {
      geom.delete(id);
      props.delete(id);
    };

    for (const cs of diffs) {
      for (const f of cs.removed) {
        if (added.has(f.id)) {
          // add→remove 相消（该 id 组内净效果为空；连带丢弃对它的折叠修改）
          added.delete(f.id);
          dropFolded(f.id);
        } else {
          // modify→remove：removed 快照须回滚到组前原始态（几何/属性均取首 before）
          const g = geom.get(f.id);
          const p = props.get(f.id);
          const snapshot = cloneFeature(f);
          if (g) snapshot.geometry = structuredClone(g.before);
          if (p) snapshot.properties = structuredClone(p.before);
          dropFolded(f.id);
          removed.set(f.id, snapshot);
        }
      }
      for (const f of cs.added) {
        const r = removed.get(f.id);
        if (r) {
          // remove→add 折叠为 modified 双通道
          removed.delete(f.id);
          geom.set(f.id, {
            id: f.id,
            before: structuredClone(r.geometry),
            after: structuredClone(f.geometry),
          });
          props.set(f.id, {
            id: f.id,
            before: structuredClone(r.properties),
            after: structuredClone(f.properties),
          });
        } else {
          added.set(f.id, cloneFeature(f));
        }
      }
      for (const m of cs.modified) {
        const a = added.get(m.id);
        if (a) {
          a.geometry = structuredClone(m.after);
        } else {
          const prev = geom.get(m.id);
          geom.set(m.id, {
            id: m.id,
            before: prev ? prev.before : structuredClone(m.before),
            after: structuredClone(m.after),
          });
        }
      }
      for (const p of cs.propertyChanges ?? []) {
        const a = added.get(p.id);
        if (a) {
          a.properties = structuredClone(p.after);
        } else {
          const prev = props.get(p.id);
          props.set(p.id, {
            id: p.id,
            before: prev ? prev.before : structuredClone(p.before),
            after: structuredClone(p.after),
          });
        }
      }
    }

    return {
      txId: nextTxId(),
      label,
      added: [...added.values()],
      removed: [...removed.values()],
      modified: [...geom.values()],
      ...(props.size ? { propertyChanges: [...props.values()] } : {}),
    };
  }

  invert(cs: ChangeSet): ChangeSet {
    return {
      txId: nextTxId(),
      label: cs.label,
      added: cs.removed.map(cloneFeature),
      removed: cs.added.map(cloneFeature),
      modified: cs.modified.map((m) => ({
        id: m.id,
        before: structuredClone(m.after),
        after: structuredClone(m.before),
      })),
      ...(cs.propertyChanges?.length
        ? {
            propertyChanges: cs.propertyChanges.map((p) => ({
              id: p.id,
              before: structuredClone(p.after),
              after: structuredClone(p.before),
            })),
          }
        : {}),
    };
  }

  /** 前滚语义与 editor-core `applyForward` 一致（供 txgroup 投影上下文用）。 */
  apply(base: EntityStore<EditableFeature>, cs: ChangeSet): void {
    for (const f of cs.removed) base.delete(f.id);
    for (const f of cs.added) base.set(f.id, cloneFeature(f));
    for (const m of cs.modified) {
      const f = base.get(m.id);
      if (f) base.set(m.id, { ...cloneFeature(f), geometry: structuredClone(m.after) });
    }
    for (const p of cs.propertyChanges ?? []) {
      const f = base.get(p.id);
      if (f) base.set(p.id, { ...cloneFeature(f), properties: structuredClone(p.after) });
    }
  }
}
