import type {
  Command,
  DispatchResult,
  ReadonlyEntityState,
  Snapshot,
  StateEngine,
  TxEvent,
} from '@geoverse-sar/kernel';
import type {
  ChangeSet,
  Command as EditCommand,
  EditableFeature,
  EditContext,
} from '@geoverse/editor-core';
import { EditEngine } from '@geoverse/editor-core';
import { ChangeSetAlgebra } from './algebra';

/** 由 editor-core EditContext 构造 SAR 只读实体视图（SAR 命令的读取面）。 */
function stateViewOf(ctx: EditContext): ReadonlyEntityState<EditableFeature> {
  return {
    get: (id) => ctx.tryGetFeature(id),
    has: (id) => ctx.tryGetFeature(id) !== undefined,
    ids: () => ctx.allFeatures().map((f) => f.id),
    list: () => ctx.allFeatures(),
  };
}

/**
 * geoverse 适配器引擎（RFC-0008 M2 / ADR-0011 方案 B 的"零阻抗"验证点）：
 * `StateEngine<EditableFeature, ChangeSet>` **包住** editor-core `EditEngine`——
 * 校验/apply/撤销栈/事件全部委托既有实现，引擎零改动（客人式：收现成实例）。
 *
 * 细节：`EditEngine.dispatch` 返回 `EditResult{ok,issues}` 不含 ChangeSet，
 * 应用后的 diff 经 `onTransaction`（同步发出）捕获后回填 DispatchResult。
 */
export class GeoStateEngine implements StateEngine<EditableFeature, ChangeSet> {
  private readonly algebra = new ChangeSetAlgebra();
  private lastApplied: ChangeSet | undefined;

  constructor(readonly editEngine: EditEngine) {
    // 内部常驻订阅：捕获 dispatch 期间同步发出的 apply 事务 + 栈深记账
    // （记账挂事务事件上：宿主绕过 SAR 直接 dispatch/undo 也能对上）
    this.editEngine.onTransaction((e) => {
      if (e.kind === 'apply') {
        this.lastApplied = e.changeSet;
        this.depth += 1;
        this.redoCount = 0;
      } else if (e.kind === 'undo') {
        this.depth = Math.max(0, this.depth - 1);
        this.redoCount += 1;
      } else {
        this.depth += 1;
        this.redoCount = Math.max(0, this.redoCount - 1);
      }
    });
  }

  /** editor-core 未暴露栈深，SAR 侧经事务事件记账（宿主先于包装的历史不计入）。 */
  get undoDepth(): number {
    return this.depth;
  }
  get redoDepth(): number {
    return this.redoCount;
  }
  private depth = 0;
  private redoCount = 0;

  dispatch(cmd: Command<EditableFeature, ChangeSet>): DispatchResult<ChangeSet> {
    // SAR 命令 → editor-core 命令：plan 的读取面由 EditContext 桥出
    const wrapped: EditCommand = {
      label: cmd.label ?? 'SAR 操作',
      plan: (ctx) => cmd.plan(stateViewOf(ctx)),
    };
    this.lastApplied = undefined;
    const res = this.editEngine.dispatch(wrapped);
    // lastApplied 由 dispatch 期间同步发出的 apply 事务回填（TS 控制流看不见，显式拓宽）
    const applied = this.lastApplied as ChangeSet | undefined;
    if (!res.ok || !applied) {
      const message = res.issues.map((i) => i.message).join('；') || '引擎拒绝该命令';
      return { ok: false, error: message };
    }
    return { ok: true, diff: applied, label: applied.label };
  }

  undo(): boolean {
    return this.editEngine.undo();
  }

  redo(): boolean {
    return this.editEngine.redo();
  }

  snapshot(): Snapshot<EditableFeature> {
    return {
      entities: new Map(this.editEngine.snapshot().features.map((f) => [f.id, f])),
    };
  }

  onTransaction(fn: (e: TxEvent<ChangeSet>) => void): () => void {
    // kind 映射：apply→dispatch；undo 事件回传"实际生效的反向 diff"（与 engine-memory 语义一致）
    return this.editEngine.onTransaction((e) => {
      if (e.kind === 'apply') {
        fn({ origin: 'dispatch', diff: e.changeSet, label: e.changeSet.label });
      } else if (e.kind === 'undo') {
        fn({
          origin: 'undo',
          diff: this.algebra.invert(e.changeSet),
          label: e.changeSet.label,
        });
      } else {
        fn({ origin: 'redo', diff: e.changeSet, label: e.changeSet.label });
      }
    });
  }
}

export interface CreateGeoEngineOptions {
  /** 已有引擎则直接包（客人式，ADR-0013）；缺省内部新建。 */
  editEngine?: EditEngine;
  features?: EditableFeature[];
  crs?: string;
  idGen?: () => string;
}

export function createGeoEngine(opts: CreateGeoEngineOptions = {}): GeoStateEngine {
  const editEngine =
    opts.editEngine ??
    new EditEngine({ features: opts.features, crs: opts.crs, idGen: opts.idGen });
  return new GeoStateEngine(editEngine);
}
