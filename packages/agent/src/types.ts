import type { EffectDescriptor } from '@geoverse-sar/kernel';

/** 单个待执行动作：能力 id（点号形式）+ 入参。 */
export interface AgentAction {
  capabilityId: string;
  input?: unknown;
}

export interface AgentActionResult {
  capabilityId: string;
  ok: boolean;
  output?: unknown;
  error?: string;
  /** 审批门拦下（未执行）时 true。 */
  blocked?: boolean;
}

/**
 * 观察面（observe）：领域中立——实体计数 + 撤销深度 + 权限裁剪后的能力目录
 * + 上一步各动作结果。策略据此决定下一步（plan）。
 */
export interface AgentObservation {
  goal: string;
  /** 当前第几步（1 起）。 */
  step: number;
  maxSteps: number;
  /** 实体总数（经 runtime.stats 能力取得）；宿主未注册 runtimePack 时缺席。 */
  entityCount?: number;
  /** 撤销栈深；runtimePack 未注册或引擎未暴露栈深时缺席。 */
  undoDepth?: number;
  catalog: {
    id: string;
    kind: string;
    title: string;
    description: string;
    /** 效应元数据（G1-2）：策略可据此判断哪些动作不可逆/有外部副作用/需审批。 */
    effects?: EffectDescriptor;
  }[];
  lastResults: AgentActionResult[];
  /** 宿主经 enrichObservation 注入的领域观察扩展（如空间摘要），随观察一并交给策略。 */
  extra?: Record<string, unknown>;
}

/** 观察增强钩子（T10）：领域包据此把空间摘要等注入观察面，循环骨架保持领域中立。 */
export type ObservationEnricher = (
  observation: AgentObservation,
) => AgentObservation | Promise<AgentObservation>;

export type AgentDecision =
  | { kind: 'act'; actions: AgentAction[]; note?: string }
  | { kind: 'done'; summary: string };

/**
 * 策略端口（plan）：LLM / 规则 / 脚本皆可——非确定性隔离在端口之外，
 * 循环骨架（预算/审批/中止/审计归因）保持可单测。
 */
export interface AgentPolicy {
  decide(observation: AgentObservation): Promise<AgentDecision>;
}

export type AgentStopReason = 'done' | 'max_steps' | 'aborted' | 'policy_error';

export type AgentEvent =
  | { type: 'observe'; step: number; observation: AgentObservation }
  | { type: 'decide'; step: number; decision: AgentDecision }
  | { type: 'act:result'; step: number; result: AgentActionResult }
  | { type: 'blocked'; step: number; action: AgentAction; reason: string }
  | {
      type: 'end';
      ok: boolean;
      stopReason: AgentStopReason;
      steps: number;
      summary?: string;
    };

export interface AgentRunResult {
  ok: boolean;
  stopReason: AgentStopReason;
  /** 实际走过的观察-决策步数。 */
  steps: number;
  /** 全程动作轨迹（含被拦动作）。 */
  trace: AgentActionResult[];
  summary?: string;
  error?: string;
  /** 本次运行的 runId（G1-1）：按此查审计/事件即得整次自治运行的时间线。 */
  runId: string;
}
