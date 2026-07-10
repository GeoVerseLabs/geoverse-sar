/**
 * T10 空间观察器：grid-binning 摘要 + token 裁剪 + viewport 透传；
 * 与 agent enrichObservation 钩子的结构兼容（不 import agent 包）。
 */
import { describe, expect, it } from 'vitest';
import type { Point } from 'geojson';
import { createKernel } from '@geoverse-sar/kernel';
import {
  ChangeSetAlgebra,
  createGeoEngine,
  type EditableFeature,
} from '@geoverse-sar/engine-geo';
import { createGeoPack, createSpatialObserver, type SpatialSummary } from '../src/index';

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

function kernelOf(seed: EditableFeature[]) {
  return createKernel({
    engine: createGeoEngine({ features: seed }),
    algebra: new ChangeSetAlgebra(),
    packs: [createGeoPack()],
  });
}

describe('createSpatialObserver', () => {
  it('grid-binning：密集角落聚类可见、几何/属性分布统计、原观察字段保留', () => {
    const seed = [
      pt('a', 1, 1, { type: 'poi' }),
      pt('b', 2, 2, { type: 'poi' }),
      pt('c', 1, 2, { type: 'poi' }),
      pt('d', 99, 99, { type: 'road' }),
    ];
    const enrich = createSpatialObserver(kernelOf(seed), { grid: 2 });
    const enriched = enrich({
      goal: '巡查',
      extra: { keep: 1 } as Record<string, unknown>,
    });

    expect(enriched.goal).toBe('巡查');
    expect(enriched.extra!.keep).toBe(1); // 既有 extra 不丢
    const spatial = enriched.extra!.spatial as SpatialSummary;
    expect(spatial.featureCount).toBe(4);
    expect(spatial.geometryTypes.Point).toBe(4);
    expect(spatial.props.type).toEqual({ poi: 3, road: 1 });
    // 左下角格子聚了 3 个（密度降序第一）
    expect(spatial.grid.cells[0]).toEqual({ cell: '0,0', count: 3 });
  });

  it('token 裁剪：格子数与属性值分布按上限截断', () => {
    const seed = Array.from({ length: 30 }, (_, i) =>
      pt(`p${i}`, (i % 6) * 10, Math.floor(i / 6) * 10, { type: `k${i}` }),
    );
    const enrich = createSpatialObserver(kernelOf(seed), {
      grid: 6,
      maxCells: 5,
      maxPropValues: 3,
    });
    const spatial = enrich({} as { extra?: Record<string, unknown> }).extra!
      .spatial as SpatialSummary;
    expect(spatial.grid.cells.length).toBeLessThanOrEqual(5);
    expect(Object.keys(spatial.props.type).length).toBe(3);
  });

  it('空工作区安全返回；viewport 经 view 服务透传', () => {
    const enrich = createSpatialObserver(kernelOf([]), {
      view: {
        focus() {},
        current: () => undefined,
        onChange: () => () => {},
        getViewport: () => [0, 0, 10, 10],
      },
    });
    const spatial = enrich({} as { extra?: Record<string, unknown> }).extra!
      .spatial as SpatialSummary;
    expect(spatial.featureCount).toBe(0);
    expect(spatial.bbox).toBeNull();
    expect(spatial.viewport).toEqual([0, 0, 10, 10]);
  });
});
