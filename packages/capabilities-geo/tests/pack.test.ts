import { describe, expect, it } from 'vitest';
import type { Point, Polygon } from 'geojson';
import { createKernel, type SarKernel } from '@geoverse-sar/kernel';
import {
  ChangeSetAlgebra,
  createGeoEngine,
  GeoStateEngine,
  type ChangeSet,
  type EditableFeature,
} from '@geoverse-sar/engine-geo';
import {
  createGeoHighlightAndNudgeWorkflow,
  createGeoPack,
  createMemoryGeoViewService,
  VIEW_SERVICE_KEY,
  type GeoViewService,
} from '../src/index';

const pt = (id: string, x: number, y: number, props: Record<string, unknown> = {}): EditableFeature => ({
  id,
  geometry: { type: 'Point', coordinates: [x, y] } as Point,
  properties: props,
});

const square = (id: string, x: number, y: number, size: number, props: Record<string, unknown> = {}): EditableFeature => ({
  id,
  geometry: {
    type: 'Polygon',
    coordinates: [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]],
  } as Polygon,
  properties: props,
});

function setup(seed: EditableFeature[]): {
  kernel: SarKernel<EditableFeature, ChangeSet>;
  engine: GeoStateEngine;
  view: GeoViewService;
} {
  const engine = createGeoEngine({ features: seed });
  const view = createMemoryGeoViewService();
  const kernel = createKernel<EditableFeature, ChangeSet>({
    engine,
    algebra: new ChangeSetAlgebra(),
    packs: [createGeoPack()],
    workflows: [createGeoHighlightAndNudgeWorkflow()],
    services: { [VIEW_SERVICE_KEY]: view },
  });
  return { kernel, engine, view };
}

const seed = [
  pt('b1', 0, 0, { type: 'building', name: '楼A' }),
  square('b2', 10, 10, 4, { type: 'building', name: '楼B' }),
  pt('r1', 50, 50, { type: 'road' }),
];

describe('geo 能力包（真实 editor-core 引擎之上）', () => {
  it('features.query：propsEquals + bbox 过滤，输出 LLM 友好摘要', async () => {
    const { kernel } = setup(seed);
    const out = await kernel.invoke<{
      features: { id: string; geometryType: string; center: { x: number; y: number } }[];
      count: number;
    }>('features.query', { propsEquals: { type: 'building' } });
    expect(out.output?.count).toBe(2);
    const b2 = out.output!.features.find((f) => f.id === 'b2')!;
    expect(b2.geometryType).toBe('Polygon');
    expect(b2.center).toEqual({ x: 12, y: 12 });

    const inBox = await kernel.invoke<{ count: number }>('features.query', {
      bbox: [9, 9, 15, 15],
    });
    expect(inBox.output?.count).toBe(1);
  });

  it('features.add / remove：写入真实 EditEngine，撤销恢复完整快照', async () => {
    const { kernel, engine } = setup([]);
    const added = await kernel.invoke<{ ids: string[] }>('features.add', {
      features: [{ x: 1, y: 2, props: { type: 'poi' } }],
    });
    expect(added.ok).toBe(true);
    const id = added.output!.ids[0];
    expect(engine.snapshot().entities.has(id)).toBe(true);

    await kernel.invoke('features.remove', { ids: [id] });
    expect(engine.snapshot().entities.has(id)).toBe(false);
    engine.undo();
    expect(engine.snapshot().entities.get(id)!.properties).toEqual({ type: 'poi' });
  });

  it('features.translate：多边形整体平移（递归坐标）', async () => {
    const { kernel, engine } = setup(seed);
    await kernel.invoke('features.translate', { ids: ['b2'], dx: -10, dy: 0 });
    const g = engine.snapshot().entities.get('b2')!.geometry as Polygon;
    expect(g.coordinates[0][0]).toEqual([0, 10]);
    expect(g.coordinates[0][2]).toEqual([4, 14]);
  });

  it('features.setProps 走 propertyChanges 通道；view.focus 求整体范围中心', async () => {
    const { kernel, engine, view } = setup(seed);
    const out = await kernel.invoke('features.setProps', {
      ids: ['b1', 'b2'],
      props: { highlighted: true },
    });
    expect(out.ok).toBe(true);
    expect(out.diff?.propertyChanges).toHaveLength(2);
    expect(engine.snapshot().entities.get('b1')!.properties.highlighted).toBe(true);

    const focus = await kernel.invoke<{ center: { x: number; y: number } }>('view.focus', {
      ids: ['b1', 'b2'],
    });
    // b1 点(0,0) + b2 方块(10..14) → 整体范围 [0,0,14,14] 中心 (7,7)
    expect(focus.output?.center).toEqual({ x: 7, y: 7 });
    expect(view.current()?.focusedIds).toEqual(['b1', 'b2']);
  });

  it('geo 版 highlightAndNudge：跨引擎同构——宏撤销 undoDepth===1、一次 undo 全回退', async () => {
    const { kernel, engine } = setup(seed);
    const run = await kernel.runWorkflow<{ matchedIds: string[]; count: number }>(
      'workflow.highlightAndNudge',
      { propsEquals: { type: 'building' }, dx: 5, dy: 5 },
    );
    expect(run.ok).toBe(true);
    expect(run.output).toEqual({ matchedIds: ['b1', 'b2'], count: 2 });
    expect(engine.undoDepth).toBe(1);

    const b1 = engine.snapshot().entities.get('b1')!;
    expect((b1.geometry as Point).coordinates).toEqual([5, 5]);
    expect(b1.properties.highlighted).toBe(true);

    // 合并 diff：同一要素的属性+几何双通道各留一条、首 before 末 after
    expect(run.diff?.modified).toHaveLength(2);
    expect(run.diff?.propertyChanges).toHaveLength(2);

    engine.undo();
    const back = engine.snapshot().entities.get('b1')!;
    expect((back.geometry as Point).coordinates).toEqual([0, 0]);
    expect(back.properties.highlighted).toBeUndefined();
    expect(engine.undoDepth).toBe(0);
  });

  it('view.zoom：绝对/增量缩放经视野服务；两参皆缺 → validation_failed', async () => {
    const { kernel } = setup(seed);
    const abs = await kernel.invoke<{ level: number }>('view.zoom', { level: 15 });
    expect(abs.output).toEqual({ level: 15 });
    const rel = await kernel.invoke<{ level: number }>('view.zoom', { delta: -2 });
    expect(rel.output).toEqual({ level: 13 });
    const bad = await kernel.invoke('view.zoom', {});
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe('validation_failed');
  });

  it('dryRun：geo 写能力返回将改什么的 ChangeSet，引擎不动', async () => {
    const { kernel, engine } = setup(seed);
    const out = await kernel.invoke('features.translate', { ids: ['b1'], dx: 9, dy: 9 }, { dryRun: true });
    expect(out.ok).toBe(true);
    expect(out.dryRun).toBe(true);
    expect(out.diff?.modified[0].id).toBe('b1');
    expect((engine.snapshot().entities.get('b1')!.geometry as Point).coordinates).toEqual([0, 0]);
    expect(engine.undoDepth).toBe(0);
  });
});
