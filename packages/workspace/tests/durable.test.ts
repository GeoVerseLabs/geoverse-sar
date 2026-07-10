/**
 * durable workflow run + 审批持久化（RFC-0009 F1+F2）：
 * - per-step：进度逐步落 store，崩溃后 resume 跳已完成步（不重复执行副作用）；
 * - macro：原子单元——resume 整体重跑；kernel 层带 resume 直接拒绝；
 * - 审批门：pending 先落 store 再等决策；重启后遗留可读出并决策（continuation=重新 invoke）。
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createKernel,
  memoryStore,
  type SarKernel,
  type Workflow,
} from '@geoverse-sar/kernel';
import { InMemoryStateEngine, RecordDiffAlgebra } from '@geoverse-sar/engine-memory';
import { createRecordsPack } from '@geoverse-sar/capabilities-records';
import {
  createApprovalGate,
  createDurableRunner,
  type WorkflowRunState,
} from '../src/index';

function makeKernel(workflows: Workflow[]): SarKernel {
  return createKernel({
    engine: new InMemoryStateEngine([]),
    algebra: new RecordDiffAlgebra(),
    packs: [createRecordsPack()],
    workflows,
  });
}

const addStep = (id: string, x: number) => ({
  id,
  capability: 'records.add',
  input: { records: [{ x, y: x }] },
});

const perStepWf: Workflow = {
  id: 'wf.batch',
  title: '分步批量加点',
  description: '测试替身：三步各加一条记录（per-step 提交）。',
  inputSchema: z.object({}),
  undo: 'per-step',
  steps: [addStep('s1', 1), addStep('s2', 2), addStep('s3', 3)],
};

const macroWf: Workflow = {
  id: 'wf.macroBatch',
  title: '宏批量加点',
  description: '测试替身：三步各加一条记录（macro 折叠）。',
  inputSchema: z.object({}),
  undo: 'macro',
  steps: [addStep('m1', 1), addStep('m2', 2), addStep('m3', 3)],
};

const count = (kernel: SarKernel) => kernel.engine.snapshot().entities.size;

describe('durable workflow run（F1）', () => {
  it('正常执行：进度逐步落 store，完结后出队但记录保留', async () => {
    const kernel = makeKernel([perStepWf]);
    const store = memoryStore();
    const runner = createDurableRunner(kernel, store);

    const result = await runner.run('wf.batch', {});
    expect(result.ok).toBe(true);
    expect(count(kernel)).toBe(3);

    const state = await runner.getRun(result.runId);
    expect(state?.status).toBe('done');
    expect(state?.completed.map((c) => c.stepId)).toEqual(['s1', 's2', 's3']);
    expect(await runner.pendingRuns()).toEqual([]);
  });

  it('崩溃续跑（per-step）：跳已完成步，不重复执行副作用', async () => {
    const kernel = makeKernel([perStepWf]);
    const store = memoryStore();
    const runner = createDurableRunner(kernel, store);

    // 模拟"跑完 s1 即崩溃"的现场：引擎里已有 s1 的效果（真实场景由 workspace
    // journal 恢复提供），store 里有 running 状态 + 已完成步记录
    await kernel.invoke('records.add', { records: [{ x: 1, y: 1 }] });
    const crashed: WorkflowRunState = {
      runId: 'run-crashed',
      workflowId: 'wf.batch',
      input: {},
      status: 'running',
      completed: [{ stepId: 's1', output: { ids: ['r1'] } }],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.putSnapshot('workflowRun:run-crashed', crashed);
    await store.putSnapshot('workflowRuns', ['run-crashed']);

    expect(await runner.pendingRuns()).toEqual(['run-crashed']);
    const result = await runner.resume('run-crashed');
    expect(result.ok).toBe(true);
    expect(count(kernel)).toBe(3); // s1 未重跑（否则是 4）
    expect(result.steps.s1).toEqual({ ids: ['r1'] }); // 回填的输出进入步间数据流
    expect((await runner.getRun('run-crashed'))?.status).toBe('done');
    expect(await runner.pendingRuns()).toEqual([]);
  });

  it('macro 续跑=整体重跑（缓冲 diff 未落地，干净回滚后从头执行）', async () => {
    const kernel = makeKernel([macroWf]);
    const store = memoryStore();
    const runner = createDurableRunner(kernel, store);

    const crashed: WorkflowRunState = {
      runId: 'run-macro',
      workflowId: 'wf.macroBatch',
      input: {},
      status: 'running',
      completed: [{ stepId: 'm1', output: {} }], // 观测记录，resume 不消费
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.putSnapshot('workflowRun:run-macro', crashed);
    await store.putSnapshot('workflowRuns', ['run-macro']);

    const result = await runner.resume('run-macro');
    expect(result.ok).toBe(true);
    expect(count(kernel)).toBe(3); // 从头整跑
    expect(kernel.engine.undoDepth).toBe(1); // 宏撤销折叠不受影响
  });

  it('kernel 层守卫：macro 工作流带 resume 直接拒绝', async () => {
    const kernel = makeKernel([macroWf]);
    const result = await kernel.runWorkflow('wf.macroBatch', {}, { resume: { m1: {} } });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('原子单元');
  });

  it('失败运行标记 failed 并出队；resume 已完结的运行报错', async () => {
    const boomWf: Workflow = {
      ...perStepWf,
      id: 'wf.boom',
      steps: [addStep('s1', 1), { id: 's2', capability: 'no.such.capability' }],
    };
    const kernel = makeKernel([boomWf]);
    const store = memoryStore();
    const runner = createDurableRunner(kernel, store);

    const result = await runner.run('wf.boom', {});
    expect(result.ok).toBe(false);
    const state = await runner.getRun(result.runId);
    expect(state?.status).toBe('failed');
    expect(state?.failedStepId).toBe('s2');
    expect(await runner.pendingRuns()).toEqual([]);
    await expect(runner.resume(result.runId)).rejects.toThrow('已完结');
  });
});

describe('审批持久化（F2）', () => {
  it('进程内：请求先落 store，决策后放行并出队', async () => {
    const store = memoryStore();
    const gate = createApprovalGate(store);
    const requests: string[] = [];
    gate.onRequest((p) => requests.push(p.capabilityId));

    const decision = gate.approve(
      { capabilityId: 'records.remove', input: { ids: ['r1'] } },
      { diff: { removed: 1 } },
    );
    const pending = await gate.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0].capabilityId).toBe('records.remove');
    expect(requests).toEqual(['records.remove']);

    await gate.decide(pending[0].id, true);
    await expect(decision).resolves.toBe(true);
    expect(await gate.pending()).toEqual([]);
  });

  it('拒绝：approve 得 false（agent 侧动作 blocked）', async () => {
    const store = memoryStore();
    const gate = createApprovalGate(store);
    const decision = gate.approve({ capabilityId: 'x' }, {});
    const [p] = await gate.pending();
    await gate.decide(p.id, false);
    await expect(decision).resolves.toBe(false);
  });

  it('重启遗留：新 gate 读出 pending，决策返回记录供宿主重新 invoke', async () => {
    const store = memoryStore();
    const gate1 = createApprovalGate(store);
    void gate1.approve(
      { capabilityId: 'records.setProps', input: { ids: ['r1'], props: { a: 1 } } },
      { diff: { modified: 1 } },
    );
    await gate1.pending(); // 确保写入落定

    // "重启"：同一 store 上新建 gate（原 waiter 随进程消失）
    const gate2 = createApprovalGate(store);
    const pending = await gate2.pending();
    expect(pending).toHaveLength(1);
    const record = await gate2.decide(pending[0].id, true);
    expect(record?.capabilityId).toBe('records.setProps');
    expect(record?.input).toEqual({ ids: ['r1'], props: { a: 1 } });
    expect(await gate2.pending()).toEqual([]);
  });
});
