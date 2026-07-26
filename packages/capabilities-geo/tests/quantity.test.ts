/**
 * U0-4 Quantity 采纳：buffer/offset 距离入参 union 过渡（裸数字=CRS 平面单位 /
 * { value, unit } 带单位对象）。单位换算永不靠猜：m/km/deg 依赖宿主经
 * createGeoPack({ localUnit }) 声明工作区单位，未声明/不匹配→结构化拒绝。
 */
import { describe, expect, it } from 'vitest';
import type { Point } from 'geojson';
import { createKernel, type SarKernel } from '@geoverse-sar/kernel';
import {
  ChangeSetAlgebra,
  createGeoEngine,
  GeoStateEngine,
  type ChangeSet,
  type EditableFeature,
} from '@geoverse-sar/engine-geo';
import { bboxOf } from '@geoverse-sar/geo-profile';
import { createGeoPack, type CreateGeoPackOptions } from '../src/index';

const pt = (id: string, x: number, y: number): EditableFeature => ({
  id,
  geometry: { type: 'Point', coordinates: [x, y] } as Point,
  properties: { name: id },
});

function setup(options: CreateGeoPackOptions = {}): {
  kernel: SarKernel<EditableFeature, ChangeSet>;
  engine: GeoStateEngine;
} {
  const engine = createGeoEngine({ features: [pt('p1', 0, 0)] });
  const kernel = createKernel<EditableFeature, ChangeSet>({
    engine,
    algebra: new ChangeSetAlgebra(),
    packs: [createGeoPack(options)],
  });
  return { kernel, engine };
}

const bufferRadius = (engine: GeoStateEngine, id: string): number => {
  const g = engine.snapshot().entities.get(id)!.geometry;
  const [minX, , maxX] = bboxOf(g);
  return (maxX - minX) / 2;
};

describe('U0-4 buffer/offset 的 Quantity 距离入参', () => {
  it("裸数字与 { value, unit: 'local' } 等价（过渡期兼容）", async () => {
    const { kernel, engine } = setup();
    const a = await kernel.invoke<{ ids: string[] }>('features.buffer', {
      ids: ['p1'],
      distance: 10,
    });
    const b = await kernel.invoke<{ ids: string[] }>('features.buffer', {
      ids: ['p1'],
      distance: { value: 10, unit: 'local' },
    });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(bufferRadius(engine, a.output!.ids[0])).toBeCloseTo(
      bufferRadius(engine, b.output!.ids[0]),
      9,
    );
  });

  it("宿主声明 localUnit:'m' 后：unit:'km' 换算 ×1000", async () => {
    const { kernel, engine } = setup({ localUnit: 'm' });
    const km = await kernel.invoke<{ ids: string[] }>('features.buffer', {
      ids: ['p1'],
      distance: { value: 0.01, unit: 'km' },
    });
    expect(km.ok).toBe(true);
    expect(bufferRadius(engine, km.output!.ids[0])).toBeCloseTo(10, 6);
  });

  it('未知单位被 schema 结构化拒绝（validation_failed + issues，AI 可自纠）', async () => {
    const { kernel } = setup();
    const bad = await kernel.invoke('features.buffer', {
      ids: ['p1'],
      distance: { value: 500, unit: 'mile' },
    });
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe('validation_failed');
    expect(bad.issues?.some((i) => i.path.includes('distance'))).toBe(true);
  });

  it('未声明工作区单位时 m/km/deg 结构化拒绝——换算不靠猜', async () => {
    const { kernel } = setup();
    const out = await kernel.invoke('features.buffer', {
      ids: ['p1'],
      distance: { value: 500, unit: 'm' },
    });
    expect(out.ok).toBe(false);
    expect(out.error?.message).toContain('未声明工作区平面单位');
  });

  it("localUnit:'m' 下 unit:'deg' 口径不匹配拒绝", async () => {
    const { kernel } = setup({ localUnit: 'm' });
    const out = await kernel.invoke('features.offset', {
      id: 'p1',
      distance: { value: 1, unit: 'deg' },
    });
    expect(out.ok).toBe(false);
    expect(out.error?.message).toContain('不匹配');
  });
});
