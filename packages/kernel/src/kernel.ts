/* eslint-disable @typescript-eslint/no-explicit-any */
import type { CapabilityPack } from './capability';
import {
  CapabilityRegistry,
  type CapabilityDescriptor,
  type DescribeFilter,
} from './registry';
import {
  Dispatcher,
  type InvokeOptions,
  type InvokeOutcome,
  type Middleware,
  type TxGroupHandle,
} from './dispatcher';
import { EventBus } from './eventbus';
import { toPaletteItems, type PaletteItem } from './palette';
import type { DiffAlgebra, StateEngine } from './ports';
import { createServices, type Services } from './services';
import {
  WorkflowRegistry,
  type Workflow,
  type WorkflowRunOptions,
  type WorkflowRunResult,
} from './workflow';

export interface KernelOptions<TEntity, TDiff> {
  /** 客人式生命周期（ADR-0013）：收已构造好的引擎，内核不在内部创建。 */
  engine: StateEngine<TEntity, TDiff>;
  algebra: DiffAlgebra<TEntity, TDiff>;
  packs?: CapabilityPack<TEntity, TDiff>[];
  workflows?: Workflow[];
  services?: Record<string, unknown>;
  middleware?: Middleware[];
  /** 默认 false：dispose 不销毁宿主 engine；显式 true 才代管销毁。 */
  ownsEngine?: boolean;
}

export interface SarKernel<TEntity = any, TDiff = any> {
  readonly engine: StateEngine<TEntity, TDiff>;
  readonly algebra: DiffAlgebra<TEntity, TDiff>;
  readonly registry: CapabilityRegistry<TEntity, TDiff>;
  readonly dispatcher: Dispatcher<TEntity, TDiff>;
  readonly workflows: WorkflowRegistry<TEntity, TDiff>;
  readonly events: EventBus<TDiff>;
  readonly services: Services;
  invoke<O = unknown>(
    id: string,
    input?: unknown,
    opts?: InvokeOptions,
  ): Promise<InvokeOutcome<O, TDiff>>;
  runWorkflow<O = unknown>(
    id: string,
    input?: unknown,
    opts?: WorkflowRunOptions,
  ): Promise<WorkflowRunResult<O, TDiff>>;
  describeAll(filter?: DescribeFilter): CapabilityDescriptor[];
  toPaletteItems(filter?: DescribeFilter): PaletteItem[];
  beginGroup(label: string): TxGroupHandle<TDiff>;
  dispose(): void;
}

export function createKernel<TEntity, TDiff>(
  options: KernelOptions<TEntity, TDiff>,
): SarKernel<TEntity, TDiff> {
  const { engine, algebra, ownsEngine = false } = options;
  const events = new EventBus<TDiff>();
  const registry = new CapabilityRegistry<TEntity, TDiff>();
  const services = createServices(options.services);
  const dispatcher = new Dispatcher<TEntity, TDiff>({
    registry,
    engine,
    algebra,
    services,
    events,
    middleware: options.middleware,
  });
  const workflows = new WorkflowRegistry<TEntity, TDiff>(dispatcher, registry, events);

  // 桥接端口事务流 → 统一事件流（dispose 只解绑自己挂上去的这份订阅）
  const offTransaction = engine.onTransaction((e) => {
    events.emit({
      type: 'engine:transaction',
      origin: e.origin,
      label: e.label,
      diff: e.diff,
    });
  });

  for (const pack of options.packs ?? []) registry.registerPack(pack);
  for (const wf of options.workflows ?? []) workflows.register(wf);

  let disposed = false;
  return {
    engine,
    algebra,
    registry,
    dispatcher,
    workflows,
    events,
    services,
    invoke: (id, input, opts) => dispatcher.invoke(id, input, opts),
    runWorkflow: (id, input, opts) => workflows.run(id, input, opts),
    describeAll: (filter) => registry.describeAll(filter),
    toPaletteItems: (filter) => toPaletteItems(registry, filter),
    beginGroup: (label) => dispatcher.beginGroup(label),
    dispose() {
      if (disposed) return;
      disposed = true;
      offTransaction();
      events.clear();
      if (ownsEngine) {
        (engine as { dispose?: () => void }).dispose?.();
      }
    },
  };
}
