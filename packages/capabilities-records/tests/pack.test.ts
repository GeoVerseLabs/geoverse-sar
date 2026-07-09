import { describe, expect, it } from 'vitest';
import { createKernel, type SarKernel } from '@geoverse-sar/kernel';
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
  type ViewService,
} from '../src/index';

const rec = (
  id: string,
  x = 0,
  y = 0,
  props: Record<string, unknown> = {},
): RecordEntity => ({
  id,
  x,
  y,
  props,
});

function setup(seed: RecordEntity[] = []): {
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
    services: { [VIEW_SERVICE_KEY]: view },
  });
  return { kernel, engine, view };
}

describe('records 能力包', () => {
  it('records.query：ids / propsEquals / bbox 过滤求交', async () => {
    const { kernel } = setup([
      rec('a', 0, 0, { type: 'poi' }),
      rec('b', 10, 10, { type: 'poi' }),
      rec('c', 20, 20, { type: 'road' }),
    ]);
    const byProps = await kernel.invoke<{ count: number }>('records.query', {
      propsEquals: { type: 'poi' },
    });
    expect(byProps.output?.count).toBe(2);

    const byBbox = await kernel.invoke<{ records: RecordEntity[] }>('records.query', {
      propsEquals: { type: 'poi' },
      bbox: [5, 5, 15, 15],
    });
    expect(byBbox.output?.records.map((r) => r.id)).toEqual(['b']);

    const byIds = await kernel.invoke<{ count: number }>('records.query', {
      ids: ['a', 'c'],
    });
    expect(byIds.output?.count).toBe(2);
  });

  it('records.add：id 缺省自动生成；写入引擎可撤销', async () => {
    const { kernel, engine } = setup();
    const out = await kernel.invoke<{ ids: string[] }>('records.add', {
      records: [
        { x: 1, y: 2 },
        { id: 'fixed', x: 3, y: 4, props: { n: 1 } },
      ],
    });
    expect(out.ok).toBe(true);
    expect(out.output?.ids).toHaveLength(2);
    expect(out.output?.ids[1]).toBe('fixed');
    expect(engine.snapshot().entities.size).toBe(2);
    expect(engine.undoDepth).toBe(1);
    engine.undo();
    expect(engine.snapshot().entities.size).toBe(0);
  });

  it('records.add：id 冲突整体失败、零污染', async () => {
    const { kernel, engine } = setup([rec('a')]);
    const out = await kernel.invoke('records.add', {
      records: [
        { id: 'b', x: 0, y: 0 },
        { id: 'a', x: 0, y: 0 },
      ],
    });
    expect(out.ok).toBe(false);
    expect(out.error?.message).toContain('已存在');
    expect(engine.snapshot().entities.size).toBe(1);
  });

  it('records.translate / setProps / remove 基本行为', async () => {
    const { kernel, engine } = setup([rec('a', 1, 1, { keep: true })]);
    await kernel.invoke('records.translate', { ids: ['a'], dx: 4, dy: -1 });
    expect(engine.snapshot().entities.get('a')).toMatchObject({ x: 5, y: 0 });

    await kernel.invoke('records.setProps', { ids: ['a'], props: { highlighted: true } });
    expect(engine.snapshot().entities.get('a')!.props).toEqual({
      keep: true,
      highlighted: true,
    });

    await kernel.invoke('records.remove', { ids: ['a'] });
    expect(engine.snapshot().entities.size).toBe(0);
    // 三次写 = 三个撤销单元
    expect(engine.undoDepth).toBe(3);
  });

  it('history.undo / history.redo 作为能力（AI 的写操作可回退）', async () => {
    const { kernel, engine } = setup([rec('a', 0, 0)]);
    await kernel.invoke('records.translate', { ids: ['a'], dx: 10, dy: 0 });

    const undone = await kernel.invoke<{ done: boolean }>('history.undo', {});
    expect(undone.output?.done).toBe(true);
    expect(engine.snapshot().entities.get('a')!.x).toBe(0);

    const redone = await kernel.invoke<{ done: boolean }>('history.redo', {});
    expect(redone.output?.done).toBe(true);
    expect(engine.snapshot().entities.get('a')!.x).toBe(10);

    engine.undo();
    engine.undo();
    const empty = await kernel.invoke<{ done: boolean }>('history.undo', {});
    expect(empty.output?.done).toBe(false);
  });

  it('view.focus：按 ids 求质心聚焦；服务记录状态', async () => {
    const { kernel, view } = setup([rec('a', 0, 0), rec('b', 10, 20)]);
    const out = await kernel.invoke<{ center: { x: number; y: number } }>('view.focus', {
      ids: ['a', 'b'],
    });
    expect(out.output?.center).toEqual({ x: 5, y: 10 });
    expect(view.current()?.focusedIds).toEqual(['a', 'b']);
  });

  it('view.focus：ids 与 center 皆缺 → validation_failed', async () => {
    const { kernel } = setup();
    const out = await kernel.invoke('view.focus', {});
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('validation_failed');
  });

  it('view.focus：目标不存在 → handler_error', async () => {
    const { kernel } = setup();
    const out = await kernel.invoke('view.focus', { ids: ['ghost'] });
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('handler_error');
  });
});
