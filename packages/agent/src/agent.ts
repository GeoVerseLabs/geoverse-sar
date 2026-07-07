import type { CallerInfo, SarKernel } from '@geoverse-sar/kernel';
import { handleToolCall } from '@geoverse-sar/skill';
import type {
  AgentAction,
  AgentActionResult,
  AgentDecision,
  AgentEvent,
  AgentObservation,
  AgentPolicy,
  AgentRunResult,
  AgentStopReason,
} from './types';

export interface CreateAgentOptions {
  policy: AgentPolicy;
  /** observe→plan→act 的最大步数（一步 = 一次观察+决策，可含多个动作），默认 8。 */
  maxSteps?: number;
  /**
   * 主体身份，默认 `{ entry: 'agent' }`。给 `grantedPermissions` 即权限白名单：
   * 目录裁剪（策略看不见）+ invoke 强制（硬调也 permission_denied）双重生效。
   */
  caller?: CallerInfo;
  /**
   * 审批门（人审/规则审）：写动作先 dryRun 出「将改什么」的 diff，审批通过才真执行；
   * 返回 false → 动作被拦（blocked），agent 继续但策略会在下一步观察到。
   * 缺省 = 全放行。read/action 类不过门。
   */
  approve?: (action: AgentAction, preview: { diff?: unknown }) => boolean | Promise<boolean>;
}

export interface AgentRunOptions {
  signal?: AbortSignal;
  onEvent?: (e: AgentEvent) => void;
}

export interface Agent {
  run(goal: string, opts?: AgentRunOptions): Promise<AgentRunResult>;
}

const AGENT_CALLER: CallerInfo = { entry: 'agent' };

/**
 * 自治 Agent 入口（RFC-0008 M4）：observe→plan→act 循环。
 * 治理不在循环里自建——权限由 kernel 单漏斗强制、审计由中间件同栈入账、
 * 取消经 AbortSignal 贯穿（invoke 写路由前有内核兜底）；本层只加**审批门**
 * （dryRun 预览 + approve 回调）与**步数预算**。
 */
export function createAgent(kernel: SarKernel, options: CreateAgentOptions): Agent {
  const { policy, maxSteps = 8, caller = AGENT_CALLER, approve } = options;

  function observe(
    goal: string,
    step: number,
    lastResults: AgentActionResult[],
  ): AgentObservation {
    const undoDepth = (kernel.engine as { undoDepth?: number }).undoDepth;
    return {
      goal,
      step,
      maxSteps,
      entityCount: kernel.engine.snapshot().entities.size,
      undoDepth: typeof undoDepth === 'number' ? undoDepth : undefined,
      // 权限裁剪后的目录：策略与 invoke 用同一判定，看不见 ≡ 调不到
      catalog: kernel
        .describeAll({ caller })
        .map((d) => ({ id: d.id, kind: d.kind, title: d.title, description: d.description })),
      lastResults,
    };
  }

  async function runAction(
    action: AgentAction,
    signal: AbortSignal | undefined,
    emit: (e: AgentEvent) => void,
    step: number,
  ): Promise<AgentActionResult> {
    const kind = kernel.registry.get(action.capabilityId)?.kind;
    if (approve && kind === 'write') {
      // 审批门：dryRun 出 diff 预览，人/规则审过才落地
      const preview = await kernel.invoke(action.capabilityId, action.input, {
        caller,
        dryRun: true,
        signal,
      });
      const allowed =
        preview.ok && (await approve(action, { diff: preview.diff }));
      if (!allowed) {
        const reason = preview.ok ? '审批未通过' : `预览失败: ${preview.error?.message}`;
        emit({ type: 'blocked', step, action, reason });
        return {
          capabilityId: action.capabilityId,
          ok: false,
          blocked: true,
          error: `动作被审批门拦下（${reason}），未执行。如目标必须此步，请换等价方案或收束。`,
        };
      }
    }
    // 统一回灌路由（与 AI 入口同一实现）：失败 content 自动带 explainError hint
    const res = await handleToolCall(kernel, action.capabilityId, action.input ?? {}, {
      caller,
      signal,
    });
    return {
      capabilityId: action.capabilityId,
      ok: !res.is_error,
      output: res.is_error ? undefined : res.outcome.output,
      error: res.is_error ? res.content : undefined,
    };
  }

  async function run(goal: string, opts: AgentRunOptions = {}): Promise<AgentRunResult> {
    const trace: AgentActionResult[] = [];
    const emit = (e: AgentEvent): void => {
      try {
        opts.onEvent?.(e);
      } catch {
        // 观测回调异常不得中断主循环
      }
    };
    const finish = (
      ok: boolean,
      stopReason: AgentStopReason,
      steps: number,
      summary?: string,
      error?: string,
    ): AgentRunResult => {
      emit({ type: 'end', ok, stopReason, steps, summary });
      return { ok, stopReason, steps, trace, summary, error };
    };

    let lastResults: AgentActionResult[] = [];
    for (let step = 1; step <= maxSteps; step++) {
      if (opts.signal?.aborted) return finish(false, 'aborted', step - 1);

      const observation = observe(goal, step, lastResults);
      emit({ type: 'observe', step, observation });

      let decision: AgentDecision;
      try {
        decision = await policy.decide(observation);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return finish(false, 'policy_error', step - 1, undefined, message);
      }
      emit({ type: 'decide', step, decision });

      if (decision.kind === 'done') {
        return finish(true, 'done', step, decision.summary);
      }

      lastResults = [];
      for (const action of decision.actions) {
        if (opts.signal?.aborted) return finish(false, 'aborted', step);
        const result = await runAction(action, opts.signal, emit, step);
        emit({ type: 'act:result', step, result });
        trace.push(result);
        lastResults.push(result);
      }
    }
    return finish(false, 'max_steps', maxSteps);
  }

  return { run };
}
