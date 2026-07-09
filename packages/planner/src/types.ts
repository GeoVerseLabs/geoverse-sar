import type { ToolSpec } from '@geoverse-sar/skill';

/**
 * Provider 中立的会话消息（planner 内部历史格式）：
 * - assistant 可携 toolCalls；tool 消息以 toolCallId 回应某次调用。
 * 各 provider（OpenAI 兼容 / Claude / …）由 LlmClient 实现负责翻译。
 */
export interface PlannerToolCall {
  /** provider 侧调用 id（回灌 tool 消息时对应 toolCallId）。 */
  id: string;
  /** 工具名（能力 id 的双下划线化，见 skill.toToolName）。 */
  name: string;
  /** 原始 JSON 参数串（可能不合法——由 planner 兜底回错）。 */
  arguments: string;
}

export type PlannerMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: PlannerToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string; name: string };

/** 一次补全请求：system 与 messages 分离（provider 各有摆法）。 */
export interface LlmRequest {
  system: string;
  messages: PlannerMessage[];
  tools: ToolSpec[];
}

export interface LlmCompleteOptions {
  signal?: AbortSignal;
  /** 客户端支持流式时逐段回调正文增量（工具调用参数不回调）。 */
  onTextDelta?: (delta: string) => void;
}

/** 一轮 assistant 回复：正文与工具调用可并存。 */
export interface AssistantTurn {
  text: string;
  toolCalls: PlannerToolCall[];
}

/**
 * planner 的唯一 LLM 端口——provider 无关、零 SDK。
 * 实现只需一个方法；支持流式的实现应在 onTextDelta 存在时边收边吐。
 */
export interface LlmClient {
  complete(req: LlmRequest, opts?: LlmCompleteOptions): Promise<AssistantTurn>;
}

/** 流式进度事件：一次 run 内按发生顺序回调（无头 UI 据此渲染时间线）。 */
export type PlannerEvent =
  | { type: 'round:start'; round: number }
  | { type: 'text:delta'; delta: string }
  | { type: 'assistant'; text: string }
  | {
      type: 'tool:call';
      name: string;
      capabilityId: string;
      args: unknown;
      argsRaw: string;
    }
  | {
      type: 'tool:result';
      name: string;
      capabilityId: string;
      ok: boolean;
      content: string;
    }
  | { type: 'run:end'; ok: boolean; rounds: number; stopReason: PlannerStopReason };

export type PlannerStopReason = 'completed' | 'max_rounds' | 'aborted' | 'error';

export interface PlannerRunResult {
  ok: boolean;
  stopReason: PlannerStopReason;
  /** 最后一条 assistant 正文（completed 时即最终回答）。 */
  text: string;
  rounds: number;
  /** 本次 run 内实际执行的工具调用数。 */
  toolCallCount: number;
  /** stopReason==='error' 时的错误信息。 */
  error?: string;
}
