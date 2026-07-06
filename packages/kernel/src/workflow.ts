/* eslint-disable @typescript-eslint/no-explicit-any */
import { z } from 'zod';
import type { CapabilityKind } from './capability';
import type { Dispatcher, InvokeOutcome } from './dispatcher';
import type { CapabilityRegistry } from './registry';
import type { EventBus } from './eventbus';
import { SarError, type SarErrorCode } from './errors';
import { PROGRAM_CALLER, type CallerInfo } from './permissions';
import { toValidationIssues, type ValidationIssue } from './schema-utils';

export interface WorkflowScope<I = any> {
  input: I;
  /** 步间数据流：steps[stepId] = 该步 outcome.output。 */
  steps: Record<string, unknown>;
}

export interface WorkflowStep<I = any> {
  id: string;
  capability: string;
  /** 静态入参，或由 scope 计算（引用前步输出）。 */
  input?: unknown | ((scope: WorkflowScope<I>) => unknown);
  /** 条件步：false 则跳过。 */
  when?: (scope: WorkflowScope<I>) => boolean;
}

/**
 * Workflow（ADR-0010）：能力组合 + 步间数据流。
 * undo:'macro' 全程共享一个 TransactionGroup，结束 commit——整条工作流一个撤销单元。
 */
export interface Workflow<I = any, O = any> {
  id: string;
  title: string;
  description: string;
  category?: string;
  /** 投影成 capability-shaped 描述符时的 kind；缺省：undo==='none' → action，否则 write。 */
  kind?: CapabilityKind;
  inputSchema: z.ZodType<I, any>;
  outputSchema?: z.ZodType<O, any>;
  /** 最终输出投影；缺省返回 scope.steps。 */
  output?: (scope: WorkflowScope<I>) => O;
  steps: WorkflowStep<I>[];
  undo: 'macro' | 'per-step' | 'none';
  tags?: readonly string[];
  permissions?: readonly string[];
}

export interface WorkflowRunResult<O = unknown, TDiff = unknown> {
  ok: boolean;
  workflowId: string;
  output?: O;
  /** undo:'macro' 且有写步时的合并 diff。 */
  diff?: TDiff;
  failedStepId?: string;
  error?: { code: SarErrorCode | string; message: string };
  issues?: ValidationIssue[];
  /** 各步 output（含跳过步缺席），调试/观测用。 */
  steps: Record<string, unknown>;
}

export class WorkflowRegistry<TEntity = any, TDiff = any> {
  private workflows = new Map<string, Workflow>();

  constructor(
    private readonly dispatcher: Dispatcher<TEntity, TDiff>,
    private readonly registry: CapabilityRegistry<TEntity, TDiff>,
    private readonly events: EventBus<TDiff>,
  ) {}

  /**
   * 注册工作流，并把它投影成同 id 的能力（"工作流即工具"）：
   * AI/UI 一次调用跑多步，宏撤销一键回滚。
   */
  register(wf: Workflow): void {
    if (this.workflows.has(wf.id)) {
      throw new SarError('workflow_conflict', `工作流 id 已注册: ${wf.id}`);
    }
    this.workflows.set(wf.id, wf);
    this.registry.register({
      id: wf.id,
      title: wf.title,
      description: wf.description,
      category: wf.category ?? 'workflow',
      kind: wf.kind ?? (wf.undo === 'none' ? 'action' : 'write'),
      inputSchema: wf.inputSchema,
      outputSchema: wf.outputSchema ?? z.unknown(),
      tags: wf.tags,
      permissions: wf.permissions,
      undoable: wf.undo !== 'none',
      handler: async (ctx, input) => {
        const run = await this.run(wf.id, input, { caller: ctx.caller });
        if (!run.ok) {
          throw new SarError(
            'workflow_aborted',
            run.error?.message ?? `工作流失败于步骤 ${run.failedStepId}`,
          );
        }
        // diff 已由步骤经引擎应用（macro commit），此处只回 output，勿再走写路由
        return { output: run.output };
      },
    });
  }

  get(id: string): Workflow | undefined {
    return this.workflows.get(id);
  }

  list(): Workflow[] {
    return [...this.workflows.values()];
  }

  async run<O = unknown>(
    id: string,
    input: unknown,
    opts: { caller?: CallerInfo } = {},
  ): Promise<WorkflowRunResult<O, TDiff>> {
    const wf = this.workflows.get(id);
    if (!wf) {
      return {
        ok: false,
        workflowId: id,
        error: { code: 'workflow_not_found', message: `工作流不存在: ${id}` },
        steps: {},
      };
    }
    const caller = opts.caller ?? PROGRAM_CALLER;

    const parsed = wf.inputSchema.safeParse(input ?? {});
    if (!parsed.success) {
      return {
        ok: false,
        workflowId: id,
        error: { code: 'validation_failed', message: '工作流入参校验失败' },
        issues: toValidationIssues(parsed.error),
        steps: {},
      };
    }

    this.events.emit({ type: 'workflow:start', workflowId: id, caller });
    const scope: WorkflowScope = { input: parsed.data, steps: {} };
    const group = wf.undo === 'macro' ? this.dispatcher.beginGroup(wf.title) : undefined;

    const fail = (
      stepId: string | undefined,
      outcome: Pick<InvokeOutcome, 'error' | 'issues'>,
    ): WorkflowRunResult<O, TDiff> => {
      group?.abort();
      this.events.emit({
        type: 'workflow:end',
        workflowId: id,
        ok: false,
        failedStepId: stepId,
      });
      return {
        ok: false,
        workflowId: id,
        failedStepId: stepId,
        error: outcome.error ?? { code: 'workflow_aborted', message: '工作流中止' },
        issues: outcome.issues,
        steps: scope.steps,
      };
    };

    for (const step of wf.steps) {
      if (step.when && !step.when(scope)) continue;
      const stepInput =
        typeof step.input === 'function'
          ? (step.input as (s: WorkflowScope) => unknown)(scope)
          : step.input;
      const outcome = await this.dispatcher.invoke(step.capability, stepInput, {
        caller,
        txGroupId: group?.id,
      });
      if (!outcome.ok) return fail(step.id, outcome);
      scope.steps[step.id] = outcome.output;
    }

    let diff: TDiff | undefined;
    if (group) {
      const res = group.commit();
      if (!res.ok) {
        return fail(undefined, {
          error: { code: 'engine_rejected', message: res.error ?? '引擎拒绝合并 diff' },
        });
      }
      diff = res.diff;
    }

    this.events.emit({ type: 'workflow:end', workflowId: id, ok: true });
    const output = (wf.output ? wf.output(scope) : scope.steps) as O;
    return { ok: true, workflowId: id, output, diff, steps: scope.steps };
  }
}
