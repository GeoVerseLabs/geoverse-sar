/**
 * U3-D：指代解析族（view.bbox/selection.get/region.select/view.snapGuide）
 * + 参数化形状（drawRect/drawCircle，SHAPE_PROPERTY 标记 + Quantity 半径）
 * + 历史能力（history.list/rollback——复用 editor-core MemoryHistoryStore，
 *   回滚=普通可逆编辑）。
 */
import { describe, expect, it } from 'vitest';
import type { Point, Polygon } from 'geojson';
import { createKernel, type SarKernel } from '@geoverse-sar/kernel';
import {
  ChangeSetAlgebra,
  createGeoEngine,
  GeoStateEngine,
  MemoryHistoryStore,
  SHAPE_PROPERTY,
  type ChangeSet,
  type EditableFeature,
} from '@geoverse-sar/engine-geo';
import { bboxOf } from '@geoverse-sar/geo-profile';
import {
  createGeoPack,
  createMemoryGeoViewService,
  GEO_HISTORY_SERVICE_KEY,
  VIEW_SERVICE_KEY,
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

function setup(history?: MemoryHistoryStore): {
  kernel: SarKernel<EditableFeature, ChangeSet>;
  engine: GeoStateEngine;
  view: ReturnType<typeof createMemoryGeoViewService>;
} {
  const engine = createGeoEngine({
    features: [
      pt('a', 0, 0, { zone: 'R1' }),
      pt('b', 5, 5, { zone: 'R2' }),
      pt('c', 20, 20),
    ],
  });
  const view = createMemoryGeoViewService();
  const kernel = createKernel<EditableFeature, ChangeSet>({
    engine,
    algebra: new ChangeSetAlgebra(),
    packs: [createGeoPack({ localUnit: 'm', history: !!history })],
    services: {
      [VIEW_SERVICE_KEY]: view,
      ...(history ? { [GEO_HISTORY_SERVICE_KEY]: history } : {}),
    },
  });
  return { kernel, engine, view };
}

describe('指代解析族', () => {
  it('view.bbox：视野→bbox；未就绪如实报错', async () => {
    const { kernel, view } = setup();
    const cold = await kernel.invoke('view.bbox', {});
    expect(cold.ok).toBe(false);

    view.setViewport([0, 0, 10, 10]);
    const out = await kernel.invoke<{ bbox: number[] }>('view.bbox', {});
    expect(out.output!.bbox).toEqual([0, 0, 10, 10]);
  });

  it('selection.get：选择集→命名集句柄，可直接喂给写能力 target', async () => {
    const { kernel, view, engine } = setup();
    const none = await kernel.invoke('selection.get', {});
    expect(none.ok).toBe(false); // 空选择提示先选

    view.setSelection(['a', 'b']);
    const sel = await kernel.invoke<{ setId: string; ids: string[] }>(
      'selection.get',
      {},
    );
    expect(sel.output!.ids).toEqual(['a', 'b']);

    await kernel.invoke('features.translate', {
      target: { setId: sel.output!.setId },
      dx: 1,
      dy: 0,
    });
    expect((engine.snapshot().entities.get('a')!.geometry as Point).coordinates).toEqual([
      1, 0,
    ]);
  });

  it('region.select：intersects 命中区域内要素并出句柄；contains 更严格', async () => {
    const { kernel } = setup();
    const ring: [number, number][] = [
      [-1, -1],
      [6, -1],
      [6, 6],
      [-1, 6],
    ];
    const hit = await kernel.invoke<{ setId: string; count: number; sample: string[] }>(
      'region.select',
      { ring },
    );
    expect(hit.output!.count).toBe(2);
    expect(hit.output!.sample.sort()).toEqual(['a', 'b']);

    const contains = await kernel.invoke<{ count: number }>('region.select', {
      ring,
      predicate: 'contains',
    });
    expect(contains.output!.count).toBe(2); // 点要素：落入即被包含
  });

  it('view.snapGuide 开关经视图服务转发', async () => {
    const { kernel } = setup();
    const off = await kernel.invoke<{ on: boolean }>('view.snapGuide', { on: false });
    expect(off.output).toEqual({ on: false });
  });
});

describe('参数化形状', () => {
  it('drawRect：两角出矩形面 + 形状标记；共线拒绝', async () => {
    const { kernel, engine } = setup();
    const out = await kernel.invoke<{ id: string }>('features.drawRect', {
      a: [0, 0],
      b: [4, 2],
    });
    const f = engine.snapshot().entities.get(out.output!.id)!;
    expect(f.geometry.type).toBe('Polygon');
    expect(f.properties[SHAPE_PROPERTY]).toBe('rect');
    expect(bboxOf(f.geometry)).toEqual([0, 0, 4, 2]);

    const bad = await kernel.invoke('features.drawRect', { a: [1, 1], b: [1, 9] });
    expect(bad.ok).toBe(false);
  });

  it('drawCircle：Quantity 半径（km→m 换算）+ 可撤销', async () => {
    const { kernel, engine } = setup();
    const out = await kernel.invoke<{ id: string }>('features.drawCircle', {
      center: [100, 100],
      radius: { value: 0.01, unit: 'km' },
    });
    const f = engine.snapshot().entities.get(out.output!.id)!;
    expect(f.properties[SHAPE_PROPERTY]).toBe('circle');
    const [minX, , maxX] = bboxOf(f.geometry);
    expect((maxX - minX) / 2).toBeCloseTo(10, 6);
    const ring = (f.geometry as Polygon).coordinates[0];
    expect(ring.length).toBeGreaterThan(32);

    engine.undo();
    expect(engine.snapshot().entities.has(out.output!.id)).toBe(false);
  });
});

describe('历史能力（复用 editor-core RFC-0006）', () => {
  it('history.list 版本清单（新→旧，不倾倒几何）；rollback=普通可逆编辑', async () => {
    const store = new MemoryHistoryStore();
    // 模拟历史：v1 原点，v2 移到 (9,9)（DB 触发器视角的两次 record）
    store.record({ ...pt('a', 0, 0, { zone: 'R1' }), version: 1 }, 'add', {
      txId: 'tx-1',
    });
    store.record(
      { ...pt('a', 9, 9, { zone: 'R1', touched: true }), version: 2 },
      'modify',
      { txId: 'tx-2' },
    );
    const { kernel, engine } = setup(store);

    const list = await kernel.invoke<{
      total: number;
      versions: { version: number; op: string; current: boolean }[];
    }>('history.list', { featureId: 'a' });
    expect(list.output!.total).toBe(2);
    expect(list.output!.versions[0]).toMatchObject({
      version: 2,
      op: 'modify',
      current: true,
    });

    // 当前编辑区 a 在 (0,0)；回滚到 v2 = 还原到 (9,9)+属性（一次普通编辑）
    const rb = await kernel.invoke<{ restored: boolean }>('history.rollback', {
      featureId: 'a',
      version: 2,
    });
    expect(rb.ok).toBe(true);
    const a = engine.snapshot().entities.get('a')!;
    expect((a.geometry as Point).coordinates).toEqual([9, 9]);
    expect(a.properties.touched).toBe(true);
    expect(engine.undoDepth).toBe(1);
    engine.undo(); // 回滚可撤销——回到回滚前状态
    expect((engine.snapshot().entities.get('a')!.geometry as Point).coordinates).toEqual([
      0, 0,
    ]);

    const missing = await kernel.invoke('history.rollback', {
      featureId: 'a',
      version: 99,
    });
    expect(missing.error?.code).toBe('validation_failed');
  });
});
