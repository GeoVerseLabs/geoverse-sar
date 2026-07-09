import { describe, expect, it } from 'vitest';
import type { LineString, Point, Polygon } from 'geojson';
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

const pt = (
  id: string,
  x: number,
  y: number,
  props: Record<string, unknown> = {},
): EditableFeature => ({
  id,
  geometry: { type: 'Point', coordinates: [x, y] } as Point,
  properties: props,
});

const square = (
  id: string,
  x: number,
  y: number,
  size: number,
  props: Record<string, unknown> = {},
): EditableFeature => ({
  id,
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [x, y],
        [x + size, y],
        [x + size, y + size],
        [x, y + size],
        [x, y],
      ],
    ],
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

    const focus = await kernel.invoke<{ center: { x: number; y: number } }>(
      'view.focus',
      {
        ids: ['b1', 'b2'],
      },
    );
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

  it('features.draw：画线与画面（外环自动闭合），撤销整体回退', async () => {
    const { kernel, engine } = setup([]);
    const out = await kernel.invoke<{ ids: string[] }>('features.draw', {
      features: [
        {
          type: 'LineString',
          coordinates: [
            [0, 0],
            [10, 0],
            [10, 10],
          ],
          props: { type: 'route' },
        },
        {
          type: 'Polygon',
          coordinates: [
            [0, 0],
            [4, 0],
            [4, 4],
            [0, 4],
          ],
          props: { type: 'zone' },
        },
      ],
    });
    expect(out.ok).toBe(true);
    const [lineId, polyId] = out.output!.ids;
    const line = engine.snapshot().entities.get(lineId)!;
    expect(line.geometry.type).toBe('LineString');
    const poly = engine.snapshot().entities.get(polyId)!;
    // 外环自动闭合：4 顶点 → 5 坐标（首尾同点）
    expect((poly.geometry as Polygon).coordinates[0]).toHaveLength(5);
    expect((poly.geometry as Polygon).coordinates[0][4]).toEqual([0, 0]);

    engine.undo();
    expect(engine.snapshot().entities.size).toBe(0);
  });

  it('features.split：线在指定点打断成两段，新段继承属性、原线删除', async () => {
    const routeLine: EditableFeature = {
      id: 'road-1',
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [10, 0],
          [20, 0],
        ],
      } as LineString,
      properties: { type: 'road', name: '主干道' },
    };
    const { kernel, engine } = setup([routeLine]);
    const out = await kernel.invoke<{ ids: string[] }>('features.split', {
      id: 'road-1',
      at: { x: 10, y: 0 },
    });
    expect(out.ok).toBe(true);
    expect(out.output!.ids).toHaveLength(2);
    expect(engine.snapshot().entities.has('road-1')).toBe(false);
    for (const id of out.output!.ids) {
      const part = engine.snapshot().entities.get(id)!;
      expect(part.geometry.type).toBe('LineString');
      expect(part.properties).toEqual({ type: 'road', name: '主干道' });
    }
    engine.undo();
    expect(engine.snapshot().entities.has('road-1')).toBe(true);
    expect(engine.snapshot().entities.size).toBe(1);
  });

  it('features.split：面被贯穿切割线拆成两块；未贯穿外环则整体失败', async () => {
    const { kernel, engine } = setup([square('z1', 0, 0, 10, { type: 'zone' })]);
    const out = await kernel.invoke<{ ids: string[] }>('features.split', {
      id: 'z1',
      line: [
        [5, -1],
        [5, 11],
      ],
    });
    expect(out.ok).toBe(true);
    expect(out.output!.ids).toHaveLength(2);
    expect(engine.snapshot().entities.has('z1')).toBe(false);
    expect(engine.snapshot().entities.size).toBe(2);

    // 未贯穿（终点落在面内）→ execution_failed，状态不动
    engine.undo();
    const bad = await kernel.invoke('features.split', {
      id: 'z1',
      line: [
        [5, -1],
        [5, 5],
      ],
    });
    expect(bad.ok).toBe(false);
    expect(engine.snapshot().entities.has('z1')).toBe(true);
  });

  it('features.merge：端点相接的线合并；面求并集（共享边）；结果继承首要素属性', async () => {
    const line = (id: string, coords: number[][]): EditableFeature => ({
      id,
      geometry: { type: 'LineString', coordinates: coords } as LineString,
      properties: { type: 'road', name: id },
    });
    const { kernel, engine } = setup([
      line('l1', [
        [0, 0],
        [10, 0],
      ]),
      line('l2', [
        [10, 0],
        [20, 0],
      ]),
      square('p1', 0, 10, 4, { type: 'zone', name: 'A区' }),
      square('p2', 4, 10, 4, { type: 'zone', name: 'B区' }),
    ]);

    const mergedLine = await kernel.invoke<{ id: string }>('features.merge', {
      ids: ['l1', 'l2'],
    });
    expect(mergedLine.ok).toBe(true);
    const l = engine.snapshot().entities.get(mergedLine.output!.id)!;
    expect((l.geometry as LineString).coordinates).toEqual([
      [0, 0],
      [10, 0],
      [20, 0],
    ]);
    expect(l.properties.name).toBe('l1');
    expect(engine.snapshot().entities.has('l1')).toBe(false);

    const mergedPoly = await kernel.invoke<{ id: string }>('features.merge', {
      ids: ['p1', 'p2'],
    });
    expect(mergedPoly.ok).toBe(true);
    const p = engine.snapshot().entities.get(mergedPoly.output!.id)!;
    expect(p.geometry.type).toBe('Polygon');
    expect(p.properties.name).toBe('A区');

    // 异类混合 → 失败
    const bad = await kernel.invoke('features.merge', {
      ids: [mergedLine.output!.id, mergedPoly.output!.id],
    });
    expect(bad.ok).toBe(false);
  });

  it('view.setBase：切换底图经视野服务；未知名字报错并列出可用值', async () => {
    const { kernel } = setup(seed);
    const ok = await kernel.invoke<{ base: string }>('view.setBase', { name: 'gd-sat' });
    expect(ok.output).toEqual({ base: 'gd-sat' });
    const bad = await kernel.invoke('view.setBase', { name: 'mars' });
    expect(bad.ok).toBe(false);
    expect(bad.error?.message).toContain('gd-vec');
  });

  it('dryRun：geo 写能力返回将改什么的 ChangeSet，引擎不动', async () => {
    const { kernel, engine } = setup(seed);
    const out = await kernel.invoke(
      'features.translate',
      { ids: ['b1'], dx: 9, dy: 9 },
      { dryRun: true },
    );
    expect(out.ok).toBe(true);
    expect(out.dryRun).toBe(true);
    expect(out.diff?.modified[0].id).toBe('b1');
    expect((engine.snapshot().entities.get('b1')!.geometry as Point).coordinates).toEqual(
      [0, 0],
    );
    expect(engine.undoDepth).toBe(0);
  });
});
