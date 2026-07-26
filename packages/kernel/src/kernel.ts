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
import { createJobManager, JOBS_SERVICE_KEY } from './jobs';
import { createNamedSets, SETS_SERVICE_KEY } from './named-sets';
import { toPaletteItems, type PaletteItem } from './palette';
import type { DiffAlgebra, StateEngine } from './ports';
import { RESOURCES_SERVICE_KEY, type ResourcePort } from './resource';
import { CATALOG_SERVICE_KEY, type CatalogService } from './runtime-pack';
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
  /**
   * 数据面端口（U3，RFC-0010）：只读资源的发现与查询——不进撤销时间线。
   * 提供时注入服务键 `runtime.resources`（能力经 requires 消费）并暴露为
   * `kernel.resources`（MCP resources 投影用）。
   */
  resources?: ResourcePort;
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
  /** 数据面端口（可选，U3）：宿主提供才有——只读世界，不进 undo。 */
  readonly resources?: ResourcePort;
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
  // 内建目录服务（U0-6）：catalog.search 等元能力经服务定位器发现目录——
  // 闭包活读 registry（注册在后也可见）；宿主传同键可覆写（内建在前）。
  const services = createServices({
    [CATALOG_SERVICE_KEY]: {
      discover: (query, filter) => registry.discover(query, filter),
    } satisfies CatalogService,
    // 命名集服务（U3-C）：会话级句柄——read 回包句柄化与写能力 target 寻址的底座。
    [SETS_SERVICE_KEY]: createNamedSets(),
    // 作业管理（U4-C）：异步长任务句柄；job:progress 帧走统一事件流。
    // 结构性红线：manager 不持引擎引用——作业落地必须经 invoke 回漏斗。
    [JOBS_SERVICE_KEY]: createJobManager(events),
    // 数据面服务（U3）：提供 resources 端口时才注入——无数据面的宿主上，
    // source.* 能力照常报 service_missing（requires 前置校验）。
    ...(options.resources ? { [RESOURCES_SERVICE_KEY]: options.resources } : {}),
    ...options.services,
  });
  const dispatcher = new Dispatcher<TEntity, TDiff>({
    registry,
    engine,
    algebra,
    services,
    events,
    middleware: options.middleware,
  });
  const workflows = new WorkflowRegistry<TEntity, TDiff>(dispatcher, registry, events);

  // 桥接端口事务流 → 统一事件流（dispose 只解绑自己挂上去的这份订阅）。
  // G1-1：写路由（origin='dispatch'）期间 dispatcher 同步置位当前执行身份，
  // 此处读取把事务关联到发起 trace/run（journal 据此归因）；undo/redo 非写路由，缺席。
  const offTransaction = engine.onTransaction((e) => {
    const exec = e.origin === 'dispatch' ? dispatcher.getCurrentExecution() : undefined;
    events.emit({
      type: 'engine:transaction',
      origin: e.origin,
      label: e.label,
      diff: e.diff,
      ...(exec
        ? { traceId: exec.traceId, ...(exec.runId ? { runId: exec.runId } : {}) }
        : {}),
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
    ...(options.resources ? { resources: options.resources } : {}),
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
