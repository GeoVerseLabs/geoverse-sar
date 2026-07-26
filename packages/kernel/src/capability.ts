/* eslint-disable @typescript-eslint/no-explicit-any */
import type { z } from 'zod';
import type { Command, DiffAlgebra, ReadonlyEntityState, StateEngine } from './ports';
import type { CallerInfo } from './permissions';
import type { Services } from './services';
import type { ExecutionMode } from './ids';

/**
 * 能力三态（ADR-0010）：
 * - read   不改状态、非撤销（AI 可"先看后改"）；
 * - write  返回命令或 diff → 走引擎 → 可撤销；
 * - action 有副作用但非 diff（如视野聚焦、undo/redo 本身）。
 */
export type CapabilityKind = 'read' | 'write' | 'action';

/**
 * 效应描述（阶段三 G1-2）：`kind` 只管**目录路由**（三态心智），`effects` 才是
 * **预览/审批/重试/补偿**的判据——`kind==='action'` 的危险操作（外部写、不可逆）
 * 从此能被审批门识别（修复复评 P0-3「Effect 模型停留 read/write/action」）。
 */
export interface EffectDescriptor {
  /** 对内部状态的影响：none 不改 / reversible 可撤销 / irreversible 不可撤销。 */
  state: 'none' | 'reversible' | 'irreversible';
  /** 对外部世界的副作用：none / read（外部读）/ write（外部写：发布/发送/下载等）。 */
  external: 'none' | 'read' | 'write';
  /** 审批要求：never 不需 / policy 交宿主策略（agent approve 回调）/ always 强制。 */
  approval: 'never' | 'policy' | 'always';
  /** 幂等性：none 非幂等 / keyed 幂等（可安全重试）。 */
  idempotency: 'none' | 'keyed';
}

/** kind 缺省效应（能力未显式声明 effects 时）：可逆内部写默认走审批策略。 */
const KIND_DEFAULT_EFFECTS: Record<CapabilityKind, EffectDescriptor> = {
  read: { state: 'none', external: 'none', approval: 'never', idempotency: 'keyed' },
  write: {
    state: 'reversible',
    external: 'none',
    approval: 'policy',
    idempotency: 'none',
  },
  action: { state: 'none', external: 'none', approval: 'never', idempotency: 'none' },
};

/**
 * 解析能力的完整效应：以 kind 缺省为底，能力声明的 `effects`（Partial）覆盖其上。
 * 描述符恒携带解析后的完整 effects——"每个能力都有效应元数据"由此成立（缺省即有）。
 */
export function resolveEffects(
  kind: CapabilityKind,
  effects?: Partial<EffectDescriptor>,
): EffectDescriptor {
  return { ...KIND_DEFAULT_EFFECTS[kind], ...effects };
}

export interface CapabilityContext<TEntity, TDiff> {
  engine: StateEngine<TEntity, TDiff>;
  algebra: DiffAlgebra<TEntity, TDiff>;
  /** 读一致视图：txGroup 激活时是叠加已缓冲 diff 的投影态，否则为引擎当前快照。 */
  state: ReadonlyEntityState<TEntity>;
  services: Services;
  caller: CallerInfo;
  /** 取消信号（M4 治理）：长 handler 应配合检查；写路由前 dispatcher 也会兜底检查。 */
  signal?: AbortSignal;
  /**
   * 预览标记（Gate 0 契约修复）：组合型能力（如 workflow 投影 handler）内部若自行
   * 发起 invoke，必须把它透传下去——否则外层 dryRun 预览会被内部真实写入击穿。
   * 普通能力无需理会（写路由由 dispatcher 统一拦截）。
   */
  dryRun: boolean;
  /** 外层事务组 id（若本次调用在宏组内缓冲）：组合型能力应把内部写步并入该组，保外层原子性。 */
  txGroupId?: string;
  /**
   * 执行身份（G1-1）：一次顶层操作的关联 traceId + 运行实例 runId + 模式。
   * 组合型能力（workflow 投影）内部发起 invoke 时应透传，使整棵调用树同 trace 归因。
   */
  traceId: string;
  runId?: string;
  mode: ExecutionMode;
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
   * 效应元数据（G1-2）：覆盖 kind 缺省（`resolveEffects`）。危险的 action（外部写/
   * 不可逆）在此声明 `approval:'always'` / `external:'write'` / `state:'irreversible'`，
   * 使审批门与预览安全策略正确识别——不必改 kind（kind 仍表达三态路由心智）。
   */
  effects?: Partial<EffectDescriptor>;
  /**
   * 声明 handler 依赖的宿主服务键（services.require 的 key）。
   * dispatcher 在执行前校验（缺失 → service_missing 而非 handler 内部深处抛错）；
   * doctor 据此做装配体检。
   */
  requires?: readonly string[];
  /** 首次提供的包版本（semver）或日期——目录消费方展示用，机制不消费。 */
  since?: string;
  /**
   * 弃用标记：true 或弃用原因说明。弃用能力**不从目录隐藏**（journal 只含 diff，
   * 历史回放不受包升级影响；隐藏与徽章交给 UI 消费方）——doctor 负责告警：
   * 列出仍在目录的弃用能力、检出工作流步骤对弃用能力的引用。
   */
  deprecated?: boolean | string;
  /** 替代能力 id（配合 deprecated；doctor 检出指向未注册能力的悬空引用）。 */
  replacedBy?: string;
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
