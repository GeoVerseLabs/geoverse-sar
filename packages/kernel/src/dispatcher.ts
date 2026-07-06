/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Capability, CapabilityContext, CapabilityResult } from './capability';
import type { CapabilityRegistry } from './registry';
import type { EventBus } from './eventbus';
import type { Command, DiffAlgebra, StateEngine } from './ports';
import { storeFromSnapshot } from './ports';
import { ReplayDiffCommand, TransactionGroup } from './txgroup';
import { isGranted, PROGRAM_CALLER, type CallerInfo } from './permissions';
import type { Services } from './services';
import type { SarErrorCode } from './errors';
import { toValidationIssues, type ValidationIssue } from './schema-utils';

export interface InvokeOptions {
  caller?: CallerInfo;
  /** AI 预览/人审门（RFC-0008）：返回"这步会改什么"的 diff，但不 apply。 */
  dryRun?: boolean;
  /** 缓冲进指定 TransactionGroup 而非立即 dispatch（Workflow undo:'macro' 用）。 */
  txGroupId?: string;
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
}

export interface MiddlewareContext {
  capabilityId: string;
  kind: string;
  permissions?: readonly string[];
  input: unknown;
  caller: CallerInfo;
  dryRun: boolean;
}

export type Middleware = (
  ctx: MiddlewareContext,
  next: () => Promise<InvokeOutcome<any, any>>,
) => Promise<InvokeOutcome<any, any>>;

export interface TxGroupHandle<TDiff> {
  id: string;
  label: string;
  size(): number;
  commit(): { ok: boolean; diff?: TDiff; error?: string };
  abort(): void;
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

  constructor(private readonly deps: DispatcherDeps<TEntity, TDiff>) {}

  /** 开启宏事务组：随后的 invoke 传 txGroupId 即缓冲；commit 折叠为一个撤销单元。 */
  beginGroup(label: string): TxGroupHandle<TDiff> {
    const id = `txg-${++groupSeq}`;
    const group = new TransactionGroup(this.deps.engine, this.deps.algebra, label, id);
    this.groups.set(id, group);
    return {
      id,
      label,
      size: () => group.size,
      commit: () => {
        this.groups.delete(id);
        const res = group.commit();
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
    const done = (
      partial: Omit<InvokeOutcome<O, TDiff>, 'capabilityId' | 'durationMs'>,
    ): InvokeOutcome<O, TDiff> => ({
      ...partial,
      capabilityId: id,
      durationMs: Date.now() - start,
    });

    const cap = this.deps.registry.get(id);
    if (!cap) {
      return done({
        ok: false,
        error: { code: 'capability_not_found', message: `能力不存在: ${id}` },
      });
    }

    this.deps.events.emit({ type: 'invoke:start', capabilityId: id, caller, dryRun });

    const mctx: MiddlewareContext = {
      capabilityId: id,
      kind: cap.kind,
      permissions: cap.permissions,
      input,
      caller,
      dryRun,
    };
    const core = () => this.execute<O>(cap, mctx.input, caller, dryRun, opts, done);
    const chain = (this.deps.middleware ?? []).reduceRight<
      () => Promise<InvokeOutcome<any, any>>
    >((next, mw) => () => mw(mctx, next), core);

    let outcome: InvokeOutcome<O, TDiff>;
    try {
      outcome = (await chain()) as InvokeOutcome<O, TDiff>;
    } catch (e) {
      outcome = done({
        ok: false,
        error: { code: 'handler_error', message: e instanceof Error ? e.message : String(e) },
      });
    }

    this.deps.events.emit({
      type: 'invoke:end',
      capabilityId: id,
      caller,
      ok: outcome.ok,
      durationMs: outcome.durationMs,
      errorCode: outcome.error?.code,
    });
    return outcome;
  }

  private async execute<O>(
    cap: Capability<any, any, TEntity, TDiff>,
    input: unknown,
    caller: CallerInfo,
    dryRun: boolean,
    opts: InvokeOptions,
    done: (
      partial: Omit<InvokeOutcome<O, TDiff>, 'capabilityId' | 'durationMs'>,
    ) => InvokeOutcome<O, TDiff>,
  ): Promise<InvokeOutcome<O, TDiff>> {
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
    };

    let result: CapabilityResult<O, TEntity, TDiff>;
    try {
      result = await cap.handler(ctx, parsed.data);
    } catch (e) {
      return done({
        ok: false,
        error: { code: 'handler_error', message: e instanceof Error ? e.message : String(e) },
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
          error: { code: 'handler_error', message: e instanceof Error ? e.message : String(e) },
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
        error: { code: 'handler_error', message: e instanceof Error ? e.message : String(e) },
      });
    }
    const res = group.commit();
    if (res === undefined) return done({ ok: true, output });
    if (!res.ok) {
      return done({ ok: false, error: { code: 'engine_rejected', message: res.error } });
    }
    return done({ ok: true, output, diff: res.diff });
  }
}
