export { ChangeSetAlgebra } from './algebra';
export { createGeoEngine, GeoStateEngine, type CreateGeoEngineOptions } from './engine';
// 同步收编桥（U3-B，RFC-0010）：editor-core sync/ 栈的 SAR 注入面 + 类型再导出
export {
  createSyncBridge,
  GEO_SYNC_SERVICE_KEY,
  localWinsResolver,
  MemoryEditBackend,
  remoteWinsResolver,
  type CommitOutcome,
  type ConflictResolver,
  type CreateSyncBridgeOptions,
  type EditSubmission,
  type EditTransport,
  type MergeEntry,
  type SubmitResponse,
  type SyncBridge,
  type ThreeWayMergeResult,
} from './sync';
export type { ChangeSet, EditableFeature, PropertyChange } from '@geoverse/editor-core';
// 几何桥：editor-core 纯几何算子（与其原生 Split/Merge 命令同一实现层）。
// 能力包经此映射 draw/split/merge，免开第二个 file: 链接；plan 仍在 SAR 侧构造 ChangeSet，
// 以便 dryRun / TransactionGroup 投影态直接复用（原生命令要 EditContext，进不了投影 plan）。
export {
  bufferGeometry,
  closeHole,
  fillHoles,
  mergeLines,
  mirrorGeometry,
  offsetLine,
  openHole,
  punchHole,
  rotateGeometry,
  scaleGeometry,
  splitLineAt,
  splitPolygonByLine,
  unionPolygons,
} from '@geoverse/editor-core';
// 查询/分析工具（RFC-0007）：属性谓词组合子 + 字段 Schema + 线长
export {
  and,
  contains,
  eq,
  gt,
  inferSchema,
  lineLength,
  lt,
  neq,
  not,
  oneOf,
  or,
  queryFeatures,
  range,
  validateValue,
  type AttributePredicate,
  type FieldSchema,
} from '@geoverse/editor-core';
