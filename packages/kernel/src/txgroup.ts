import {
  storeFromSnapshot,
  type Command,
  type DiffAlgebra,
  type DispatchResult,
  type ReadonlyEntityState,
  type StateEngine,
} from './ports';

/** 唯一新增命令（ADR-0012）：plan 直接返回已合并 diff，供引擎一次 dispatch。 */
export class ReplayDiffCommand<TEntity, TDiff> implements Command<TEntity, TDiff> {
  constructor(
    private readonly diff: TDiff,
    readonly label?: string,
  ) {}

  plan(): TDiff {
    return this.diff;
  }
}

/**
 * TransactionGroup（ADR-0012）——SAR 唯一新增的运行时抽象。
 * 在应用前把多个步骤的 diff 预合并成一个，再经引擎 dispatch 一次：
 * 整条工作流 = 一个撤销单元 + 一份服务端 diff，引擎完全不改。
 */
export class TransactionGroup<TEntity, TDiff> {
  private buffer: TDiff[] = [];
  private closed = false;
  private readonly seedLen: number;

  constructor(
    private readonly engine: StateEngine<TEntity, TDiff>,
    private readonly algebra: DiffAlgebra<TEntity, TDiff>,
    readonly label: string,
    readonly id: string = 'txg-anonymous',
    seed: TDiff[] = [],
  ) {
    this.buffer = [...seed];
    this.seedLen = seed.length;
  }

  get size(): number {
    return this.buffer.length;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  stagedDiffs(): TDiff[] {
    return [...this.buffer];
  }

  /**
   * 投影上下文：基态快照叠加已缓冲 diff——第 N 步 plan 时能看见第 N-1 步的效果
   * （含引用前一步新增实体的缓冲临时 id）。
   */
  projectedState(): ReadonlyEntityState<TEntity> {
    const store = storeFromSnapshot(this.engine.snapshot());
    for (const d of this.buffer) this.algebra.apply(store, d);
    return store;
  }

  /** 在投影上下文上 plan 并把 diff 压入缓冲，不 apply。plan 抛异常 → 调用方应 abort 整组。 */
  stage(cmd: Command<TEntity, TDiff>): TDiff {
    this.assertOpen();
    const diff = cmd.plan(this.projectedState());
    this.buffer.push(diff);
    return diff;
  }

  /**
   * 只合并**本组自身** staged 的 diff（排除构造时的 seed 投影基座）；无新 staged 返回 undefined。
   * workflow 预览用：seed 是外层组的既有缓冲，只作投影可见性，不属于本次预览的变更。
   */
  mergedOwnDiff(): TDiff | undefined {
    const own = this.buffer.slice(this.seedLen);
    if (own.length === 0) return undefined;
    return this.algebra.merge(own, this.label);
  }

  /** 预合并后的单一 diff（不 dispatch）；空缓冲返回 undefined。dryRun 走这里。 */
  mergedDiff(): TDiff | undefined {
    if (this.buffer.length === 0) return undefined;
    return this.algebra.merge(this.stagedDiffs(), this.label);
  }

  /** merge 折叠 → 引擎 dispatch 一次。空缓冲返回 undefined（不产生撤销单元）。 */
  commit(): DispatchResult<TDiff> | undefined {
    this.assertOpen();
    const merged = this.mergedDiff();
    this.closed = true;
    if (merged === undefined) return undefined;
    return this.engine.dispatch(new ReplayDiffCommand(merged, this.label));
  }

  /** 丢弃缓冲（任一步 plan 抛异常 → abort 整组，对齐 onError:'abort'）。 */
  abort(): void {
    this.buffer = [];
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error(`TransactionGroup 已关闭: ${this.id}`);
    }
  }
}
