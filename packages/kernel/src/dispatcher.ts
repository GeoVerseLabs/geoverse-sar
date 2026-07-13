/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  resolveEffects,
  type Capability,
  type CapabilityContext,
  type CapabilityResult,
  type EffectDescriptor,
} from './capability';
import type { CapabilityRegistry } from './registry';
import type { EventBus } from './eventbus';
import type { Command, DiffAlgebra, StateEngine } from './ports';
import { storeFromSnapshot } from './ports';
import { ReplayDiffCommand, TransactionGroup } from './txgroup';
import { isGranted, PROGRAM_CALLER, type CallerInfo } from './permissions';
import type { Services } from './services';
import { SarError, type SarErrorCode } from './errors';
import { toValidationIssues, type ValidationIssue } from './schema-utils';
import { newTraceId, type ExecutionMode } from './ids';

export interface InvokeOptions {
  caller?: CallerInfo;
  /** AI 预览/人审门（RFC-0008）：返回"这步会改什么"的 diff，但不 apply。 */
  dryRun?: boolean;
  /** 缓冲进指定 TransactionGroup 而非立即 dispatch（Workflow undo:'macro' 用）。 */
  txGroupId?: string;
  /** 取消信号（M4 治理）：handler 前与写路由前检查；已中止 → 错误码 `aborted`。 */
  signal?: AbortSignal;
  /**
   * 执行身份（G1-1）：一次顶层操作的关联 id。缺省时 dispatcher 生成——
   * 工作流/嵌套调用透传同一 traceId，故整棵调用树同 trace 可关联。
   */
  traceId?: string;
  /** 运行实例 id（工作流/durable/agent 运行）：由宿主给，原子 invoke 无则缺席。 */
  runId?: string;
}

/** 写路由期间的当前执行身份（供 kernel 的 engine:transaction 桥接同步读取，关联 journal）。 */
export interface CurrentExecution {
  traceId: string;
  runId?: string;
}

export interface InvokeError {
  code: SarErrorCode;
  message: string;
}

/** 归一出参：一切入口拿到同构结果。 */
export interface InvokeOutcome<O = unknown, TDiff = unknown> {
  ok: boolean;
  capabilityId: string;
  output?: O;
  diff?: TDiff;
  issues?: ValidationIssue[];
  error?: InvokeError;
  durationMs: number;
  dryRun?: boolean;
  /** 执行身份回写（G1-1）：调用方/远程据此关联审计/事件/日志。 */
  traceId?: string;
  runId?: string;
}

export interface MiddlewareContext {
  capabilityId: string;
  kind: string;
  /** 解析后的效应元数据（G1-2）：中间件（otel/审计）可据此标注风险维度。 */
  effects: EffectDescriptor;
  permissions?: readonly string[];
  input: unknown;
  caller: CallerInfo;
  dryRun: boolean;
  /** 执行身份（G1-1）：中间件（审计/otel）据此归因到同一 trace/run。 */
  traceId: string;
  runId?: string;
  mode: ExecutionMode;
}

export type Middleware = (
  ctx: MiddlewareContext,
  next: () => Promise<InvokeOutcome<any, any>>,
) => Promise<InvokeOutcome<any, any>>;

export interface TxGroupHandle<TDiff> {
  id: string;
  label: string;
  size(): number;
  /** 本组自身 staged 的合并 diff（排除 seed），不 dispatch——预览组终局取此再 abort。 */
  previewDiff(): TDiff | undefined;
  commit(): { ok: boolean; diff?: TDiff; error?: string };
  abort(): void;
}

export interface BeginGroupOptions<TDiff> {
  /**
   * 投影基座：以既有 staged diff 为投影起点（嵌套预览用——步骤能"看见"外层组的缓冲效果）。
   * ⚠️ seed 会随 commit 一并落地：带 seed 的组只应作预览（终局 previewDiff + abort），不要 commit。
   */
  seed?: TDiff[];
  /** 执行身份（G1-1）：commit 时置位，使宏事务的 engine:transaction 关联到发起 trace/run。 */
  exec?: CurrentExecution;
}

interface DispatcherDeps<TEntity, TDiff> {
  registry: CapabilityRegistry<TEntity, TDiff>;
  engine: StateEngine<TEntity, TDiff>;
  algebra: DiffAlgebra<TEntity, TDiff>;
  services: Services;
  events: EventBus<TDiff>;
  middleware?: Middleware[];
}

let groupSeq = 0;

/**
 * 单一漏斗（ADR-0010）：解析 → 中间件洋葱（权限/日志）→ Zod 校验（失败回结构化
 * issues 供 AI 自纠）→ handler → 写路由（engine.dispatch / TransactionGroup 缓冲）
 * → 事件 → 归一 InvokeOutcome。用户点击、AI 调用、MCP 调用只是 caller.entry 不同。
 */
export class Dispatcher<TEntity, TDiff> {
  private groups = new Map<string, TransactionGroup<TEntity, TDiff>>();
  /**
   * 写路由期间的当前执行身份（G1-1）：只在**同步**写路由区间内置位（无 await），
   * kernel 的 engine:transaction 桥接同步读取，把 dispatch 事务关联到发起 trace/run。
   * async 隔离——不跨 await 持有，避免并发 invoke 交错时身份串号。
   */
  private currentExec: CurrentExecution | undefined;

  constructor(private readonly deps: DispatcherDeps<TEntity, TDiff>) {}

  /** kernel 事务桥接读取：写路由外恒为 undefined（undo/redo 等非 dispatch 事务不关联）。 */
  getCurrentExecution(): CurrentExecution | undefined {
    return this.currentExec;
  }

  /** 在同步区间内置位当前执行身份（无 await；异常/正常都复位）——journal 关联用。 */
  private withExecution<T>(exec: CurrentExecution | undefined, fn: () => T): T {
    const prev = this.currentExec;
    this.currentExec = exec;
    try {
      return fn();
    } finally {
      this.currentExec = prev;
    }
  }

  /** 开启宏事务组：随后的 invoke 传 txGroupId 即缓冲；commit 折叠为一个撤销单元。 */
  beginGroup(label: string, opts?: BeginGroupOptions<TDiff>): TxGroupHandle<TDiff> {
    const id = `txg-${++groupSeq}`;
    const group = new TransactionGroup(
      this.deps.engine,
      this.deps.algebra,
      label,
      id,
      opts?.seed ?? [],
    );
    this.groups.set(id, group);
    return {
      id,
      label,
      size: () => group.size,
      previewDiff: () => group.mergedOwnDiff(),
      commit: () => {
        this.groups.delete(id);
        const res = this.withExecution(opts?.exec, () => group.commit());
        if (res === undefined) return { ok: true };
        return res.ok ? { ok: true, diff: res.diff } : { ok: false, error: res.error };
      },
      abort: () => {
        this.groups.delete(id);
        group.abort();
      },
    };
  }

  getGroup(id: string): TransactionGroup<TEntity, TDiff> | undefined {
    return this.groups.get(id);
  }

  async invoke<O = unknown>(
    id: string,
    input: unknown,
    opts: InvokeOptions = {},
  ): Promise<InvokeOutcome<O, TDiff>> {
    const start = Date.now();
    const caller = opts.caller ?? PROGRAM_CALLER;
    const dryRun = opts.dryRun ?? false;
    const traceId = opts.traceId ?? newTraceId();
    const runId = opts.runId;
    const mode: ExecutionMode = dryRun ? 'preview' : 'execute';
    const done = (
      partial: Omit<
        InvokeOutcome<O, TDiff>,
        'capabilityId' | 'durationMs' | 'traceId' | 'runId'
      >,
    ): InvokeOutcome<O, TDiff> => ({
      ...partial,
      capabilityId: id,
      durationMs: Date.now() - start,
      traceId,
      ...(runId ? { runId } : {}),
    });

    // 未注册能力也走完整漏斗（事件成对 + 中间件可见）——
    // ErrorMonitor 等观测中间件必须能看到 capability_not_found（模型幻觉工具名的高频场景）
    const cap = this.deps.registry.get(id);

    this.deps.events.emit({
      type: 'invoke:start',
      capabilityId: id,
      caller,
      dryRun,
      traceId,
      ...(runId ? { runId } : {}),
    });

    const mctx: MiddlewareContext = {
      capabilityId: id,
      kind: cap?.kind ?? 'unknown',
      // 未注册能力永不执行——给一份保守缺省（action）以满足类型，不影响任何判定
      effects: cap ? resolveEffects(cap.kind, cap.effects) : resolveEffects('action'),
      permissions: cap?.permissions,
      input,
      caller,
      dryRun,
      traceId,
      runId,
      mode,
    };
    const core = (): Promise<InvokeOutcome<O, TDiff>> =>
      cap
        ? this.execute<O>(
            cap,
            mctx.input,
            caller,
            dryRun,
            traceId,
            runId,
            mode,
            opts,
            done,
          )
        : Promise.resolve(
            done({
              ok: false,
              error: { code: 'capability_not_found', message: `能力不存在: ${id}` },
            }),
          );
    const chain = (this.deps.middleware ?? []).reduceRight<
      () => Promise<InvokeOutcome<any, any>>
    >((next, mw) => () => mw(mctx, next), core);

    let outcome: InvokeOutcome<O, TDiff>;
    try {
      outcome = (await chain()) as InvokeOutcome<O, TDiff>;
    } catch (e) {
      outcome = done({
        ok: false,
        error: {
          code: e instanceof SarError ? e.code : 'handler_error',
          message: e instanceof Error ? e.message : String(e),
        },
      });
    }

    this.deps.events.emit({
      type: 'invoke:end',
      capabilityId: id,
      caller,
      ok: outcome.ok,
      durationMs: outcome.durationMs,
      errorCode: outcome.error?.code,
      traceId,
      ...(runId ? { runId } : {}),
    });
    return outcome;
  }

  private async execute<O>(
    cap: Capability<any, any, TEntity, TDiff>,
    input: unknown,
    caller: CallerInfo,
    dryRun: boolean,
    traceId: string,
    runId: string | undefined,
    mode: ExecutionMode,
    opts: InvokeOptions,
    done: (
      partial: Omit<
        InvokeOutcome<O, TDiff>,
        'capabilityId' | 'durationMs' | 'traceId' | 'runId'
      >,
    ) => InvokeOutcome<O, TDiff>,
  ): Promise<InvokeOutcome<O, TDiff>> {
    // 取消信号：handler 执行前检查（写路由前还有一次兜底）
    if (opts.signal?.aborted) {
      return done({
        ok: false,
        error: { code: 'aborted', message: `调用已被取消: ${cap.id}` },
      });
    }

    // 权限强制：describeAll 裁剪目录，invoke 用同一判定兜底
    if (!isGranted(cap.permissions, caller)) {
      return done({
        ok: false,
        error: {
          code: 'permission_denied',
          message: `无权调用能力 ${cap.id}（需要 ${cap.permissions?.join(', ')}）`,
        },
      });
    }

    // 服务依赖前置校验：缺失在入口报 service_missing，而非 handler 深处抛裸错
    const missing = (cap.requires ?? []).filter(
      (key) => this.deps.services.get(key) === undefined,
    );
    if (missing.length > 0) {
      return done({
        ok: false,
        error: {
          code: 'service_missing',
          message: `能力 ${cap.id} 依赖的服务未注册: ${missing.join(', ')}（createKernel 的 services 里注入）`,
        },
      });
    }

    // Zod 校验：失败回结构化 issues（AI 经 is_error 回灌自纠）
    const parsed = cap.inputSchema.safeParse(input ?? {});
    if (!parsed.success) {
      return done({
        ok: false,
        error: { code: 'validation_failed', message: '入参校验失败' },
        issues: toValidationIssues(parsed.error),
      });
    }

    const activeGroup = opts.txGroupId ? this.groups.get(opts.txGroupId) : undefined;
    if (opts.txGroupId && !activeGroup) {
      return done({
        ok: false,
        error: { code: 'tx_group_not_found', message: `事务组不存在: ${opts.txGroupId}` },
      });
    }

    const ctx: CapabilityContext<TEntity, TDiff> = {
      engine: this.deps.engine,
      algebra: this.deps.algebra,
      state: activeGroup
        ? activeGroup.projectedState()
        : storeFromSnapshot(this.deps.engine.snapshot()),
      services: this.deps.services,
      caller,
      signal: opts.signal,
      dryRun,
      txGroupId: opts.txGroupId,
      traceId,
      runId,
      mode,
    };

    let result: CapabilityResult<O, TEntity, TDiff>;
    try {
      result = await cap.handler(ctx, parsed.data);
    } catch (e) {
      // SarError 保码（Gate 0）：组合型能力（workflow 投影）内部失败的真实错误码
      // （aborted / validation_failed / workflow_aborted…）不再被压扁成 handler_error
      return done({
        ok: false,
        error: {
          code: e instanceof SarError ? e.code : 'handler_error',
          message: e instanceof Error ? e.message : String(e),
        },
      });
    }

    // 出参校验：能力作者契约兜底（描述符即承诺）
    const outParsed = cap.outputSchema.safeParse(result.output);
    if (!outParsed.success) {
      return done({
        ok: false,
        error: { code: 'handler_error', message: '能力输出不符合 outputSchema' },
        issues: toValidationIssues(outParsed.error),
      });
    }
    const output = outParsed.data as O;

    // 取消信号：async handler 期间可能已中止——写路由前兜底，保证不落地半途取消的变更
    if (opts.signal?.aborted) {
      return done({
        ok: false,
        error: { code: 'aborted', message: `调用已被取消（未写入）: ${cap.id}` },
      });
    }

    // 写路由
    const label = ('label' in result ? result.label : undefined) ?? cap.title;
    const commands: Command<TEntity, TDiff>[] =
      'commands' in result
        ? result.commands
        : 'diff' in result
          ? [new ReplayDiffCommand<TEntity, TDiff>(result.diff, label)]
          : [];

    if (commands.length === 0) {
      return done({ ok: true, output, dryRun: dryRun || undefined });
    }

    if (dryRun) {
      // 预览：在（可选事务组投影之上的）临时组里 plan，不 dispatch、不入缓冲
      const preview = new TransactionGroup(
        this.deps.engine,
        this.deps.algebra,
        label,
        'txg-dry',
        activeGroup ? activeGroup.stagedDiffs() : [],
      );
      const staged: TDiff[] = [];
      try {
        for (const cmd of commands) staged.push(preview.stage(cmd));
      } catch (e) {
        return done({
          ok: false,
          error: {
            code: 'handler_error',
            message: e instanceof Error ? e.message : String(e),
          },
        });
      }
      const diff = this.deps.algebra.merge(staged, label);
      return done({ ok: true, output, diff, dryRun: true });
    }

    if (activeGroup) {
      // 缓冲进宏事务组：plan 抛异常 → abort 整组（ADR-0012）
      const staged: TDiff[] = [];
      try {
        for (const cmd of commands) staged.push(activeGroup.stage(cmd));
      } catch (e) {
        activeGroup.abort();
        this.groups.delete(opts.txGroupId!);
        return done({
          ok: false,
          error: {
            code: 'workflow_aborted',
            message: `事务组 ${opts.txGroupId} 已中止: ${e instanceof Error ? e.message : String(e)}`,
          },
        });
      }
      return done({ ok: true, output, diff: this.deps.algebra.merge(staged, label) });
    }

    // 隐式组：一次 invoke 的多命令也折叠为一个撤销单元
    const group = new TransactionGroup(this.deps.engine, this.deps.algebra, label);
    try {
      for (const cmd of commands) group.stage(cmd);
    } catch (e) {
      group.abort();
      return done({
        ok: false,
        error: {
          code: 'handler_error',
          message: e instanceof Error ? e.message : String(e),
        },
      });
    }
    const res = this.withExecution({ traceId, runId }, () => group.commit());
    if (res === undefined) return done({ ok: true, output });
    if (!res.ok) {
      return done({ ok: false, error: { code: 'engine_rejected', message: res.error } });
    }
    return done({ ok: true, output, diff: res.diff });
  }
}
