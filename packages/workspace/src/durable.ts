/**
 * durable workflow run + 审批持久化（RFC-0009 F1+F2，随 T4 workspace 实施）。
 *
 * F1 语义：
 * - undo:'per-step'|'none'：每步成功即把 {stepId, output} 落 store（kernel onStep 钩子，
 *   await 后才进下一步）——崩溃后 resume 用 kernel resume 选项跳已完成步（其 diff 已随
 *   per-step 提交进引擎/journal，由 workspace 恢复负责回放）。
 * - undo:'macro'：原子单元——缓冲 diff 未落地即崩溃 = 干净回滚，resume 即整体重跑
 *   （进度记录仅作观测）。
 *
 * F2 语义（LangGraph interrupt 的持久化版）：审批请求先落 store 再等决策；进程内
 * 决策走 deferred 直接放行/拦截；进程重启后 pending 仍在——宿主读出重新请示，
 * 批准后由宿主凭记录里的 {capabilityId, input} 重新 invoke（continuation=重新调用）。
 */
import type {
  SarKernel,
  SarStore,
  WorkflowRunOptions,
  WorkflowRunResult,
} from '@geoverse-sar/kernel';

// ---------------------------------------------------------------------------
// F1 durable workflow run
// ---------------------------------------------------------------------------

export interface WorkflowRunState {
  runId: string;
  workflowId: string;
  input: unknown;
  status: 'running' | 'done' | 'failed';
  /** 已完成步（按序）；macro 工作流仅作观测，resume 不消费。 */
  completed: { stepId: string; output: unknown }[];
  failedStepId?: string;
  error?: string;
  startedAt: string;
  updatedAt: string;
}

const RUN_KEY = (runId: string) => `workflowRun:${runId}`;
const RUN_INDEX_KEY = 'workflowRuns';

export interface DurableWorkflowRunner {
  /** durable 执行：进度逐步落 store；返回值与 kernel.runWorkflow 一致。 */
  run<O = unknown>(
    workflowId: string,
    input: unknown,
    opts?: { runId?: string; caller?: WorkflowRunOptions['caller'] },
  ): Promise<WorkflowRunResult<O> & { runId: string }>;
  /** 未完结（status='running'，通常是崩溃遗留）的 runId 列表。 */
  pendingRuns(): Promise<string[]>;
  getRun(runId: string): Promise<WorkflowRunState | undefined>;
  /** 续跑：per-step/none 跳已完成步；macro 整体重跑。 */
  resume<O = unknown>(
    runId: string,
    opts?: { caller?: WorkflowRunOptions['caller'] },
  ): Promise<WorkflowRunResult<O> & { runId: string }>;
}

export function createDurableRunner(
  kernel: SarKernel,
  store: SarStore,
): DurableWorkflowRunner {
  let serial = 0;
  // 串行化 index 更新，避免并发 run 覆盖彼此的列表
  let indexChain: Promise<unknown> = Promise.resolve();
  const updateIndex = (fn: (ids: string[]) => string[]): Promise<void> => {
    const next = indexChain.then(async () => {
      const ids = (await store.getSnapshot<string[]>(RUN_INDEX_KEY)) ?? [];
      await store.putSnapshot(RUN_INDEX_KEY, fn(ids));
    });
    indexChain = next.catch(() => undefined);
    return next;
  };

  async function execute<O>(
    state: WorkflowRunState,
    resume?: Record<string, unknown>,
    caller?: WorkflowRunOptions['caller'],
  ): Promise<WorkflowRunResult<O> & { runId: string }> {
    const persist = async () => {
      state.updatedAt = new Date().toISOString();
      await store.putSnapshot(RUN_KEY(state.runId), state);
    };
    await persist();
    await updateIndex((ids) => (ids.includes(state.runId) ? ids : [...ids, state.runId]));

    const result = await kernel.runWorkflow<O>(state.workflowId, state.input, {
      caller,
      resume,
      // G1-1：durable 运行的 runId 即工作流执行 runId——kernel 的审计/事件/日志与
      // WorkflowRunState 记录同 runId 对齐，崩溃恢复后仍可用它重建这次运行的时间线。
      runId: state.runId,
      onStep: async (stepId, output) => {
        state.completed.push({ stepId, output });
        await persist();
      },
    });

    state.status = result.ok ? 'done' : 'failed';
    state.failedStepId = result.failedStepId;
    state.error = result.error?.message;
    await persist();
    await updateIndex((ids) => ids.filter((id) => id !== state.runId));
    return { ...result, runId: state.runId };
  }

  return {
    async run(workflowId, input, opts = {}) {
      const runId = opts.runId ?? `run-${Date.now().toString(36)}-${++serial}`;
      const now = new Date().toISOString();
      const state: WorkflowRunState = {
        runId,
        workflowId,
        input,
        status: 'running',
        completed: [],
        startedAt: now,
        updatedAt: now,
      };
      return execute(state, undefined, opts.caller);
    },
    async pendingRuns() {
      return (await store.getSnapshot<string[]>(RUN_INDEX_KEY)) ?? [];
    },
    getRun: (runId) => store.getSnapshot<WorkflowRunState>(RUN_KEY(runId)),
    async resume(runId, opts = {}) {
      const state = await store.getSnapshot<WorkflowRunState>(RUN_KEY(runId));
      if (!state) throw new Error(`工作流运行记录不存在: ${runId}`);
      if (state.status !== 'running') {
        throw new Error(`工作流运行已完结（${state.status}），无需续跑: ${runId}`);
      }
      const wf = kernel.workflows.get(state.workflowId);
      if (!wf) throw new Error(`工作流不存在（能力包未注册？）: ${state.workflowId}`);
      if (wf.undo === 'macro') {
        // 原子单元：缓冲 diff 已随崩溃消失=干净回滚，整体重跑
        state.completed = [];
        return execute(state, undefined, opts.caller);
      }
      const resume = Object.fromEntries(state.completed.map((c) => [c.stepId, c.output]));
      return execute(state, resume, opts.caller);
    },
  };
}

// ---------------------------------------------------------------------------
// F2 审批 pending 持久化
// ---------------------------------------------------------------------------

export interface PendingApproval {
  id: string;
  capabilityId: string;
  input: unknown;
  /** dryRun 预览 diff（JSON 快照）。 */
  diff?: unknown;
  requestedAt: string;
  /** 发起该审批的 agent/工作流运行 id（G1-1）：据此关联审计/事件重建这次运行。 */
  runId?: string;
}

export interface ApprovalGate {
  /**
   * agent 审批门适配器：挂到 createAgent({ approve: gate.approve })。
   * 请求先持久化再等决策；决策后从 store 移除。
   */
  approve(
    action: { capabilityId: string; input?: unknown },
    preview: { diff?: unknown; runId?: string },
  ): Promise<boolean>;
  /** 待决审批（含上一会话崩溃遗留）。 */
  pending(): Promise<PendingApproval[]>;
  /**
   * 决策：进程内有等待者则直接放行/拦截；无等待者（重启后遗留）则仅出队并
   * 返回记录——批准的动作由宿主凭 {capabilityId, input} 重新 invoke。
   */
  decide(id: string, approved: boolean): Promise<PendingApproval | undefined>;
  /** 新审批请求通知（UI 弹窗口）。 */
  onRequest(fn: (p: PendingApproval) => void): () => void;
}

const APPROVALS_KEY = 'approvals';

export function createApprovalGate(store: SarStore): ApprovalGate {
  let serial = 0;
  const waiters = new Map<string, (approved: boolean) => void>();
  const listeners = new Set<(p: PendingApproval) => void>();
  let chain: Promise<unknown> = Promise.resolve();
  const withList = <T>(
    fn: (list: PendingApproval[]) => Promise<[PendingApproval[], T]>,
  ): Promise<T> => {
    const next = chain.then(async () => {
      const list = (await store.getSnapshot<PendingApproval[]>(APPROVALS_KEY)) ?? [];
      const [updated, out] = await fn(list);
      await store.putSnapshot(APPROVALS_KEY, updated);
      return out;
    });
    chain = next.catch(() => undefined);
    return next;
  };

  return {
    async approve(action, preview) {
      const record: PendingApproval = {
        id: `appr-${Date.now().toString(36)}-${++serial}`,
        capabilityId: action.capabilityId,
        input: action.input,
        diff: preview.diff,
        requestedAt: new Date().toISOString(),
        ...(preview.runId ? { runId: preview.runId } : {}),
      };
      await withList(async (list) => [[...list, record], undefined]);
      for (const fn of listeners) fn(record);
      return new Promise<boolean>((resolve) => {
        waiters.set(record.id, (approved) => {
          waiters.delete(record.id);
          resolve(approved);
        });
      });
    },
    pending() {
      return withList(async (list) => [list, [...list]]);
    },
    async decide(id, approved) {
      const record = await withList<PendingApproval | undefined>(async (list) => {
        const found = list.find((p) => p.id === id);
        return [list.filter((p) => p.id !== id), found];
      });
      waiters.get(id)?.(approved);
      return record;
    },
    onRequest(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
