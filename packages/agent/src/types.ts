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
  entityCount: number;
  /** 引擎未暴露栈深时缺席。 */
  undoDepth?: number;
  catalog: { id: string; kind: string; title: string; description: string }[];
  lastResults: AgentActionResult[];
}

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
  | { type: 'end'; ok: boolean; stopReason: AgentStopReason; steps: number; summary?: string };

export interface AgentRunResult {
  ok: boolean;
  stopReason: AgentStopReason;
  /** 实际走过的观察-决策步数。 */
  steps: number;
  /** 全程动作轨迹（含被拦动作）。 */
  trace: AgentActionResult[];
  summary?: string;
  error?: string;
}
