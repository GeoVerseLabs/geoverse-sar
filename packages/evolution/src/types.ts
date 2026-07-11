/**
 * L2 编排进化的共享类型（RFC-0009）。
 * 红线："进化数据，不进化代码"——合成产物是**声明式 Workflow 草稿（纯 JSON）**：
 * 只能组合已注册已校验的能力、注册后仍走单漏斗（权限/审计/dryRun 全生效）、
 * 爆炸半径被宏撤销兜住、带 provenance 落 SarStore 流可追溯。
 */

/** 极简起草 LLM 端口：非确定性隔离在端口外（单测脚本化假实现）。 */
export interface DraftLlm {
  complete(prompt: string): Promise<string>;
}

/** 轨迹挖掘产物：高频能力调用序列。 */
export interface MinedSequence {
  capabilityIds: string[];
  count: number;
}

/**
 * Workflow 草稿（纯 JSON，可入库/人审/回放）。
 * steps[].input 是模板：字符串值 `$input.路径` 引用工作流入参、
 * `$steps.步骤id.路径` 引用前步输出（`$$` 前缀转义为字面 `$`）。
 */
export interface WorkflowDraft {
  /** 形如 workflow.xxx。 */
  id: string;
  title: string;
  description: string;
  /** 顶层入参字段 → 类型（编译成 zod inputSchema）。 */
  inputFields?: Record<string, 'string' | 'number' | 'boolean'>;
  steps: { id: string; capability: string; input?: unknown }[];
}

export interface SynthesisProvenance {
  /** 挖掘来源序列与出现次数。 */
  minedFrom: string[];
  count: number;
  createdAt: string;
  createdBy: string;
}

export interface DraftValidation {
  ok: boolean;
  issues: string[];
}

/**
 * 合成记录（`synthesized-workflows` 流的条目；同 draft.id 追加即状态迁移，最新为准）。
 * 默认 `pending`（待启用——**不注册进目录**）；审批通过才 `enabled`。
 */
export interface SynthesizedWorkflowRecord {
  draft: WorkflowDraft;
  status: 'pending' | 'enabled' | 'rejected';
  provenance: SynthesisProvenance;
  validation: DraftValidation;
}

export const SYNTHESIZED_WORKFLOWS_STREAM = 'synthesized-workflows';
