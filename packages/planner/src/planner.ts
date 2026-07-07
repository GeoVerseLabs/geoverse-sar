import type { SarKernel } from '@geoverse-sar/kernel';
import {
  handleToolCall,
  toCapabilityId,
  toToolSpecs,
  type ToToolSpecsOptions,
} from '@geoverse-sar/skill';
import type {
  LlmClient,
  PlannerEvent,
  PlannerMessage,
  PlannerRunResult,
  PlannerStopReason,
} from './types';

export interface CreatePlannerOptions {
  client: LlmClient;
  /** 系统提示（业务口吻/单位约定等）；能力目录不用写——由 describeAll 投影自动携带。 */
  system?: string;
  /** 单次 run 的最大 LLM 轮数（每轮=一次补全，可含多个工具调用），默认 8。 */
  maxRounds?: number;
  /** 目录裁剪透传 toToolSpecs（权限化：模型看不见即调不到）。 */
  toolSpecs?: ToToolSpecsOptions;
}

export interface PlannerRunOptions {
  onEvent?: (e: PlannerEvent) => void;
  signal?: AbortSignal;
  /** AI 预览门：所有写调用走 dryRun（返回将改什么，不 apply）。 */
  dryRun?: boolean;
}

export interface Planner {
  /** 跨 run 持续的会话历史（provider 中立格式）；只读视图。 */
  readonly history: readonly PlannerMessage[];
  run(userText: string, opts?: PlannerRunOptions): Promise<PlannerRunResult>;
  /** 清空会话历史（能力目录不受影响）。 */
  reset(): void;
}

const DEFAULT_SYSTEM =
  '你是空间应用运行时（SAR）的助手。你只能通过提供的工具读写宿主状态：先查询确认目标，再做写操作；出错时依据 hint 自纠。回答用简体中文，简短说明做了什么。';

/**
 * NL→能力路由 planner（RFC-0008 M3）：
 * 自然语言→工具的映射完全发生在这里（LLM 侧）——内核仍 NL-free。
 * 能力目录即 `describeAll` 的工具投影（toToolSpecs）；回灌走 handleToolCall
 * 单一 invoke 漏斗（caller.entry='ai'），跨入口平价与错误 hint 全部继承。
 */
export function createPlanner(kernel: SarKernel, options: CreatePlannerOptions): Planner {
  const { client, system = DEFAULT_SYSTEM, maxRounds = 8 } = options;
  const history: PlannerMessage[] = [];

  async function run(
    userText: string,
    opts: PlannerRunOptions = {},
  ): Promise<PlannerRunResult> {
    const emit = (e: PlannerEvent): void => {
      try {
        opts.onEvent?.(e);
      } catch {
        // 观测回调异常不得中断 run 主流程（与 EventBus 同一纪律）
      }
    };
    const finish = (
      ok: boolean,
      stopReason: PlannerStopReason,
      text: string,
      rounds: number,
      toolCallCount: number,
      error?: string,
    ): PlannerRunResult => {
      emit({ type: 'run:end', ok, rounds, stopReason });
      return { ok, stopReason, text, rounds, toolCallCount, error };
    };

    // 目录在每次 run 时重投影：注册/权限变化即时生效
    const tools = toToolSpecs(kernel, options.toolSpecs);
    history.push({ role: 'user', content: userText });

    let lastText = '';
    let toolCallCount = 0;
    for (let round = 1; round <= maxRounds; round++) {
      if (opts.signal?.aborted) {
        return finish(false, 'aborted', lastText, round - 1, toolCallCount);
      }
      emit({ type: 'round:start', round });

      let turn;
      try {
        turn = await client.complete(
          { system, messages: [...history], tools },
          {
            signal: opts.signal,
            onTextDelta: (delta) => emit({ type: 'text:delta', delta }),
          },
        );
      } catch (err) {
        if (opts.signal?.aborted) {
          return finish(false, 'aborted', lastText, round - 1, toolCallCount);
        }
        const message = err instanceof Error ? err.message : String(err);
        return finish(false, 'error', lastText, round - 1, toolCallCount, message);
      }

      history.push({
        role: 'assistant',
        content: turn.text,
        toolCalls: turn.toolCalls.length ? turn.toolCalls : undefined,
      });
      if (turn.text) {
        lastText = turn.text;
        emit({ type: 'assistant', text: turn.text });
      }
      if (!turn.toolCalls.length) {
        return finish(true, 'completed', lastText, round, toolCallCount);
      }

      for (const call of turn.toolCalls) {
        const capabilityId = kernel.registry.has(call.name)
          ? call.name
          : toCapabilityId(call.name);
        let args: unknown = {};
        let parseError: string | undefined;
        try {
          args = call.arguments ? JSON.parse(call.arguments) : {};
        } catch (err) {
          parseError = String(err);
        }
        emit({ type: 'tool:call', name: call.name, capabilityId, args, argsRaw: call.arguments });

        let content: string;
        let ok: boolean;
        if (parseError) {
          ok = false;
          content = JSON.stringify({
            error: { code: 'invalid_arguments_json', message: parseError },
            hint: '工具参数必须是合法 JSON，请修正后重试。',
          });
        } else {
          const result = await handleToolCall(kernel, call.name, args, {
            dryRun: opts.dryRun,
          });
          ok = !result.is_error;
          content = result.content;
          toolCallCount += 1;
        }
        emit({ type: 'tool:result', name: call.name, capabilityId, ok, content });
        history.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: ok ? content : `ERROR: ${content}`,
        });
      }
    }
    return finish(false, 'max_rounds', lastText, maxRounds, toolCallCount);
  }

  return {
    get history() {
      return history;
    },
    run,
    reset() {
      history.length = 0;
    },
  };
}
