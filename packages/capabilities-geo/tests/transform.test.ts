/**
 * T7 几何变换组：rotate / scale / mirror / buffer / offset。
 * 断言姿势同 pack.test：invoke → 快照几何核对 → undo 一键回退（modified 走 before/after）。
 */
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
import { createGeoPack } from '../src/index';

const pt = (id: string, x: number, y: number): EditableFeature => ({
  id,
  geometry: { type: 'Point', coordinates: [x, y] } as Point,
  properties: { name: id },
});

const line = (id: string, coords: number[][]): EditableFeature => ({
  id,
  geometry: { type: 'LineString', coordinates: coords } as LineString,
  properties: { name: id },
});

function setup(seed: EditableFeature[]): {
  kernel: SarKernel<EditableFeature, ChangeSet>;
  engine: GeoStateEngine;
} {
  const engine = createGeoEngine({ features: seed });
  const kernel = createKernel<EditableFeature, ChangeSet>({
    engine,
    algebra: new ChangeSetAlgebra(),
    packs: [createGeoPack()],
  });
  return { kernel, engine };
}

const coordsOf = (engine: GeoStateEngine, id: string): number[] =>
  (engine.snapshot().entities.get(id)!.geometry as Point).coordinates as number[];

describe('features.rotate', () => {
  it('绕指定 origin 旋转 90°（逆时针），undo 一键回退', async () => {
    const { kernel, engine } = setup([pt('p1', 1, 0)]);
    const out = await kernel.invoke('features.rotate', {
      ids: ['p1'],
      angle: 90,
      origin: { x: 0, y: 0 },
    });
    expect(out.ok).toBe(true);
    const [x, y] = coordsOf(engine, 'p1');
    expect(x).toBeCloseTo(0, 9);
    expect(y).toBeCloseTo(1, 9);
    engine.undo();
    expect(coordsOf(engine, 'p1')).toEqual([1, 0]);
  });

  it('缺省 origin=所选集合 bbox 中心（两点互旋，中心不动）', async () => {
    const { kernel, engine } = setup([pt('a', 0, 0), pt('b', 2, 2)]);
    const out = await kernel.invoke('features.rotate', { ids: ['a', 'b'], angle: 180 });
    expect(out.ok).toBe(true);
    expect(coordsOf(engine, 'a')[0]).toBeCloseTo(2, 9);
    expect(coordsOf(engine, 'a')[1]).toBeCloseTo(2, 9);
    expect(coordsOf(engine, 'b')[0]).toBeCloseTo(0, 9);
  });
});

describe('features.scale / mirror', () => {
  it('scale 绕 origin 放大 2 倍；factor=0 拒绝', async () => {
    const { kernel, engine } = setup([pt('p1', 1, 1)]);
    const out = await kernel.invoke('features.scale', {
      ids: ['p1'],
      factor: 2,
      origin: { x: 0, y: 0 },
    });
    expect(out.ok).toBe(true);
    expect(coordsOf(engine, 'p1')).toEqual([2, 2]);

    const bad = await kernel.invoke('features.scale', { ids: ['p1'], factor: 0 });
    expect(bad.ok).toBe(false);
  });

  it('mirror 关于竖直轴翻转；轴两点重合拒绝', async () => {
    const { kernel, engine } = setup([pt('p1', 2, 1)]);
    const out = await kernel.invoke('features.mirror', {
      ids: ['p1'],
      a: { x: 0, y: 0 },
      b: { x: 0, y: 1 },
    });
    expect(out.ok).toBe(true);
    expect(coordsOf(engine, 'p1')[0]).toBeCloseTo(-2, 9);
    expect(coordsOf(engine, 'p1')[1]).toBeCloseTo(1, 9);

    const bad = await kernel.invoke('features.mirror', {
      ids: ['p1'],
      a: { x: 1, y: 1 },
      b: { x: 1, y: 1 },
    });
    expect(bad.ok).toBe(false);
  });
});

describe('features.buffer / offset（派生新要素，原要素保留）', () => {
  it('点缓冲出面要素、继承属性；undo 移除派生要素', async () => {
    const { kernel, engine } = setup([pt('p1', 0, 0)]);
    const out = await kernel.invoke<{ ids: string[] }>('features.buffer', {
      ids: ['p1'],
      distance: 10,
    });
    expect(out.ok).toBe(true);
    const newId = out.output!.ids[0];
    const derived = engine.snapshot().entities.get(newId)!;
    expect(['Polygon', 'MultiPolygon']).toContain(derived.geometry.type);
    expect(derived.properties).toEqual({ name: 'p1' }); // 继承属性
    expect(engine.snapshot().entities.has('p1')).toBe(true); // 原要素保留
    // 缓冲圈应覆盖原点外扩 ~10（bbox 粗验）
    const ring = (derived.geometry as Polygon).coordinates[0];
    const maxX = Math.max(...ring.map((c) => c[0]));
    expect(maxX).toBeCloseTo(10, 1);

    engine.undo();
    expect(engine.snapshot().entities.has(newId)).toBe(false);
  });

  it('offset 对线生成平行线；非线要素拒绝', async () => {
    const { kernel, engine } = setup([
      line('l1', [
        [0, 0],
        [10, 0],
      ]),
      pt('p1', 0, 0),
    ]);
    const out = await kernel.invoke<{ id: string }>('features.offset', {
      id: 'l1',
      distance: 2,
    });
    expect(out.ok).toBe(true);
    const derived = engine.snapshot().entities.get(out.output!.id)!;
    // 沿 +x 行进，左侧=+y：整条线平移到 y=2
    expect((derived.geometry as LineString).coordinates).toEqual([
      [0, 2],
      [10, 2],
    ]);

    const bad = await kernel.invoke('features.offset', { id: 'p1', distance: 2 });
    expect(bad.ok).toBe(false);
  });

  it('id 不存在整体失败（buffer 多 id 原子性）', async () => {
    const { kernel, engine } = setup([pt('p1', 0, 0)]);
    const out = await kernel.invoke('features.buffer', {
      ids: ['p1', 'ghost'],
      distance: 5,
    });
    expect(out.ok).toBe(false);
    expect(engine.snapshot().entities.size).toBe(1); // 无部分写入
  });
});
