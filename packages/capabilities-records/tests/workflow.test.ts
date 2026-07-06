import { describe, expect, it } from 'vitest';
import { createKernel, type SarKernel } from '@geoverse-sar/kernel';
import {
  InMemoryStateEngine,
  RecordDiffAlgebra,
  type RecordDiff,
  type RecordEntity,
} from '@geoverse-sar/engine-memory';
import {
  createHighlightAndNudgeWorkflow,
  createMemoryViewService,
  createRecordsPack,
  VIEW_SERVICE_KEY,
  type ViewService,
} from '../src/index';

const rec = (id: string, x: number, y: number, props: Record<string, unknown>): RecordEntity => ({
  id,
  x,
  y,
  props,
});

function setup(seed: RecordEntity[]): {
  kernel: SarKernel<RecordEntity, RecordDiff>;
  engine: InMemoryStateEngine;
  view: ViewService;
} {
  const engine = new InMemoryStateEngine(seed);
  const view = createMemoryViewService();
  const kernel = createKernel<RecordEntity, RecordDiff>({
    engine,
    algebra: new RecordDiffAlgebra(),
    packs: [createRecordsPack()],
    workflows: [createHighlightAndNudgeWorkflow()],
    services: { [VIEW_SERVICE_KEY]: view },
  });
  return { kernel, engine, view };
}

const seed = [
  rec('p1', 0, 0, { type: 'poi' }),
  rec('p2', 10, 0, { type: 'poi' }),
  rec('r1', 5, 5, { type: 'road' }),
];

describe('highlightAndNudge 工作流（M1 验收）', () => {
  it('查询→聚焦→高亮→轻移；两个写步折叠为一个撤销单元（undoDepth===1）', async () => {
    const { kernel, engine, view } = setup(seed);
    const run = await kernel.runWorkflow<{ matchedIds: string[]; count: number }>(
      'workflow.highlightAndNudge',
      { propsEquals: { type: 'poi' }, dx: 2, dy: 3 },
    );
    expect(run.ok).toBe(true);
    expect(run.output).toEqual({ matchedIds: ['p1', 'p2'], count: 2 });

    // 状态：高亮 + 平移都已生效
    const snap = engine.snapshot();
    expect(snap.entities.get('p1')).toMatchObject({ x: 2, y: 3 });
    expect(snap.entities.get('p1')!.props).toMatchObject({ type: 'poi', highlighted: true });
    expect(snap.entities.get('p2')).toMatchObject({ x: 12, y: 3 });
    expect(snap.entities.get('r1')).toMatchObject({ x: 5, y: 5 });

    // 视野聚焦到匹配记录的原位置质心（写步缓冲在后，focus 时看到的是查询态）
    expect(view.current()?.focusedIds).toEqual(['p1', 'p2']);

    // 宏撤销折叠：整条工作流 = 一个撤销单元
    expect(engine.undoDepth).toBe(1);

    // 合并 diff：同一 id 的 setProps+translate 折叠成单条 modified（首 before 末 after）
    expect(run.diff?.modified).toHaveLength(2);
    const m1 = run.diff!.modified.find((m) => m.id === 'p1')!;
    expect(m1.before).toMatchObject({ x: 0, y: 0, props: { type: 'poi' } });
    expect(m1.before.props.highlighted).toBeUndefined();
    expect(m1.after).toMatchObject({ x: 2, y: 3, props: { highlighted: true } });

    // 一次 undo 全回退（高亮与平移一起消失）
    engine.undo();
    const back = engine.snapshot();
    expect(back.entities.get('p1')).toMatchObject({ x: 0, y: 0 });
    expect(back.entities.get('p1')!.props.highlighted).toBeUndefined();
    expect(engine.undoDepth).toBe(0);
  });

  it('无匹配记录：写步全部跳过，不产生撤销单元', async () => {
    const { kernel, engine } = setup(seed);
    const run = await kernel.runWorkflow<{ count: number }>('workflow.highlightAndNudge', {
      propsEquals: { type: 'ghost' },
    });
    expect(run.ok).toBe(true);
    expect(run.output?.count).toBe(0);
    expect(engine.undoDepth).toBe(0);
  });

  it('工作流即工具：经 kernel.invoke 单次调用等效', async () => {
    const { kernel, engine } = setup(seed);
    expect(kernel.describeAll().map((d) => d.id)).toContain('workflow.highlightAndNudge');

    const out = await kernel.invoke<{ count: number }>('workflow.highlightAndNudge', {
      propsEquals: { type: 'poi' },
      dx: 1,
      dy: 0,
    });
    expect(out.ok).toBe(true);
    expect(out.output?.count).toBe(2);
    expect(engine.undoDepth).toBe(1);
    expect(engine.snapshot().entities.get('p1')!.x).toBe(1);
  });

  it('dx/dy 缺省值经 Zod default 注入（dx=1, dy=0）', async () => {
    const { kernel, engine } = setup(seed);
    const run = await kernel.runWorkflow('workflow.highlightAndNudge', {
      propsEquals: { type: 'poi' },
    });
    expect(run.ok).toBe(true);
    expect(engine.snapshot().entities.get('p1')).toMatchObject({ x: 1, y: 0 });
  });
});
