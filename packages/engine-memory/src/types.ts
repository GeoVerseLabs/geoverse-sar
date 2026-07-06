/**
 * RecordEntity：内存点记录——editor-core `EditableFeature` 的极简同构
 * （id + 平面坐标 + 属性包），便于将来与 geo 引擎对照（RFC-0008 §4.2）。
 */
export interface RecordEntity {
  id: string;
  x: number;
  y: number;
  props: Record<string, unknown>;
}

export interface RecordModification {
  id: string;
  before: RecordEntity;
  after: RecordEntity;
}

/** ChangeSet 的极简同构：added / removed / modified 三组。 */
export interface RecordDiff {
  label?: string;
  added: RecordEntity[];
  removed: RecordEntity[];
  modified: RecordModification[];
}

export function cloneRecord(r: RecordEntity): RecordEntity {
  return { ...r, props: { ...r.props } };
}

export function emptyDiff(label?: string): RecordDiff {
  return { label, added: [], removed: [], modified: [] };
}
