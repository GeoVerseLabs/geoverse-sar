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
  ObservationEnricher,
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
  approve?: (
    action: AgentAction,
    preview: { diff?: unknown },
  ) => boolean | Promise<boolean>;
  /**
   * 观察增强钩子（T10）：每步基础观察构造后调用，可注入领域摘要（如
   * capabilities-geo 的 createSpatialObserver）。抛异常按 policy_error 处理。
   */
  enrichObservation?: ObservationEnricher;
}

export interface AgentRunOptions {
  signal?: AbortSignal;
  onEvent?: (e: AgentEvent) => void;
}

export interface Agent {
  run(goal: string, opts?: AgentRunOptions): Promise<AgentRunResult>;
}

const AGENT_CALLER: CallerInfo = { entry: 'agent' };

/** kernel createRuntimePack 的观察能力 id（宿主注册后 observe 走能力面）。 */
const STATS_CAPABILITY = 'runtime.stats';

/**
 * 自治 Agent 入口（RFC-0008 M4）：observe→plan→act 循环。
 * 治理不在循环里自建——权限由 kernel 单漏斗强制、审计由中间件同栈入账、
 * 取消经 AbortSignal 贯穿（invoke 写路由前有内核兜底）；本层只加**审批门**
 * （dryRun 预览 + approve 回调）与**步数预算**。
 */
export function createAgent(kernel: SarKernel, options: CreateAgentOptions): Agent {
  const {
    policy,
    maxSteps = 8,
    caller = AGENT_CALLER,
    approve,
    enrichObservation,
  } = options;

  async function observe(
    goal: string,
    step: number,
    lastResults: AgentActionResult[],
    signal?: AbortSignal,
  ): Promise<AgentObservation> {
    // T12-pre（R6 先行）：观察面优先走 runtime.stats 能力——同一漏斗（可审计、
    // 权限一致、可远程化），不再直戳 engine 对象；宿主未注册 runtimePack 或
    // 调用失败时回退对象戳探（进程内耦合仅保留在回退路径）。
    let entityCount: number | undefined;
    let undoDepth: number | undefined;
    if (kernel.registry.get(STATS_CAPABILITY)) {
      const res = await kernel.invoke(STATS_CAPABILITY, {}, { caller, signal });
      if (res.ok) {
        const stats = res.output as { entityCount: number; undoDepth: number | null };
        entityCount = stats.entityCount;
        undoDepth = typeof stats.undoDepth === 'number' ? stats.undoDepth : undefined;
      }
    }
    if (entityCount === undefined) {
      const depth = (kernel.engine as { undoDepth?: number }).undoDepth;
      entityCount = kernel.engine.snapshot().entities.size;
      undoDepth = typeof depth === 'number' ? depth : undefined;
    }
    return {
      goal,
      step,
      maxSteps,
      entityCount,
      undoDepth,
      // 权限裁剪后的目录：策略与 invoke 用同一判定，看不见 ≡ 调不到
      catalog: kernel.describeAll({ caller }).map((d) => ({
        id: d.id,
        kind: d.kind,
        title: d.title,
        description: d.description,
      })),
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
      const allowed = preview.ok && (await approve(action, { diff: preview.diff }));
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

      let observation = await observe(goal, step, lastResults, opts.signal);
      let decision: AgentDecision;
      try {
        if (enrichObservation) observation = await enrichObservation(observation);
        emit({ type: 'observe', step, observation });
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
