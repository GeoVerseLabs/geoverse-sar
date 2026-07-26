/**
 * 空间观察器（阶段二 T10，ROADMAP P0-3）：把「地图上现在是什么样」压缩成
 * LLM 友好的小体积摘要，经 agent 的 enrichObservation 钩子注入观察面。
 * 零依赖 grid-binning + token 白名单裁剪（格子/属性值分布均设上限）；
 * 不 import agent 包（依赖方向），返回的增强函数与其 ObservationEnricher 结构兼容。
 */
import { z } from 'zod';
import {
  SETS_SERVICE_KEY,
  type Capability,
  type NamedSetService,
  type SarKernel,
} from '@geoverse-sar/kernel';
import type { ChangeSet, EditableFeature } from '@geoverse-sar/engine-geo';
import { bboxOf, centerOf, type Bbox } from './geometry';
import type { GeoViewService } from './view-service';

/** 同一 binning 公式（summarize 与 spatial.summary 下钻共用——两处漂移即摘要与下钻对不上）。 */
function binKey(
  center: { x: number; y: number },
  bounds: { minX: number; minY: number; spanX: number; spanY: number },
  grid: number,
): string {
  const col = Math.min(
    grid - 1,
    Math.floor(((center.x - bounds.minX) / bounds.spanX) * grid),
  );
  const row = Math.min(
    grid - 1,
    Math.floor(((center.y - bounds.minY) / bounds.spanY) * grid),
  );
  return `${row},${col}`;
}

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
  const bounds = { minX, minY, spanX, spanY };
  const bins = new Map<string, number>();
  features.forEach((f, i) => {
    geometryTypes[f.geometry.type] = (geometryTypes[f.geometry.type] ?? 0) + 1;
    const key = binKey(centers[i], bounds, opts.grid);
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

/**
 * U4-A：ObservationProvider 形态（结构兼容 agent 的 observers 列表，不 import agent）。
 * 与 createSpatialObserver 同一摘要，多出：独立观察段（extra.spatial）+ token 预算位。
 */
export function createSpatialSummaryProvider(
  kernel: SarKernel<EditableFeature, ChangeSet>,
  options: SpatialObserverOptions & { budget?: number } = {},
): {
  name: string;
  budget?: number;
  provide(observation: unknown): SpatialSummary;
} {
  const opts = {
    grid: options.grid ?? 4,
    maxCells: options.maxCells ?? 12,
    propsWhitelist: options.propsWhitelist ?? ['type'],
    maxPropValues: options.maxPropValues ?? 6,
  };
  return {
    name: 'spatial',
    ...(options.budget !== undefined ? { budget: options.budget } : {}),
    provide: () =>
      summarize([...kernel.engine.snapshot().entities.values()], opts, options.view),
  };
}

// ---- spatial.summary：分层摘要的"按需下钻"读端（U4-A）----
// 总体统计→分区聚合在 provider/概览里；下钻某格走本能力——read 走漏斗天然入审计，
// 格内成员出**命名集句柄**（U3-C），后续写操作直接 target:{setId}。

const summaryInput = z.object({
  grid: z.number().int().min(2).max(16).default(4).describe('网格分辨率 N（N×N）'),
  cell: z
    .string()
    .regex(/^\d+,\d+$/)
    .optional()
    .describe('下钻格键 "row,col"（概览 cells 里的键）；缺省只出概览'),
});
const summaryOutput = z.object({
  featureCount: z.number(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
  grid: z.number(),
  cells: z.array(z.object({ cell: z.string(), count: z.number() })),
  cellDetail: z
    .object({
      cell: z.string(),
      setId: z.string().describe('格内要素的命名集句柄——写能力用 target:{setId}'),
      count: z.number(),
      sample: z.array(z.string()).describe('前 10 个要素 id'),
    })
    .optional(),
});

type GeoCap<I, O> = Capability<I, O, EditableFeature, ChangeSet>;

export const spatialSummaryCapability: GeoCap<
  z.infer<typeof summaryInput>,
  z.infer<typeof summaryOutput>
> = {
  id: 'spatial.summary',
  title: '空间分层摘要',
  description:
    '把当前要素分布压缩成 N×N 网格概览（哪个格子多密）；带 cell 参数可下钻某格，' +
    '取得格内要素的命名集句柄（target:{setId} 可直接批量操作）。大场景先概览再下钻，不要全量查询。只读。',
  category: 'query',
  kind: 'read',
  tags: ['spatial', 'observe', 'refer'],
  since: '2026-07-27',
  inputSchema: summaryInput,
  outputSchema: summaryOutput,
  handler: async (ctx, input) => {
    const features = ctx.state.list();
    if (features.length === 0) {
      return {
        output: { featureCount: 0, bbox: null, grid: input.grid, cells: [] },
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
    const bounds = { minX, minY, spanX: maxX - minX || 1, spanY: maxY - minY || 1 };
    const bins = new Map<string, string[]>();
    features.forEach((f, i) => {
      const key = binKey(centers[i], bounds, input.grid);
      const bucket = bins.get(key) ?? [];
      bucket.push(f.id);
      bins.set(key, bucket);
    });
    const cells = [...bins.entries()]
      .map(([cell, ids]) => ({ cell, count: ids.length }))
      .sort((a, b) => b.count - a.count);

    let cellDetail: z.infer<typeof summaryOutput>['cellDetail'];
    if (input.cell) {
      const ids = bins.get(input.cell) ?? [];
      const sets = ctx.services.require<NamedSetService>(SETS_SERVICE_KEY);
      const setId = sets.save(
        ids,
        `spatial.summary 格 ${input.cell} 内 ${ids.length} 条`,
      );
      cellDetail = {
        cell: input.cell,
        setId,
        count: ids.length,
        sample: ids.slice(0, 10),
      };
    }
    return {
      output: {
        featureCount: features.length,
        bbox: [minX, minY, maxX, maxY],
        grid: input.grid,
        cells,
        ...(cellDetail ? { cellDetail } : {}),
      },
    };
  },
};
