/**
 * 空间观察器（阶段二 T10，ROADMAP P0-3）：把「地图上现在是什么样」压缩成
 * LLM 友好的小体积摘要，经 agent 的 enrichObservation 钩子注入观察面。
 * 零依赖 grid-binning + token 白名单裁剪（格子/属性值分布均设上限）；
 * 不 import agent 包（依赖方向），返回的增强函数与其 ObservationEnricher 结构兼容。
 */
import type { SarKernel } from '@geoverse-sar/kernel';
import type { ChangeSet, EditableFeature } from '@geoverse-sar/engine-geo';
import { bboxOf, centerOf, type Bbox } from './geometry';
import type { GeoViewService } from './view-service';

export interface SpatialObserverOptions {
  /** 网格分辨率 N（N×N），默认 4。 */
  grid?: number;
  /** 输出的非空格子上限（按要素数降序截断），默认 12——token 裁剪。 */
  maxCells?: number;
  /** 统计值分布的属性字段白名单，默认 ['type']。 */
  propsWhitelist?: string[];
  /** 每字段值分布 top-N，默认 6。 */
  maxPropValues?: number;
  /** 可选：视野服务（实现 getViewport 时摘要携带当前视野）。 */
  view?: GeoViewService;
}

export interface SpatialSummary {
  bbox: Bbox | null;
  featureCount: number;
  geometryTypes: Record<string, number>;
  /** 非空格子（"row,col" → 要素数），按密度降序截断。 */
  grid: { size: number; cells: { cell: string; count: number }[] };
  /** 白名单字段的值分布（top-N）。 */
  props: Record<string, Record<string, number>>;
  viewport?: Bbox;
}

function summarize(
  features: EditableFeature[],
  opts: Required<
    Pick<SpatialObserverOptions, 'grid' | 'maxCells' | 'propsWhitelist' | 'maxPropValues'>
  >,
  view?: GeoViewService,
): SpatialSummary {
  const geometryTypes: Record<string, number> = {};
  const props: Record<string, Record<string, number>> = {};
  if (features.length === 0) {
    return {
      bbox: null,
      featureCount: 0,
      geometryTypes,
      grid: { size: opts.grid, cells: [] },
      props,
      viewport: view?.getViewport?.(),
    };
  }

  let [minX, minY, maxX, maxY] = bboxOf(features[0].geometry);
  const centers = features.map((f) => {
    const [a, b, c, d] = bboxOf(f.geometry);
    minX = Math.min(minX, a);
    minY = Math.min(minY, b);
    maxX = Math.max(maxX, c);
    maxY = Math.max(maxY, d);
    return centerOf(f.geometry);
  });

  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const bins = new Map<string, number>();
  features.forEach((f, i) => {
    geometryTypes[f.geometry.type] = (geometryTypes[f.geometry.type] ?? 0) + 1;
    const col = Math.min(
      opts.grid - 1,
      Math.floor(((centers[i].x - minX) / spanX) * opts.grid),
    );
    const row = Math.min(
      opts.grid - 1,
      Math.floor(((centers[i].y - minY) / spanY) * opts.grid),
    );
    const key = `${row},${col}`;
    bins.set(key, (bins.get(key) ?? 0) + 1);
    for (const field of opts.propsWhitelist) {
      const v = f.properties[field];
      if (v === undefined || v === null) continue;
      const bucket = (props[field] ??= {});
      const label = String(v);
      bucket[label] = (bucket[label] ?? 0) + 1;
    }
  });

  // token 裁剪：格子按密度降序截断；属性值分布留 top-N
  const cells = [...bins.entries()]
    .map(([cell, count]) => ({ cell, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, opts.maxCells);
  for (const field of Object.keys(props)) {
    props[field] = Object.fromEntries(
      Object.entries(props[field])
        .sort((a, b) => b[1] - a[1])
        .slice(0, opts.maxPropValues),
    );
  }

  return {
    bbox: [minX, minY, maxX, maxY],
    featureCount: features.length,
    geometryTypes,
    grid: { size: opts.grid, cells },
    props,
    viewport: view?.getViewport?.(),
  };
}

/**
 * 创建观察增强器：挂到 `createAgent({ enrichObservation: createSpatialObserver(kernel) })`。
 * 每步基于引擎当前快照产出 `extra.spatial` 摘要。
 */
export function createSpatialObserver(
  kernel: SarKernel<EditableFeature, ChangeSet>,
  options: SpatialObserverOptions = {},
): <T extends { extra?: Record<string, unknown> }>(observation: T) => T {
  const opts = {
    grid: options.grid ?? 4,
    maxCells: options.maxCells ?? 12,
    propsWhitelist: options.propsWhitelist ?? ['type'],
    maxPropValues: options.maxPropValues ?? 6,
  };
  return (observation) => ({
    ...observation,
    extra: {
      ...observation.extra,
      spatial: summarize(
        [...kernel.engine.snapshot().entities.values()],
        opts,
        options.view,
      ),
    },
  });
}
