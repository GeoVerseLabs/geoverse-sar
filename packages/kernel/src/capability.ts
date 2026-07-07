/* eslint-disable @typescript-eslint/no-explicit-any */
import type { z } from 'zod';
import type {
  Command,
  DiffAlgebra,
  ReadonlyEntityState,
  StateEngine,
} from './ports';
import type { CallerInfo } from './permissions';
import type { Services } from './services';

/**
 * 能力三态（ADR-0010）：
 * - read   不改状态、非撤销（AI 可"先看后改"）；
 * - write  返回命令或 diff → 走引擎 → 可撤销；
 * - action 有副作用但非 diff（如视野聚焦、undo/redo 本身）。
 */
export type CapabilityKind = 'read' | 'write' | 'action';

export interface CapabilityContext<TEntity, TDiff> {
  engine: StateEngine<TEntity, TDiff>;
  algebra: DiffAlgebra<TEntity, TDiff>;
  /** 读一致视图：txGroup 激活时是叠加已缓冲 diff 的投影态，否则为引擎当前快照。 */
  state: ReadonlyEntityState<TEntity>;
  services: Services;
  caller: CallerInfo;
  /** 取消信号（M4 治理）：长 handler 应配合检查；写路由前 dispatcher 也会兜底检查。 */
  signal?: AbortSignal;
}

export type CapabilityResult<O, TEntity, TDiff> =
  | { output: O }
  | { output: O; diff: TDiff; label?: string }
  | { output: O; commands: Command<TEntity, TDiff>[]; label?: string };

/**
 * 能力 = 自描述的可调用单元。description 要写"何时该调"——
 * 它会逐字变成 AI 工具目录里的说明（CapabilityDescriptor ≡ Claude 工具定义）。
 */
export interface Capability<I = any, O = any, TEntity = any, TDiff = any> {
  id: string;
  title: string;
  description: string;
  category: string;
  kind: CapabilityKind;
  inputSchema: z.ZodType<I, any>;
  outputSchema: z.ZodType<O, any>;
  tags?: readonly string[];
  permissions?: readonly string[];
  undoable?: boolean;
  /**
   * 声明 handler 依赖的宿主服务键（services.require 的 key）。
   * dispatcher 在执行前校验（缺失 → service_missing 而非 handler 内部深处抛错）；
   * doctor 据此做装配体检。
   */
  requires?: readonly string[];
  handler(
    ctx: CapabilityContext<TEntity, TDiff>,
    input: I,
  ): Promise<CapabilityResult<O, TEntity, TDiff>>;
}

export interface CapabilityPack<TEntity = any, TDiff = any> {
  id: string;
  capabilities: Capability<any, any, TEntity, TDiff>[];
}

/** 恒等辅助：保留字面量推断，能力包书写用。 */
export function defineCapability<I, O, TEntity, TDiff>(
  cap: Capability<I, O, TEntity, TDiff>,
): Capability<I, O, TEntity, TDiff> {
  return cap;
}
