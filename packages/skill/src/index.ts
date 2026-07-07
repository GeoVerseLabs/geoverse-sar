import {
  explainError,
  type CallerInfo,
  type DescribeFilter,
  type InvokeOutcome,
  type JsonSchema,
  type SarKernel,
} from '@geoverse-sar/kernel';

/** Copilot 会话建议默认模型（进程内 tool-use 循环由宿主实现，本包零 SDK 依赖）。 */
export const DEFAULT_MODEL = 'claude-opus-4-8';

/**
 * Claude 工具定义（与 CapabilityDescriptor 逐字段对齐，RFC-0008 §五）：
 * id≡name / description≡description / inputJsonSchema≡input_schema。
 */
export interface ToolSpec {
  name: string;
  description: string;
  input_schema: JsonSchema;
}

/** Claude tool name 只允许 [a-zA-Z0-9_-]，能力 id 里的 `.` 双下划线化（双射）。 */
export function toToolName(capabilityId: string): string {
  return capabilityId.replace(/\./g, '__');
}

export function toCapabilityId(toolName: string): string {
  return toolName.replace(/__/g, '.');
}

export interface ToToolSpecsOptions {
  /** 权限化目录裁剪：模型看不见即调不到（describeAll 同一判定）。 */
  caller?: CallerInfo;
  filter?: Omit<DescribeFilter, 'caller'>;
}

/**
 * 把内核能力目录投影成 Claude 工具规格数组。
 * 与 kernel.toPaletteItems 同源（同一份 inputJsonSchema）——schema 平价的技术根基。
 */
export function toToolSpecs(
  kernel: SarKernel,
  opts: ToToolSpecsOptions = {},
): ToolSpec[] {
  return kernel
    .describeAll({ ...opts.filter, caller: opts.caller ?? AI_CALLER })
    .map((d) => ({
      name: toToolName(d.id),
      description: d.description,
      input_schema: d.inputJsonSchema,
    }));
}

export const AI_CALLER: CallerInfo = { entry: 'ai' };

export interface ToolCallResult<O = unknown, TDiff = unknown> {
  /** tool_result 的 content（JSON 字符串）。 */
  content: string;
  /** 校验/权限/执行失败时 true——回灌给模型自纠。 */
  is_error: boolean;
  /** 完整归一出参（宿主观测/断言用，不进 tool_result）。 */
  outcome: InvokeOutcome<O, TDiff>;
}

export interface HandleToolCallOptions {
  caller?: CallerInfo;
  /** AI 预览/人审门：返回将改什么的 diff，但不 apply。 */
  dryRun?: boolean;
  /** 取消信号（M4）：透传给 invoke（写路由前内核兜底检查）。 */
  signal?: AbortSignal;
}

/**
 * AI 入口的回灌路由：tool call → 单一 invoke 漏斗（caller.entry='ai'）。
 * 与程序化/UI 入口共用同一 dispatcher——跨入口平价由此保证。
 * name 兼容工具名（records__query）与能力 id（records.query）两种写法。
 */
export async function handleToolCall<O = unknown, TDiff = unknown>(
  kernel: SarKernel,
  name: string,
  args: unknown,
  opts: HandleToolCallOptions = {},
): Promise<ToolCallResult<O, TDiff>> {
  const id = kernel.registry.has(name) ? name : toCapabilityId(name);
  const outcome = (await kernel.invoke(id, args, {
    caller: opts.caller ?? AI_CALLER,
    dryRun: opts.dryRun,
    signal: opts.signal,
  })) as InvokeOutcome<O, TDiff>;

  if (!outcome.ok) {
    // hint：错误→可操作提示（含相似能力建议），提高模型自纠一次成功率
    const hint = explainError(outcome, { registry: kernel.registry });
    return {
      content: JSON.stringify({ error: outcome.error, issues: outcome.issues, hint }),
      is_error: true,
      outcome,
    };
  }
  return {
    content: JSON.stringify(outcome.output ?? null),
    is_error: false,
    outcome,
  };
}
