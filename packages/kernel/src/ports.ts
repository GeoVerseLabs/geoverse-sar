/**
 * 通用 diff 端口（ADR-0011）——内核对"状态变更"的唯一抽象。
 * 内核对 <TEntity, TDiff> 完全泛化：不含几何、不含 GeoJSON、不知道"地图"是什么。
 * MVP 由 @geoverse-sar/engine-memory 实现（Record/RecordDiff）；
 * 后续 geoverse 适配器实现 StateEngine<EditableFeature, ChangeSet>（M2）。
 */

/** 只读实体视图：Command.plan 与 read 能力的统一读取面。 */
export interface ReadonlyEntityState<TEntity> {
  get(id: string): TEntity | undefined;
  has(id: string): boolean;
  ids(): string[];
  list(): TEntity[];
}

/** 可写实体存储：DiffAlgebra.apply 的作用面。 */
export interface EntityStore<TEntity> extends ReadonlyEntityState<TEntity> {
  set(id: string, entity: TEntity): void;
  delete(id: string): void;
}

/** 纯 planner（ADR-0010）：算 diff、不改状态；撤销/校验/事件由引擎统一负责。 */
export interface Command<TEntity, TDiff> {
  readonly label?: string;
  plan(state: ReadonlyEntityState<TEntity>): TDiff;
}

export interface Snapshot<TEntity> {
  readonly entities: ReadonlyMap<string, TEntity>;
}

export type TxOrigin = 'dispatch' | 'undo' | 'redo';

export interface TxEvent<TDiff> {
  origin: TxOrigin;
  diff: TDiff;
  label?: string;
}

export type DispatchResult<TDiff> =
  { ok: true; diff: TDiff; label?: string } | { ok: false; error: string };

/**
 * 状态引擎端口：dispatch 同步完成 plan→校验→apply→入撤销栈→emit——
 * async 边界在能力 handler，不在 diff 应用，原子性由此保住（RFC-0008 §七）。
 */
export interface StateEngine<TEntity, TDiff> {
  dispatch(cmd: Command<TEntity, TDiff>): DispatchResult<TDiff>;
  undo(): boolean;
  redo(): boolean;
  snapshot(): Snapshot<TEntity>;
  onTransaction(fn: (e: TxEvent<TDiff>) => void): () => void;
}

/** 每引擎一份的 diff 代数：宏撤销（merge）、undo（invert）、前滚（apply）。 */
export interface DiffAlgebra<TEntity, TDiff> {
  merge(diffs: TDiff[], label?: string): TDiff;
  invert(diff: TDiff): TDiff;
  apply(base: EntityStore<TEntity>, diff: TDiff): void;
}

/** Map 实现的实体存储——引擎内部状态与 txgroup 投影上下文共用。 */
export class MapEntityStore<TEntity> implements EntityStore<TEntity> {
  constructor(private readonly map = new Map<string, TEntity>()) {}

  get(id: string): TEntity | undefined {
    return this.map.get(id);
  }
  has(id: string): boolean {
    return this.map.has(id);
  }
  ids(): string[] {
    return [...this.map.keys()];
  }
  list(): TEntity[] {
    return [...this.map.values()];
  }
  set(id: string, entity: TEntity): void {
    this.map.set(id, entity);
  }
  delete(id: string): void {
    this.map.delete(id);
  }
}

/** 从快照建可写存储（txgroup 投影基态）。 */
export function storeFromSnapshot<TEntity>(
  snapshot: Snapshot<TEntity>,
): MapEntityStore<TEntity> {
  return new MapEntityStore(new Map(snapshot.entities));
}
