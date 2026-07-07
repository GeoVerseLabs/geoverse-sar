export { ChangeSetAlgebra } from './algebra';
export {
  createGeoEngine,
  GeoStateEngine,
  type CreateGeoEngineOptions,
} from './engine';
export type { ChangeSet, EditableFeature, PropertyChange } from '@geoverse/editor-core';
// 几何桥：editor-core 纯几何算子（与其原生 Split/Merge 命令同一实现层）。
// 能力包经此映射 draw/split/merge，免开第二个 file: 链接；plan 仍在 SAR 侧构造 ChangeSet，
// 以便 dryRun / TransactionGroup 投影态直接复用（原生命令要 EditContext，进不了投影 plan）。
export {
  mergeLines,
  splitLineAt,
  splitPolygonByLine,
  unionPolygons,
} from '@geoverse/editor-core';
