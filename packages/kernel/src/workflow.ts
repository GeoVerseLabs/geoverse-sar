/* eslint-disable @typescript-eslint/no-explicit-any */
import { z } from 'zod';
import type { CapabilityKind } from './capability';
import type { Dispatcher, InvokeOutcome, TxGroupHandle } from './dispatcher';
import type { CapabilityRegistry } from './registry';
import type { EventBus } from './eventbus';
import { SarError, type SarErrorCode } from './errors';
import { PROGRAM_CALLER, type CallerInfo } from './permissions';
import { toValidationIssues, type ValidationIssue } from './schema-utils';
import { newRunId, newTraceId } from './ids';

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

export interface WorkflowRunOptions {
  caller?: CallerInfo;
  /**
   * 预览（Gate 0 契约修复）：全部步骤 stage 进一个预览事务组（步间投影可见——
   * 第 N 步能看见第 N-1 步的效果），终局取合并 diff 后 abort——引擎零写入、
   * undo 栈不长。与原子能力 dryRun 语义一致：handler 仍会执行（read/action 步的
   * 进程内副作用照旧发生，效应级预览待 EffectDescriptor/Gate 1），只拦状态写入。
   * dryRun 下不触发 onStep（预览不是持久化进度）。
   */
  dryRun?: boolean;
  /** 取消信号：步间检查 + 逐步透传给 dispatcher.invoke；中止时宏组 abort，错误码 `aborted`。 */
  signal?: AbortSignal;
  /**
   * 外层事务组 id（嵌套：本工作流作为另一工作流/宏组的步骤被调）：
   * 写步全部 stage 进该组、不自行 commit——外层原子性支配，宏撤销不被内层提前提交击穿。
   */
  txGroupId?: string;
  /**
   * 执行身份（G1-1）：一条工作流全程共享一个 traceId，内部步骤继承它——
   * "调用了哪些步骤"可用单一 trace 关联。缺省时 run() 生成；以能力形式/嵌套调用时
   * 由投影 handler 透传 ctx 的 traceId（同树同 trace）。runId 标识本次运行实例。
   */
  traceId?: string;
  runId?: string;
  /**
   * durable run 支持（RFC-0009 F1）：每步成功后回调，**await 完成才进下一步**——
   * 持久化宿主（workspace）据此把进度落 store，崩溃后可跳已完成步续跑。
   */
  onStep?: (stepId: string, output: unknown) => void | Promise<void>;
  /**
   * 断点续跑：stepId→output 预填并跳过执行（其 diff 已随 per-step 提交落引擎/journal）。
   * 仅 undo:'per-step'|'none' 支持；macro 是原子单元，带 resume 直接拒绝（应整体重跑）。
   */
  resume?: Record<string, unknown>;
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
  /** 预览运行标记：diff 未落地（与 InvokeOutcome.dryRun 同语义）。 */
  dryRun?: boolean;
  /** 执行身份（G1-1）：本次运行的 traceId/runId，供调用方关联审计/事件/日志。 */
  traceId: string;
  runId: string;
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
        // Gate 0 契约修复：dryRun/signal/外层组全部透传——"以能力形式调 workflow"
        // 与直接 runWorkflow 同语义，预览不再被内部真实写入击穿。
        // G1-1：透传 ctx 的 traceId——整棵调用树（含嵌套）同一 trace 关联。
        const run = await this.run(wf.id, input, {
          caller: ctx.caller,
          dryRun: ctx.dryRun,
          signal: ctx.signal,
          txGroupId: ctx.txGroupId,
          traceId: ctx.traceId,
          runId: ctx.runId,
        });
        if (!run.ok) {
          throw new SarError(
            run.error?.code === 'aborted' ? 'aborted' : 'workflow_aborted',
            run.error?.message ?? `工作流失败于步骤 ${run.failedStepId}`,
          );
        }
        if (ctx.dryRun && run.diff !== undefined) {
          // 预览：把合并 diff 交还外层写路由的 dryRun 分支——与原子能力同一出口形状
          return { output: run.output, diff: run.diff };
        }
        // 执行：diff 已由步骤落地（macro commit / per-step 即时 / 并入外层组缓冲），
        // 此处只回 output，勿再走写路由
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
    opts: WorkflowRunOptions = {},
  ): Promise<WorkflowRunResult<O, TDiff>> {
    // 执行身份（G1-1）：整条工作流全程一个 traceId（以能力形式/嵌套调用时由投影
    // handler 透传 ctx.traceId → 同树同 trace）；runId 标识本次运行实例。
    const traceId = opts.traceId ?? newTraceId();
    const runId = opts.runId ?? newRunId();
    const wf = this.workflows.get(id);
    if (!wf) {
      return {
        ok: false,
        workflowId: id,
        error: { code: 'workflow_not_found', message: `工作流不存在: ${id}` },
        steps: {},
        traceId,
        runId,
      };
    }
    if (opts.resume && wf.undo === 'macro') {
      return {
        ok: false,
        workflowId: id,
        error: {
          code: 'workflow_aborted',
          message: 'macro 工作流是原子单元，不支持断点续跑——缓冲 diff 未落地，请整体重跑',
        },
        steps: {},
        traceId,
        runId,
      };
    }
    const caller = opts.caller ?? PROGRAM_CALLER;
    const dryRun = opts.dryRun ?? false;
    const signal = opts.signal;

    const parsed = wf.inputSchema.safeParse(input ?? {});
    if (!parsed.success) {
      return {
        ok: false,
        workflowId: id,
        error: { code: 'validation_failed', message: '工作流入参校验失败' },
        issues: toValidationIssues(parsed.error),
        steps: {},
        traceId,
        runId,
      };
    }

    this.events.emit({
      type: 'workflow:start',
      workflowId: id,
      caller,
      traceId,
      runId,
      ...(dryRun ? { dryRun: true } : {}),
    });
    const scope: WorkflowScope = { input: parsed.data, steps: {} };

    // 组选择（Gate 0）：
    // - dryRun：无论 undo 模式，自建预览组（外层组的缓冲作 seed 投影基座）——
    //   步骤 stage 进组保证步间可见，终局取合并 diff 后 abort，引擎零写入；
    // - 嵌套（外层已有事务组）：写步并入外层组，不自建不自 commit——外层原子性支配；
    // - macro：自建宏组，终局 commit 折叠为一个撤销单元；
    // - per-step/none：无组，各步即时落地（每写步独立撤销单元）。
    let ownGroup: TxGroupHandle<TDiff> | undefined;
    let groupId: string | undefined;
    if (dryRun) {
      const outer = opts.txGroupId ? this.dispatcher.getGroup(opts.txGroupId) : undefined;
      ownGroup = this.dispatcher.beginGroup(wf.title, {
        seed: outer ? outer.stagedDiffs() : [],
      });
      groupId = ownGroup.id;
    } else if (opts.txGroupId) {
      groupId = opts.txGroupId;
    } else if (wf.undo === 'macro') {
      // exec 透传：宏组 commit 时置位当前执行身份 → 合并事务的 journal 归因到本 run
      ownGroup = this.dispatcher.beginGroup(wf.title, { exec: { traceId, runId } });
      groupId = ownGroup.id;
    }

    const fail = (
      stepId: string | undefined,
      outcome: Pick<InvokeOutcome, 'error' | 'issues'>,
    ): WorkflowRunResult<O, TDiff> => {
      ownGroup?.abort();
      this.events.emit({
        type: 'workflow:end',
        workflowId: id,
        ok: false,
        failedStepId: stepId,
        traceId,
        runId,
        ...(dryRun ? { dryRun: true } : {}),
      });
      return {
        ok: false,
        workflowId: id,
        failedStepId: stepId,
        error: outcome.error ?? { code: 'workflow_aborted', message: '工作流中止' },
        issues: outcome.issues,
        steps: scope.steps,
        traceId,
        runId,
        ...(dryRun ? { dryRun: true } : {}),
      };
    };

    for (const step of wf.steps) {
      // 取消信号：步间检查（步内由 dispatcher 的 handler 前/写路由前双检查兜底）
      if (signal?.aborted) {
        return fail(step.id, {
          error: { code: 'aborted', message: `工作流已被取消: ${id}` },
        });
      }
      // 断点续跑：已完成步直接回填输出（when 上次已判过，不重判）
      if (opts.resume && step.id in opts.resume) {
        scope.steps[step.id] = opts.resume[step.id];
        continue;
      }
      if (step.when && !step.when(scope)) continue;
      const stepInput =
        typeof step.input === 'function'
          ? (step.input as (s: WorkflowScope) => unknown)(scope)
          : step.input;
      const outcome = await this.dispatcher.invoke(step.capability, stepInput, {
        caller,
        txGroupId: groupId,
        signal,
        traceId,
        runId,
      });
      if (!outcome.ok) return fail(step.id, outcome);
      scope.steps[step.id] = outcome.output;
      // 预览不是持久化进度：durable 宿主的 onStep 只在真实执行时触发
      if (!dryRun) await opts.onStep?.(step.id, outcome.output);
    }

    let diff: TDiff | undefined;
    if (ownGroup) {
      if (dryRun) {
        diff = ownGroup.previewDiff();
        ownGroup.abort();
      } else {
        const res = ownGroup.commit();
        if (!res.ok) {
          return fail(undefined, {
            error: {
              code: 'engine_rejected',
              message: res.error ?? '引擎拒绝合并 diff',
            },
          });
        }
        diff = res.diff;
      }
    }

    this.events.emit({
      type: 'workflow:end',
      workflowId: id,
      ok: true,
      traceId,
      runId,
      ...(dryRun ? { dryRun: true } : {}),
    });
    const output = (wf.output ? wf.output(scope) : scope.steps) as O;
    return {
      ok: true,
      workflowId: id,
      output,
      diff,
      steps: scope.steps,
      traceId,
      runId,
      ...(dryRun ? { dryRun: true } : {}),
    };
  }
}
