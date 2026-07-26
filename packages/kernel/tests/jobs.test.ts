/**
 * U4-C Job 模型（ADR-0017）：异步作业句柄 + job:progress 事件帧 + 协作取消
 * + **回漏斗纪律**（红线二）：作业落地必须经 invoke——manager 面上无处直改状态
 * （结构性负向断言），落地路径产生正常审计/journal（回放等价由既有机制覆盖）。
 */
import { describe, expect, it } from 'vitest';
import {
  clientOf,
  createAuditLog,
  createJobManager,
  createKernel,
  createRuntimePack,
  JOBS_SERVICE_KEY,
  type JobManager,
  type SarEvent,
  type SarKernel,
} from '../src/index';
import {
  allItemCapabilities,
  ItemAlgebra,
  ItemEngine,
  type Item,
  type ItemDiff,
} from './helpers';

function setup(): {
  kernel: SarKernel<Item, ItemDiff>;
  engine: ItemEngine;
  audit: ReturnType<typeof createAuditLog>;
} {
  const engine = new ItemEngine([{ id: 'a', value: 1 }]);
  const audit = createAuditLog();
  const kernel = createKernel<Item, ItemDiff>({
    engine,
    algebra: new ItemAlgebra(),
    packs: [
      { id: 'item', capabilities: allItemCapabilities() },
      createRuntimePack<Item, ItemDiff>({ checkpoint: false }),
    ],
    middleware: [audit.middleware],
  });
  return { kernel, engine, audit };
}

const jobsOf = (kernel: SarKernel<Item, ItemDiff>): JobManager =>
  kernel.services.require<JobManager>(JOBS_SERVICE_KEY);

describe('JobManager + job:progress 帧', () => {
  it('start→progress→succeeded：帧序完整，jobs.status/jobs.list 能力面同步可见', async () => {
    const { kernel } = setup();
    const frames: SarEvent[] = [];
    kernel.events.on((e) => {
      if (e.type === 'job:progress') frames.push(e);
    });

    const jobs = jobsOf(kernel);
    const jobId = jobs.start('演示作业', async (ctx) => {
      ctx.progress(30, '第一阶段');
      ctx.progress(80);
      return { produced: 3 };
    });
    const final = await jobs.settled(jobId);
    expect(final).toMatchObject({ status: 'succeeded', progress: 100 });
    expect(final!.result).toEqual({ produced: 3 });

    const statuses = frames
      .filter((f) => f.type === 'job:progress' && f.jobId === jobId)
      .map((f) => (f.type === 'job:progress' ? `${f.status}@${f.progress}` : ''));
    expect(statuses).toEqual(['running@0', 'running@30', 'running@80', 'succeeded@100']);

    const viaCap = await kernel.invoke<{ status: string; result?: unknown }>(
      'jobs.status',
      { jobId },
    );
    expect(viaCap.output).toMatchObject({ status: 'succeeded' });
    const list = await kernel.invoke<{ jobs: { jobId: string }[] }>('jobs.list', {});
    expect(list.output!.jobs.map((j) => j.jobId)).toContain(jobId);
  });

  it('协作取消：jobs.cancel 能力发信号 → 作业尊重 signal → cancelled；已终局再取消返回 false', async () => {
    const { kernel } = setup();
    const jobs = jobsOf(kernel);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const jobId = jobs.start('可取消作业', async (ctx) => {
      await gate;
      if (ctx.signal.aborted) throw new Error('已取消');
      return 'never';
    });

    const cancel = await kernel.invoke<{ cancelled: boolean }>('jobs.cancel', { jobId });
    expect(cancel.output!.cancelled).toBe(true);
    release();
    const final = await jobs.settled(jobId);
    expect(final!.status).toBe('cancelled');

    const again = await kernel.invoke<{ cancelled: boolean }>('jobs.cancel', { jobId });
    expect(again.output!.cancelled).toBe(false);
  });

  it('作业抛错 → failed + error；jobs.status 对未知 id 报错带提示', async () => {
    const { kernel } = setup();
    const jobs = jobsOf(kernel);
    const jobId = jobs.start('会失败的作业', async () => {
      throw new Error('数据源不可达');
    });
    const final = await jobs.settled(jobId);
    expect(final).toMatchObject({ status: 'failed', error: '数据源不可达' });

    const missing = await kernel.invoke('jobs.status', { jobId: 'job_404' });
    expect(missing.ok).toBe(false);
    expect(missing.error?.message).toContain('jobs.list');
  });
});

describe('回漏斗纪律（红线二）', () => {
  it('作业落地经 SarClient.invoke → 审计可见、状态生效（同一漏斗）', async () => {
    const { kernel, engine, audit } = setup();
    const client = clientOf(kernel, { entry: 'agent', id: 'job-runner' });
    const jobs = jobsOf(kernel);

    const jobId = jobs.start('批量写入', async (ctx) => {
      ctx.progress(50, '写入中');
      const out = await client.invoke('item.add', { items: [{ id: 'j1', value: 7 }] });
      if (!out.ok) throw new Error(out.error?.message ?? '落地失败');
      return { added: 1 };
    });
    const final = await jobs.settled(jobId);
    expect(final!.status).toBe('succeeded');
    expect(engine.snapshot().entities.get('j1')).toMatchObject({ value: 7 });
    // 落地走了漏斗：审计有归因条目（entry=agent, callerId=job-runner）
    const entry = audit
      .entries({ entry: 'agent' })
      .find((e) => e.capabilityId === 'item.add');
    expect(entry).toBeDefined();
    expect(entry!.callerId).toBe('job-runner');
  });

  it('结构性负向：JobManager 面上不存在引擎/dispatch 直改入口', () => {
    const manager = createJobManager();
    const surface = Object.keys(manager).sort();
    expect(surface).toEqual(['cancel', 'get', 'list', 'settled', 'start']);
    const opaque = manager as unknown as Record<string, unknown>;
    expect(opaque.engine).toBeUndefined();
    expect(opaque.dispatch).toBeUndefined();
  });
});
