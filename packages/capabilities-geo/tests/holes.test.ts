/**
 * T8 洞族四能力：punchHole / fillHole / openHole / closeHole。
 * 几何断言走环数（外环+内环），undo 一键回退；退化入参走拒绝路径。
 */
import { describe, expect, it } from 'vitest';
import type { Polygon } from 'geojson';
import { createKernel, type SarKernel } from '@geoverse-sar/kernel';
import {
  ChangeSetAlgebra,
  createGeoEngine,
  GeoStateEngine,
  type ChangeSet,
  type EditableFeature,
} from '@geoverse-sar/engine-geo';
import { createGeoPack } from '../src/index';

const squareRing = (x: number, y: number, size: number): number[][] => [
  [x, y],
  [x + size, y],
  [x + size, y + size],
  [x, y + size],
  [x, y],
];

const polygon = (id: string, rings: number[][][]): EditableFeature => ({
  id,
  geometry: { type: 'Polygon', coordinates: rings } as Polygon,
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

const ringsOf = (engine: GeoStateEngine, id: string): number =>
  (engine.snapshot().entities.get(id)!.geometry as Polygon).coordinates.length;

describe('features.punchHole / fillHole（结构性插环/移环）', () => {
  it('挖洞 → 内环 +1（外环精确不变）；fillHole 填回 → 只剩外环；undo 全程可退', async () => {
    const { kernel, engine } = setup([polygon('p1', [squareRing(0, 0, 10)])]);

    const punched = await kernel.invoke('features.punchHole', {
      id: 'p1',
      hole: [
        [4, 4],
        [6, 4],
        [6, 6],
        [4, 6],
      ], // 未闭合，自动补
    });
    expect(punched.ok).toBe(true);
    expect(ringsOf(engine, 'p1')).toBe(2);
    // 外边界精确保留（非布尔运算）
    const outer = (engine.snapshot().entities.get('p1')!.geometry as Polygon)
      .coordinates[0];
    expect(outer).toEqual(squareRing(0, 0, 10));

    const filled = await kernel.invoke('features.fillHole', { ids: ['p1'] });
    expect(filled.ok).toBe(true);
    expect(ringsOf(engine, 'p1')).toBe(1);

    engine.undo(); // 回到有洞
    expect(ringsOf(engine, 'p1')).toBe(2);
    engine.undo(); // 回到无洞
    expect(ringsOf(engine, 'p1')).toBe(1);
  });

  it('无洞面 fillHole 拒绝；非面要素 punchHole 拒绝', async () => {
    const { kernel } = setup([
      polygon('p1', [squareRing(0, 0, 10)]),
      {
        id: 'l1',
        geometry: {
          type: 'LineString',
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        },
        properties: {},
      },
    ]);
    const fill = await kernel.invoke('features.fillHole', { ids: ['p1'] });
    expect(fill.ok).toBe(false);
    expect(fill.error?.message).toContain('没有洞');

    const punch = await kernel.invoke('features.punchHole', {
      id: 'l1',
      hole: [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
    });
    expect(punch.ok).toBe(false);
  });
});

describe('features.openHole / closeHole（非分离切互逆对）', () => {
  const holed = () => polygon('p1', [squareRing(0, 0, 10), squareRing(4, 4, 2)]);

  it('开洞：洞并入外环成凹湾（仍 1 块、内环 -1）；closeHole 一键封回', async () => {
    const { kernel, engine } = setup([holed()]);

    const opened = await kernel.invoke('features.openHole', {
      id: 'p1',
      cut: [
        [5, -1],
        [5, 5],
      ], // 从下边界外进入洞内
    });
    expect(opened.ok).toBe(true);
    const afterOpen = engine.snapshot().entities.get('p1')!.geometry as Polygon;
    expect(afterOpen.type).toBe('Polygon'); // 仍是 1 块
    expect(afterOpen.coordinates.length).toBe(1); // 洞没了（成凹湾）

    const closed = await kernel.invoke('features.closeHole', { id: 'p1' });
    expect(closed.ok).toBe(true);
    expect(ringsOf(engine, 'p1')).toBe(2); // 凹湾封回内环洞

    engine.undo();
    expect(ringsOf(engine, 'p1')).toBe(1);
    engine.undo();
    expect(ringsOf(engine, 'p1')).toBe(2); // 回到初始有洞态
  });

  it('凸面（无凹湾）closeHole 明确拒绝', async () => {
    const { kernel } = setup([polygon('p1', [squareRing(0, 0, 10)])]);
    const out = await kernel.invoke('features.closeHole', { id: 'p1' });
    expect(out.ok).toBe(false);
  });
});
