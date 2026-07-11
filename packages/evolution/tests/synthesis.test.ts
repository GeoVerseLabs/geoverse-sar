/**
 * L2 合成闭环（T16）：挖掘→起草（脚本化假 LLM）→验证（静态检查+dryRun 干跑）→
 * 审批→注册+provenance 落流→重启装载。全程真实 kernel（records 域）。
 */
import { describe, expect, it } from 'vitest';
import {
  createAuditLog,
  createKernel,
  memoryStore,
  type SarKernel,
} from '@geoverse-sar/kernel';
import {
  InMemoryStateEngine,
  RecordDiffAlgebra,
  type RecordDiff,
  type RecordEntity,
} from '@geoverse-sar/engine-memory';
import {
  createMemoryViewService,
  createRecordsPack,
  VIEW_SERVICE_KEY,
} from '@geoverse-sar/capabilities-records';
import {
  createSynthesis,
  loadSynthesizedWorkflows,
  mineSequences,
  validateDraft,
  SYNTHESIZED_WORKFLOWS_STREAM,
  type DraftLlm,
  type WorkflowDraft,
} from '../src/index';

function makeKernel(audit = createAuditLog()): {
  kernel: SarKernel<RecordEntity, RecordDiff>;
  engine: InMemoryStateEngine;
} {
  const engine = new InMemoryStateEngine([
    { id: 'p1', x: 0, y: 0, props: { type: 'poi' } },
    { id: 'p2', x: 10, y: 0, props: { type: 'poi' } },
  ]);
  const kernel = createKernel<RecordEntity, RecordDiff>({
    engine,
    algebra: new RecordDiffAlgebra(),
    packs: [createRecordsPack()],
    services: { [VIEW_SERVICE_KEY]: createMemoryViewService() },
    middleware: [audit.middleware],
  });
  return { kernel, engine };
}

/** 造轨迹：把 query→setProps→translate 惯用序列跑 3 遍（audit 真实入账）。 */
async function produceTrajectory(kernel: SarKernel): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await kernel.invoke('records.query', { propsEquals: { type: 'poi' } });
    await kernel.invoke('records.setProps', {
      ids: ['p1'],
      props: { highlighted: true },
    });
    await kernel.invoke('records.translate', { ids: ['p1'], dx: 5, dy: 0 });
  }
}

const GOOD_DRAFT: WorkflowDraft = {
  id: 'workflow.highlightThenMove',
  title: '高亮并平移',
  description:
    '用户要"先标记再挪动"一批 poi 时调用：查询→高亮→按入参平移，一个撤销单元。',
  inputFields: { dx: 'number' },
  steps: [
    { id: 'find', capability: 'records.query', input: { propsEquals: { type: 'poi' } } },
    {
      id: 'mark',
      capability: 'records.setProps',
      input: { ids: '$steps.find.records.*.id', props: { highlighted: true } },
    },
    {
      id: 'move',
      capability: 'records.translate',
      input: { ids: '$steps.find.records.*.id', dx: '$input.dx', dy: 0 },
    },
  ],
};

const llmReturning = (draft: unknown): DraftLlm => ({
  complete: async () => '```json\n' + JSON.stringify(draft) + '\n```', // 模型爱包围栏，防御解析
});

describe('轨迹挖掘', () => {
  it('高频序列按支持度出榜；history/runtime 前缀与失败调用被排除', async () => {
    const audit = createAuditLog();
    const { kernel } = makeKernel(audit);
    await produceTrajectory(kernel);
    await kernel.invoke('history.undo'); // 应被排除
    await kernel.invoke('records.remove', { ids: ['ghost'] }); // 失败：断开序列

    const mined = mineSequences(audit.entries(), { minCount: 3 });
    expect(mined.length).toBeGreaterThan(0);
    // 最优序列 = 最长的 3 连（count 3、len 3 优先于短 gram）
    expect(mined[0]).toEqual({
      capabilityIds: ['records.query', 'records.setProps', 'records.translate'],
      count: 3,
    });
    expect(
      mined.every((s) => !s.capabilityIds.some((id) => id.startsWith('history.'))),
    ).toBe(true);
  });
});

describe('合成闭环', () => {
  it('propose→approve→enable：注册后经单漏斗调用、宏撤销一键回退、provenance 落流', async () => {
    const audit = createAuditLog();
    const { kernel, engine } = makeKernel(audit);
    await produceTrajectory(kernel);
    const store = memoryStore();
    const synthesis = createSynthesis({
      kernel,
      llm: llmReturning(GOOD_DRAFT),
      store,
      now: () => '2026-07-11T00:00:00.000Z',
      createdBy: 'test',
    });

    const records = await synthesis.run(audit.entries(), {
      approve: () => true,
      mine: { minCount: 3 },
    });
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('enabled');
    expect(records[0].validation.ok).toBe(true);
    expect(records[0].provenance).toEqual({
      minedFrom: ['records.query', 'records.setProps', 'records.translate'],
      count: 3,
      createdAt: '2026-07-11T00:00:00.000Z',
      createdBy: 'test',
    });

    // 目录即刻投影（工作流即工具）+ 标签可识别来源
    const desc = kernel.describeAll().find((d) => d.id === 'workflow.highlightThenMove');
    expect(desc).toBeDefined();
    expect(desc!.tags).toContain('synthesized');

    // 真调用：$input.dx 与 $steps 引用生效，宏撤销折叠为一个单元
    const before = engine.snapshot().entities.get('p1')!.x;
    const depthBefore = engine.undoDepth;
    const out = await kernel.invoke('workflow.highlightThenMove', { dx: 7 });
    expect(out.ok).toBe(true);
    expect(engine.snapshot().entities.get('p1')!.x).toBe(before + 7);
    expect(engine.undoDepth).toBe(depthBefore + 1);
    engine.undo();
    expect(engine.snapshot().entities.get('p1')!.x).toBe(before);

    // 状态迁移在流里可追溯：pending → enabled 两条
    const rows = await store.read(SYNTHESIZED_WORKFLOWS_STREAM);
    expect(rows.map((r) => (r.record as { status: string }).status)).toEqual([
      'pending',
      'enabled',
    ]);
  });

  it('无审批（缺省）停在 pending：不注册不进目录；重启 loadSynthesizedWorkflows 只装 enabled', async () => {
    const audit = createAuditLog();
    const { kernel } = makeKernel(audit);
    await produceTrajectory(kernel);
    const store = memoryStore();
    const synthesis = createSynthesis({ kernel, llm: llmReturning(GOOD_DRAFT), store });

    const [record] = await synthesis.run(audit.entries(), { mine: { minCount: 3 } });
    expect(record.status).toBe('pending');
    expect(kernel.describeAll().some((d) => d.id === record.draft.id)).toBe(false);

    // 重启（新 kernel 同 store）：pending 不装载
    const fresh1 = makeKernel().kernel;
    expect(await loadSynthesizedWorkflows(fresh1, store)).toHaveLength(0);

    // 启用后重启：enabled 装载并可调用
    await synthesis.enable(record);
    const fresh2 = makeKernel().kernel;
    const active = await loadSynthesizedWorkflows(fresh2, store);
    expect(active).toHaveLength(1);
    const out = await fresh2.invoke('workflow.highlightThenMove', { dx: 1 });
    expect(out.ok).toBe(true);
  });

  it('验证拦住坏草稿：未知能力 / 引用更晚的步 / dryRun 失败；坏草稿不可 enable', async () => {
    const { kernel } = makeKernel();

    const unknownCap: WorkflowDraft = {
      ...GOOD_DRAFT,
      id: 'workflow.bad1',
      steps: [{ id: 's1', capability: 'records.nope' }],
    };
    const v1 = await validateDraft(kernel, unknownCap);
    expect(v1.ok).toBe(false);
    expect(v1.issues.join()).toContain('records.nope');

    const forwardRef: WorkflowDraft = {
      ...GOOD_DRAFT,
      id: 'workflow.bad2',
      steps: [
        {
          id: 's1',
          capability: 'records.setProps',
          input: { ids: '$steps.s2.ids', props: {} },
        },
        { id: 's2', capability: 'records.query', input: {} },
      ],
    };
    const v2 = await validateDraft(kernel, forwardRef);
    expect(v2.ok).toBe(false);
    expect(v2.issues.join()).toContain('$steps.s2');

    const schemaBreaks: WorkflowDraft = {
      ...GOOD_DRAFT,
      id: 'workflow.bad3',
      inputFields: {},
      steps: [
        { id: 's1', capability: 'records.translate', input: { ids: [], dx: 1, dy: 2 } },
      ],
    };
    const v3 = await validateDraft(kernel, schemaBreaks);
    expect(v3.ok).toBe(false);
    expect(v3.issues.join()).toContain('dryRun 失败');

    const synthesis = createSynthesis({ kernel, llm: llmReturning(unknownCap) });
    const record = await synthesis.propose({ capabilityIds: ['records.nope'], count: 3 });
    await expect(synthesis.enable(record)).rejects.toThrow('验证未通过');
  });

  it('LLM 输出非法 JSON：run 落一条 rejected 占位产物，不中断', async () => {
    const audit = createAuditLog();
    const { kernel } = makeKernel(audit);
    await produceTrajectory(kernel);
    const store = memoryStore();
    const synthesis = createSynthesis({
      kernel,
      llm: { complete: async () => '我觉得这个序列很有意思，但我不想输出 JSON。' },
      store,
    });
    const [record] = await synthesis.run(audit.entries(), { mine: { minCount: 3 } });
    expect(record.status).toBe('rejected');
    expect(record.validation.ok).toBe(false);
  });
});
