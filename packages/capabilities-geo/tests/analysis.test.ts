/**
 * T9 查询与分析组：query 谓词升级 + props.schema / features.validate /
 * measure.length·area / spatial.distance·nearest·within（一期 bbox/中心点级）。
 */
import { describe, expect, it } from 'vitest';
import type { LineString, Point, Polygon } from 'geojson';
import { createKernel, type SarKernel } from '@geoverse-sar/kernel';
import {
  ChangeSetAlgebra,
  createGeoEngine,
  type ChangeSet,
  type EditableFeature,
} from '@geoverse-sar/engine-geo';
import { createGeoPack } from '../src/index';

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

function setup(seed: EditableFeature[]): SarKernel<EditableFeature, ChangeSet> {
  return createKernel<EditableFeature, ChangeSet>({
    engine: createGeoEngine({ features: seed }),
    algebra: new ChangeSetAlgebra(),
    packs: [createGeoPack()],
  });
}

const SEED = [
  pt('a', 0, 0, { type: 'poi', pop: 100, name: 'Alpha' }),
  pt('b', 10, 0, { type: 'poi', pop: 500, name: 'Bravo' }),
  pt('c', 3, 4, { type: 'road', pop: 50, name: 'Charlie' }),
];

describe('features.query 谓词升级（where）', () => {
  it('gt/contains 按 and 组合；or 组合命中并集', async () => {
    const kernel = setup(SEED);
    const andOut = await kernel.invoke<{ count: number; features: { id: string }[] }>(
      'features.query',
      {
        where: [
          { field: 'pop', op: 'gt', value: 60 },
          { field: 'name', op: 'contains', value: 'ra' },
        ],
      },
    );
    expect(andOut.ok).toBe(true);
    expect(andOut.output!.features.map((f) => f.id)).toEqual(['b']); // pop>60 且名含 ra

    const orOut = await kernel.invoke<{ features: { id: string }[] }>('features.query', {
      where: [
        { field: 'type', op: 'eq', value: 'road' },
        { field: 'pop', op: 'range', min: 400, max: 600 },
      ],
      logic: 'or',
    });
    expect(orOut.output!.features.map((f) => f.id).sort()).toEqual(['b', 'c']);
  });

  it('oneOf 缺 values / range 缺边界拒绝', async () => {
    const kernel = setup(SEED);
    const bad = await kernel.invoke('features.query', {
      where: [{ field: 'type', op: 'oneOf' }],
    });
    expect(bad.ok).toBe(false);
  });
});

describe('props.schema / features.validate', () => {
  it('推断字段 Schema（名称/类型）', async () => {
    const kernel = setup(SEED);
    const out = await kernel.invoke<{ fields: { name: string; type: string }[] }>(
      'props.schema',
      {},
    );
    expect(out.ok).toBe(true);
    const byName = Object.fromEntries(out.output!.fields.map((f) => [f.name, f.type]));
    expect(byName.type).toBe('string');
    expect(['int', 'float']).toContain(byName.pop);
  });

  it('validate：类型一致时问题清单为空', async () => {
    const kernel = setup(SEED);
    const out = await kernel.invoke<{ count: number }>('features.validate', {});
    expect(out.ok).toBe(true);
    expect(out.output!.count).toBe(0);
  });
});

describe('measure.length / measure.area', () => {
  const line: EditableFeature = {
    id: 'l1',
    geometry: {
      type: 'LineString',
      coordinates: [
        [0, 0],
        [3, 4],
      ],
    } as LineString,
    properties: {},
  };
  const holedSquare: EditableFeature = {
    id: 'p1',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
        [
          [4, 4],
          [6, 4],
          [6, 6],
          [4, 6],
          [4, 4],
        ],
      ],
    } as Polygon,
    properties: {},
  };

  it('线长/面周长/含洞面积（洞扣除）；点量长度拒绝', async () => {
    const kernel = setup([line, holedSquare, pt('a', 0, 0)]);
    const len = await kernel.invoke<{ length: number }>('measure.length', { id: 'l1' });
    expect(len.output!.length).toBeCloseTo(5, 9);

    const perimeter = await kernel.invoke<{ length: number }>('measure.length', {
      id: 'p1',
    });
    expect(perimeter.output!.length).toBeCloseTo(48, 9); // 外环 40 + 洞环 8

    const area = await kernel.invoke<{ area: number }>('measure.area', { id: 'p1' });
    expect(area.output!.area).toBeCloseTo(96, 9); // 100 − 4

    const bad = await kernel.invoke('measure.length', { id: 'a' });
    expect(bad.ok).toBe(false);
  });
});

describe('spatial.distance / nearest / within', () => {
  it('distance=中心点欧氏；nearest 排除自身可过滤；within=bbox 级含容器排除', async () => {
    const kernel = setup(SEED);
    const d = await kernel.invoke<{ distance: number }>('spatial.distance', {
      a: 'a',
      b: 'c',
    });
    expect(d.output!.distance).toBeCloseTo(5, 9);

    const near = await kernel.invoke<{ results: { id: string }[] }>('spatial.nearest', {
      id: 'a',
      k: 1,
      propsEquals: { type: 'poi' },
    });
    expect(near.output!.results.map((r) => r.id)).toEqual(['b']); // c 更近但被过滤

    const within = await kernel.invoke<{ ids: string[] }>('spatial.within', {
      bbox: [-1, -1, 5, 5],
    });
    expect(within.output!.ids.sort()).toEqual(['a', 'c']);
  });
});
