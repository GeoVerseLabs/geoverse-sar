/**
 * G1-1 契约测试（阶段三 Execution Contract Freeze）：runId / traceId 贯穿
 * 原子 invoke / 工作流 / 嵌套 / 审计 / 事件 / 日志——"一个长任务用单一标识
 * 可回答：调用了哪些步骤、谁发起、写了哪些事务"。
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createAuditLog,
  createJournal,
  createKernel,
  type SarEvent,
  type SarKernel,
  type Workflow,
  type WorkflowScope,
} from '../src/index';
import {
  allItemCapabilities,
  ItemAlgebra,
  ItemEngine,
  type Item,
  type ItemDiff,
} from './helpers';

const doubleWrite: Workflow = {
  id: 'wf.doubleWrite',
  title: '两步写',
  description: '新增一条再改一条。',
  inputSchema: z.object({ newId: z.string(), setTo: z.number() }),
  undo: 'macro',
  steps: [
    {
      id: 'add',
      capability: 'item.add',
      input: (s: WorkflowScope) => ({
        items: [{ id: (s.input as { newId: string }).newId, value: 0 }],
      }),
    },
    {
      id: 'set',
      capability: 'item.set',
      input: (s: WorkflowScope) => ({
        id: (s.input as { newId: string }).newId,
        value: (s.input as { setTo: number }).setTo,
      }),
    },
  ],
};

function setup(workflows: Workflow[] = []): {
  kernel: SarKernel<Item, ItemDiff>;
  engine: ItemEngine;
} {
  const engine = new ItemEngine([{ id: 'a', value: 1 }]);
  const kernel = createKernel<Item, ItemDiff>({
    engine,
    algebra: new ItemAlgebra(),
    packs: [{ id: 'item', capabilities: allItemCapabilities() }],
    workflows,
  });
  return { kernel, engine };
}

describe('执行身份：原子 invoke（G1-1）', () => {
  it('outcome 带自动生成的 traceId（前缀 tr_），两次调用不同', async () => {
    const { kernel } = setup();
    const a = await kernel.invoke('item.set', { id: 'a', value: 2 });
    const b = await kernel.invoke('item.set', { id: 'a', value: 3 });
    expect(a.traceId).toMatch(/^tr_/);
    expect(b.traceId).toMatch(/^tr_/);
    expect(a.traceId).not.toBe(b.traceId);
    // 原子 invoke 无运行上下文 → runId 缺席
    expect(a.runId).toBeUndefined();
  });

  it('显式 traceId/runId 回写到 outcome 且入审计', async () => {
    const audit = createAuditLog();
    const engine = new ItemEngine([{ id: 'a', value: 1 }]);
    const kernel = createKernel<Item, ItemDiff>({
      engine,
      algebra: new ItemAlgebra(),
      packs: [{ id: 'item', capabilities: allItemCapabilities() }],
      middleware: [audit.middleware],
    });
    const out = await kernel.invoke(
      'item.set',
      { id: 'a', value: 5 },
      { traceId: 'tr_x', runId: 'run_x' },
    );
    expect(out.traceId).toBe('tr_x');
    expect(out.runId).toBe('run_x');
    const entries = audit.entries({ traceId: 'tr_x' });
    expect(entries).toHaveLength(1);
    expect(entries[0].runId).toBe('run_x');
    // 按 runId 过滤等价
    expect(audit.entries({ runId: 'run_x' })).toHaveLength(1);
  });
});

describe('执行身份：工作流全程一个 trace（G1-1）', () => {
  it('runWorkflow 的所有步骤与结果共享同一 traceId/runId，审计可按 run 取全', async () => {
    const audit = createAuditLog();
    const engine = new ItemEngine([{ id: 'a', value: 1 }]);
    const kernel = createKernel<Item, ItemDiff>({
      engine,
      algebra: new ItemAlgebra(),
      packs: [{ id: 'item', capabilities: allItemCapabilities() }],
      workflows: [doubleWrite],
      middleware: [audit.middleware],
    });
    const run = await kernel.runWorkflow('wf.doubleWrite', { newId: 'n1', setTo: 9 });
    expect(run.ok).toBe(true);
    expect(run.traceId).toMatch(/^tr_/);
    expect(run.runId).toMatch(/^run_/);

    // 两个写步的审计条目都归到本次 run
    const runEntries = audit.entries({ runId: run.runId });
    expect(runEntries.map((e) => e.capabilityId)).toEqual(['item.add', 'item.set']);
    expect(runEntries.every((e) => e.traceId === run.traceId)).toBe(true);
    expect(audit.entries({ traceId: run.traceId })).toHaveLength(2);
  });

  it('以能力形式调用工作流：内部步骤继承外层 invoke 的 traceId', async () => {
    const audit = createAuditLog();
    const engine = new ItemEngine([{ id: 'a', value: 1 }]);
    const kernel = createKernel<Item, ItemDiff>({
      engine,
      algebra: new ItemAlgebra(),
      packs: [{ id: 'item', capabilities: allItemCapabilities() }],
      workflows: [doubleWrite],
      middleware: [audit.middleware],
    });
    const out = await kernel.invoke('wf.doubleWrite', { newId: 'n2', setTo: 4 });
    expect(out.ok).toBe(true);
    // 外层 invoke + 两个内部步骤全部同 traceId（整棵调用树一个 trace）；
    // 审计按完成顺序记（内层先于外层完成），故比较集合而非顺序
    const sameTrace = audit.entries({ traceId: out.traceId! });
    expect(sameTrace.map((e) => e.capabilityId).sort()).toEqual([
      'item.add',
      'item.set',
      'wf.doubleWrite',
    ]);
  });
});

describe('执行身份：事件与日志（G1-1）', () => {
  it('invoke/workflow 事件携带 traceId；workflow 事件带 runId', async () => {
    const { kernel } = setup([doubleWrite]);
    const events: SarEvent<ItemDiff>[] = [];
    kernel.events.on((e) => events.push(e));

    const run = await kernel.runWorkflow('wf.doubleWrite', { newId: 'n3', setTo: 7 });
    const wfStart = events.find((e) => e.type === 'workflow:start');
    const wfEnd = events.find((e) => e.type === 'workflow:end');
    expect(wfStart && 'traceId' in wfStart && wfStart.traceId).toBe(run.traceId);
    expect(wfEnd && 'runId' in wfEnd && wfEnd.runId).toBe(run.runId);

    // 步内 invoke:start 事件同 trace
    const invokeStarts = events.filter((e) => e.type === 'invoke:start');
    expect(invokeStarts.length).toBeGreaterThan(0);
    expect(invokeStarts.every((e) => 'traceId' in e && e.traceId === run.traceId)).toBe(
      true,
    );
  });

  it('journal 的 dispatch 条目关联发起 trace/run；undo 条目不带', async () => {
    const { kernel, engine } = setup();
    const journal = createJournal(kernel);

    const out = await kernel.invoke(
      'item.set',
      { id: 'a', value: 8 },
      { traceId: 'tr_j', runId: 'run_j' },
    );
    engine.undo();

    const entries = journal.entries();
    const dispatch = entries.find((e) => e.op === 'dispatch');
    const undo = entries.find((e) => e.op === 'undo');
    expect(dispatch && 'traceId' in dispatch && dispatch.traceId).toBe('tr_j');
    expect(dispatch && 'runId' in dispatch && dispatch.runId).toBe('run_j');
    expect(dispatch?.op === 'dispatch' && dispatch.traceId).toBe(out.traceId);
    // undo 非写路由事务，不关联发起身份
    expect(undo && !('traceId' in undo)).toBe(true);
    journal.stop();
  });
});
