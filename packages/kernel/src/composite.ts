/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * CompositeStateEngine（阶段四 U4-D，ADR-0017）：多图层/多引擎——
 * 引擎注册表按 layer 命名空间分发、TDiff 是 tagged union（[{layer, diff}]）、
 * algebra 逐分量代理。**kernel 端口零改动**：Composite 只是 StateEngine 的又一个实现，
 * TransactionGroup/宏撤销/dryRun 投影全部自动成立——跨图层工作流恰一个撤销单元。
 *
 * 结构纪律（避开 editor-core EditSession 的单会话假设）：
 * - **统一撤销时间线在 Composite 层**：composite 自持 undo/redo 栈（CompositeDiff 帧）；
 *   子引擎经"重放已知 diff"驱动，其自有栈是惰性实现细节——宿主把引擎交给 Composite
 *   之后不得再直接操作子引擎（客人式的反向约束）；子引擎也**不对外暴露**（闭包私有）。
 * - 事件流只有 composite 一条（每次 dispatch/undo/redo 恰一帧），子引擎事件不桥接
 *   （桥了就双计）。
 * - 复合实体键：快照/精读以 `${layer}/${id}` 寻址（layer 名不得含 '/'）。
 */
import type {
  Command,
  DiffAlgebra,
  DispatchResult,
  EntityStore,
  ReadonlyEntityState,
  Snapshot,
  StateEngine,
  TxEvent,
} from './ports';

export type CompositeDiff<TDiff = any> = { layer: string; diff: TDiff }[];

export interface CompositeLayer<TEntity = any, TDiff = any> {
  engine: StateEngine<TEntity, TDiff>;
  algebra: DiffAlgebra<TEntity, TDiff>;
}

export interface CompositeHandle<TEntity = any, TDiff = any> {
  engine: StateEngine<TEntity, CompositeDiff<TDiff>>;
  algebra: DiffAlgebra<TEntity, CompositeDiff<TDiff>>;
  /** 组合 diff 书写便利：单层分量。 */
  forLayer(layer: string, diff: TDiff): CompositeDiff<TDiff>;
  /** 已注册层名（只读；不暴露子引擎实例）。 */
  layers(): string[];
}

const KEY_SEP = '/';

/** 层视图：把复合键存储投影成某一层的裸 id 存储（子代数 apply 的作用面）。 */
function layerView<TEntity>(
  base: EntityStore<TEntity>,
  layer: string,
): EntityStore<TEntity> {
  const prefix = `${layer}${KEY_SEP}`;
  return {
    get: (id) => base.get(prefix + id),
    has: (id) => base.has(prefix + id),
    ids: () =>
      base
        .ids()
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length)),
    list: () =>
      base
        .ids()
        .filter((k) => k.startsWith(prefix))
        .map((k) => base.get(k)!) as TEntity[],
    set: (id, entity) => base.set(prefix + id, entity),
    delete: (id) => base.delete(prefix + id),
  };
}

export function createCompositeEngine<TEntity = any, TDiff = any>(
  layerMap: Record<string, CompositeLayer<TEntity, TDiff>>,
): CompositeHandle<TEntity, TDiff> {
  const layers = new Map(Object.entries(layerMap));
  for (const name of layers.keys()) {
    if (name.includes(KEY_SEP)) {
      throw new Error(`层名不得含 '${KEY_SEP}': ${name}`);
    }
  }
  const layerOf = (name: string): CompositeLayer<TEntity, TDiff> => {
    const l = layers.get(name);
    if (!l)
      throw new Error(`未注册的层: ${name}（已注册: ${[...layers.keys()].join(', ')}）`);
    return l;
  };

  /** 子引擎按"重放已知 diff"驱动（plan 恒返给定 diff——引擎照常校验/入栈/发事件）。 */
  const replayInto = (name: string, diff: TDiff, label?: string): DispatchResult<TDiff> =>
    layerOf(name).engine.dispatch({ label, plan: () => diff });

  const compositeSnapshot = (): Map<string, TEntity> => {
    const merged = new Map<string, TEntity>();
    for (const [name, l] of layers) {
      for (const [id, entity] of l.engine.snapshot().entities) {
        merged.set(`${name}${KEY_SEP}${id}`, entity);
      }
    }
    return merged;
  };

  const stateView = (): ReadonlyEntityState<TEntity> => {
    const snap = compositeSnapshot();
    return {
      get: (id) => snap.get(id),
      has: (id) => snap.has(id),
      ids: () => [...snap.keys()],
      list: () => [...snap.values()],
      count: () => snap.size,
    };
  };

  const algebra: DiffAlgebra<TEntity, CompositeDiff<TDiff>> = {
    merge(diffs, label) {
      // 按首现顺序聚合各层分量，逐层交给子代数 merge（宏撤销/预览的正确性来源）
      const order: string[] = [];
      const byLayer = new Map<string, TDiff[]>();
      for (const composite of diffs) {
        for (const comp of composite) {
          if (!byLayer.has(comp.layer)) {
            byLayer.set(comp.layer, []);
            order.push(comp.layer);
          }
          byLayer.get(comp.layer)!.push(comp.diff);
        }
      }
      return order.map((name) => ({
        layer: name,
        diff: layerOf(name).algebra.merge(byLayer.get(name)!, label),
      }));
    },
    invert(diff) {
      return [...diff].reverse().map((comp) => ({
        layer: comp.layer,
        diff: layerOf(comp.layer).algebra.invert(comp.diff),
      }));
    },
    apply(base, diff) {
      for (const comp of diff) {
        layerOf(comp.layer).algebra.apply(layerView(base, comp.layer), comp.diff);
      }
    },
  };

  // ---- 统一撤销时间线（composite 自持栈；子引擎栈是惰性实现细节）----
  const undoStack: { diff: CompositeDiff<TDiff>; label?: string }[] = [];
  const redoStack: { diff: CompositeDiff<TDiff>; label?: string }[] = [];
  const listeners = new Set<(e: TxEvent<CompositeDiff<TDiff>>) => void>();
  const emit = (e: TxEvent<CompositeDiff<TDiff>>): void => {
    for (const fn of listeners) {
      try {
        fn(e);
      } catch {
        // 监听者异常不得中断主流程（与 EventBus 同一纪律）
      }
    }
  };

  /** 逐层落地；中途失败回滚已落地分量（跨层原子性尽力而为，失败即整体拒绝）。 */
  const applyComposite = (
    diff: CompositeDiff<TDiff>,
    label?: string,
  ): { ok: true } | { ok: false; error: string } => {
    const applied: { layer: string; diff: TDiff }[] = [];
    for (const comp of diff) {
      const res = replayInto(comp.layer, comp.diff, label);
      if (!res.ok) {
        for (const done of [...applied].reverse()) {
          replayInto(done.layer, layerOf(done.layer).algebra.invert(done.diff), '回滚');
        }
        return { ok: false, error: `层 ${comp.layer} 拒绝: ${res.error}` };
      }
      applied.push(comp);
    }
    return { ok: true };
  };

  const engine: StateEngine<TEntity, CompositeDiff<TDiff>> = {
    dispatch(cmd: Command<TEntity, CompositeDiff<TDiff>>) {
      let diff: CompositeDiff<TDiff>;
      try {
        diff = cmd.plan(stateView());
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      for (const comp of diff) {
        if (!layers.has(comp.layer)) {
          return { ok: false, error: `未注册的层: ${comp.layer}` };
        }
      }
      const label = cmd.label;
      const res = applyComposite(diff, label);
      if (!res.ok) return { ok: false, error: res.error };
      undoStack.push({ diff, label });
      redoStack.length = 0;
      emit({ origin: 'dispatch', diff, label });
      return { ok: true, diff, label };
    },
    undo() {
      const top = undoStack.pop();
      if (!top) return false;
      const inverse = algebra.invert(top.diff);
      applyComposite(inverse, top.label);
      redoStack.push(top);
      emit({ origin: 'undo', diff: inverse, label: top.label });
      return true;
    },
    redo() {
      const top = redoStack.pop();
      if (!top) return false;
      applyComposite(top.diff, top.label);
      undoStack.push(top);
      emit({ origin: 'redo', diff: top.diff, label: top.label });
      return true;
    },
    snapshot(): Snapshot<TEntity> {
      return { entities: compositeSnapshot() };
    },
    onTransaction(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    get undoDepth() {
      return undoStack.length;
    },
    get redoDepth() {
      return redoStack.length;
    },
    getEntity(id: string) {
      const sep = id.indexOf(KEY_SEP);
      if (sep <= 0) return undefined;
      const l = layers.get(id.slice(0, sep));
      if (!l) return undefined;
      const bare = id.slice(sep + 1);
      if (l.engine.getEntity) return l.engine.getEntity(bare);
      return l.engine.snapshot().entities.get(bare);
    },
    entityCount() {
      let total = 0;
      for (const l of layers.values()) {
        total += l.engine.entityCount?.() ?? l.engine.snapshot().entities.size;
      }
      return total;
    },
  };

  return {
    engine,
    algebra,
    forLayer: (layer, diff) => [{ layer, diff }],
    layers: () => [...layers.keys()],
  };
}
