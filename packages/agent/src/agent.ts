import {
  newRunId,
  type CapabilityDescriptor,
  type SarClient,
} from '@geoverse-sar/kernel';
import { handleToolCallVia } from '@geoverse-sar/skill';
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
   * 审批门（人审/规则审）：写动作先 dryRun 出「将改什么」的 diff，审批通过才真执行；
   * 返回 false → 动作被拦（blocked），agent 继续但策略会在下一步观察到。
   * 缺省 = 全放行。read/action 类不过门。
   */
  approve?: (
    action: AgentAction,
    preview: { diff?: unknown; runId?: string },
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
  /** 执行身份（G1-1）：显式给则本次运行的所有 invoke 用它；缺省自动生成。 */
  runId?: string;
}

export interface Agent {
  run(goal: string, opts?: AgentRunOptions): Promise<AgentRunResult>;
}

/** kernel createRuntimePack 的观察能力 id（宿主注册后 observe 走能力面）。 */
const STATS_CAPABILITY = 'runtime.stats';

/**
 * 自治 Agent 入口（RFC-0008 M4；T12/R6 起依赖 SarClient 切面）：observe→plan→act。
 * 身份由 client 构造绑定（本地 `clientOf(kernel, { entry: 'agent', ... })`，远程由
 * 服务端注入）——权限裁剪目录与 invoke 强制同一判定，循环里无处伪造。
 * 治理不在循环里自建——权限/审计/取消全由单漏斗承担；本层只加**审批门**
 * （dryRun 预览 + approve 回调）与**步数预算**。
 */
export function createAgent(sar: SarClient, options: CreateAgentOptions): Agent {
  const { policy, maxSteps = 8, approve, enrichObservation } = options;

  async function observe(
    goal: string,
    step: number,
    lastResults: AgentActionResult[],
    signal: AbortSignal | undefined,
    runId: string,
  ): Promise<{ observation: AgentObservation; catalog: CapabilityDescriptor[] }> {
    // 权限裁剪后的目录：caller 在 client 绑定，看不见 ≡ 调不到
    const catalog = await sar.catalog();
    // 观察面走能力（runtime.stats，同漏斗可审计、远程 agent 自动成立）；
    // 宿主未注册 runtimePack 或调用失败 → 计数留空，策略只依赖目录与动作结果。
    let entityCount: number | undefined;
    let undoDepth: number | undefined;
    if (catalog.some((d) => d.id === STATS_CAPABILITY)) {
      const res = await sar.invoke(STATS_CAPABILITY, {}, { signal, runId });
      if (res.ok) {
        const stats = res.output as { entityCount: number; undoDepth: number | null };
        entityCount = stats.entityCount;
        undoDepth = typeof stats.undoDepth === 'number' ? stats.undoDepth : undefined;
      }
    }
    return {
      catalog,
      observation: {
        goal,
        step,
        maxSteps,
        entityCount,
        undoDepth,
        catalog: catalog.map((d) => ({
          id: d.id,
          kind: d.kind,
          title: d.title,
          description: d.description,
          effects: d.effects,
        })),
        lastResults,
      },
    };
  }

  async function runAction(
    action: AgentAction,
    catalog: CapabilityDescriptor[],
    signal: AbortSignal | undefined,
    emit: (e: AgentEvent) => void,
    step: number,
    runId: string,
  ): Promise<AgentActionResult> {
    const desc = catalog.find((d) => d.id === action.capabilityId);
    // G1-2：审批判据从 kind==='write' 升级为 effect-aware——
    // effects.approval!=='never' 即过门（含声明 approval:'always' 的危险 action，修复 P0-3）。
    // effects 缺席（老目录）时退化到 kind==='write' 兼容。
    const effects = desc?.effects;
    const needsApproval = effects ? effects.approval !== 'never' : desc?.kind === 'write';
    if (approve && needsApproval) {
      // 预览安全性：dryRun 下 handler 仍执行，只拦状态写入——外部副作用/不可逆操作
      // 若 dryRun 会**真的触发副作用**，故只对"可逆且无外部副作用"的能力做 dryRun 取
      // diff；其余直接交审批（无 diff 预览，人只看动作意图）。
      const canPreview =
        !effects || (effects.external === 'none' && effects.state !== 'irreversible');
      let previewDiff: unknown;
      let previewOk = true;
      if (canPreview) {
        const preview = await sar.invoke(action.capabilityId, action.input, {
          dryRun: true,
          signal,
          runId,
        });
        previewOk = preview.ok;
        previewDiff = preview.diff;
      }
      const allowed = previewOk && (await approve(action, { diff: previewDiff, runId }));
      if (!allowed) {
        const reason = previewOk ? '审批未通过' : '预览失败';
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
    const res = await handleToolCallVia(sar, action.capabilityId, action.input ?? {}, {
      signal,
      catalog,
      runId,
    });
    return {
      capabilityId: action.capabilityId,
      ok: !res.is_error,
      output: res.is_error ? undefined : res.outcome.output,
      error: res.is_error ? res.content : undefined,
    };
  }

  async function run(goal: string, opts: AgentRunOptions = {}): Promise<AgentRunResult> {
    // 执行身份（G1-1）：一次 agent 运行的所有 invoke（观察 stats / 审批预览 / 动作）
    // 共享一个 runId——审计/事件按 runId 即可重建这一次自治运行的完整时间线。
    const runId = opts.runId ?? newRunId();
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
      return { ok, stopReason, steps, trace, summary, error, runId };
    };

    let lastResults: AgentActionResult[] = [];
    for (let step = 1; step <= maxSteps; step++) {
      if (opts.signal?.aborted) return finish(false, 'aborted', step - 1);

      let decision: AgentDecision;
      let catalog: CapabilityDescriptor[];
      try {
        const observed = await observe(goal, step, lastResults, opts.signal, runId);
        catalog = observed.catalog;
        let observation = observed.observation;
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
        const result = await runAction(action, catalog, opts.signal, emit, step, runId);
        emit({ type: 'act:result', step, result });
        trace.push(result);
        lastResults.push(result);
      }
    }
    return finish(false, 'max_steps', maxSteps);
  }

  return { run };
}
