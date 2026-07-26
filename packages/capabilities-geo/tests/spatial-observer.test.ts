/**
 * T10 空间观察器：grid-binning 摘要 + token 裁剪 + viewport 透传；
 * 与 agent enrichObservation 钩子的结构兼容（不 import agent 包）。
 */
import { describe, expect, it } from 'vitest';
// U4-A 追加：provider 形态 + spatial.summary 下钻（文件尾部 describe）。
import type { Point } from 'geojson';
import { createKernel } from '@geoverse-sar/kernel';
import {
  ChangeSetAlgebra,
  createGeoEngine,
  type EditableFeature,
} from '@geoverse-sar/engine-geo';
import {
  createGeoPack,
  createSpatialObserver,
  createSpatialSummaryProvider,
  type SpatialSummary,
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

describe('U4-A：provider 形态 + spatial.summary 下钻', () => {
  it('createSpatialSummaryProvider：独立观察段（name=spatial）+ 预算位透传', () => {
    const kernel = kernelOf([
      pt('a', 0, 0, { type: 'poi' }),
      pt('b', 9, 9, { type: 'poi' }),
    ]);
    const provider = createSpatialSummaryProvider(kernel, { budget: 300 });
    expect(provider.name).toBe('spatial');
    expect(provider.budget).toBe(300);
    const summary = provider.provide({});
    expect(summary.featureCount).toBe(2);
    expect(summary.grid.size).toBe(4);
  });

  it('spatial.summary：概览格分布；下钻某格出命名集句柄可直接喂 target', async () => {
    const kernel = kernelOf([
      pt('a', 0, 0, { type: 'poi' }),
      pt('b', 1, 1, { type: 'poi' }),
      pt('c', 99, 99, { type: 'poi' }),
    ]);
    const overview = await kernel.invoke<{
      featureCount: number;
      cells: { cell: string; count: number }[];
    }>('spatial.summary', { grid: 4 });
    expect(overview.ok).toBe(true);
    expect(overview.output!.featureCount).toBe(3);
    const dense = overview.output!.cells[0];
    expect(dense.count).toBe(2);

    const drill = await kernel.invoke<{
      cellDetail: { setId: string; count: number; sample: string[] };
    }>('spatial.summary', { grid: 4, cell: dense.cell });
    expect(drill.output!.cellDetail.count).toBe(2);
    expect(drill.output!.cellDetail.sample.sort()).toEqual(['a', 'b']);

    const move = await kernel.invoke<{ count: number }>('features.translate', {
      target: { setId: drill.output!.cellDetail.setId },
      dx: 1,
      dy: 0,
    });
    expect(move.output!.count).toBe(2);
  });
});
