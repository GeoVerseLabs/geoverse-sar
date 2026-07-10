/**
 * 查询与分析组（阶段二 T9）：props.schema / features.validate /
 * measure.length / measure.area / spatial.distance / spatial.nearest / spatial.within。
 * 全部只读；谓词/Schema 走 engine-geo 桥的 editor-core 工具（RFC-0007）。
 * 空间三件一期为 bbox/中心点级（平面欧氏，明示在 description）。
 */
import { z } from 'zod';
import type { Capability } from '@geoverse-sar/kernel';
import {
  inferSchema,
  lineLength,
  validateValue,
  type ChangeSet,
  type EditableFeature,
} from '@geoverse-sar/engine-geo';
import type { LineString, MultiPolygon, Polygon, Position } from 'geojson';
import { bboxOf, centerOf, type Bbox } from './geometry';

type GeoCapability<I, O> = Capability<I, O, EditableFeature, ChangeSet>;

const idInput = z.object({ id: z.string() });

function must(state: { get(id: string): EditableFeature | undefined }, id: string) {
  const f = state.get(id);
  if (!f) throw new Error(`要素不存在: ${id}`);
  return f;
}

// ---- props.schema（推断字段 Schema）----

const schemaOutput = z.object({
  fields: z.array(
    z
      .object({ name: z.string(), type: z.string() })
      .loose()
      .describe('字段定义（editor-core FieldDef）'),
  ),
  featureCount: z.number(),
});

const propsSchema: GeoCapability<Record<string, never>, z.infer<typeof schemaOutput>> = {
  id: 'props.schema',
  title: '属性字段概览',
  description:
    '从当前全部要素的属性推断字段 Schema（字段名/类型/示例），了解"这批数据有哪些属性可查可改"时先调它。只读。',
  category: 'query',
  kind: 'read',
  tags: ['props', 'query'],
  inputSchema: z.object({}),
  outputSchema: schemaOutput,
  handler: async (ctx) => {
    const features = ctx.state.list();
    return {
      output: {
        fields: inferSchema(features) as z.infer<typeof schemaOutput>['fields'],
        featureCount: features.length,
      },
    };
  },
};

// ---- features.validate（属性按 Schema 校验）----

const validateOutput = z.object({
  issues: z.array(z.record(z.string(), z.unknown())),
  count: z.number(),
});

const validate: GeoCapability<Record<string, never>, z.infer<typeof validateOutput>> = {
  id: 'features.validate',
  title: '校验要素属性',
  description:
    '按推断出的字段 Schema 校验全部要素属性（类型不符/非法值），返回问题清单（featureIds/字段/信息）。只读；批量修数据前先调它。',
  category: 'query',
  kind: 'read',
  tags: ['props', 'query', 'validate'],
  inputSchema: z.object({}),
  outputSchema: validateOutput,
  handler: async (ctx) => {
    const features = ctx.state.list();
    const schema = inferSchema(features);
    const issues: Record<string, unknown>[] = [];
    for (const f of features) {
      for (const def of schema) {
        const value = f.properties[def.name];
        if (value === undefined) continue;
        for (const issue of validateValue(def, value, [f.id])) {
          issues.push({ ...issue });
        }
      }
    }
    return { output: { issues, count: issues.length } };
  },
};

// ---- measure.length / measure.area ----

function ringLength(ring: Position[]): number {
  return lineLength({ type: 'LineString', coordinates: ring } as LineString);
}

const lengthOutput = z.object({ length: z.number() });

const measureLength: GeoCapability<
  z.infer<typeof idInput>,
  z.infer<typeof lengthOutput>
> = {
  id: 'measure.length',
  title: '量算长度',
  description:
    '量算要素长度（CRS 单位，平面欧氏）：线要素=折线长，面要素=全部环的周长。只读。',
  category: 'query',
  kind: 'read',
  tags: ['measure', 'query'],
  inputSchema: idInput,
  outputSchema: lengthOutput,
  handler: async (ctx, input) => {
    const f = must(ctx.state, input.id);
    const g = f.geometry;
    if (g.type === 'LineString') {
      return { output: { length: lineLength(g as LineString) } };
    }
    if (g.type === 'Polygon') {
      const rings = (g as Polygon).coordinates;
      return { output: { length: rings.reduce((s, r) => s + ringLength(r), 0) } };
    }
    if (g.type === 'MultiPolygon') {
      const polys = (g as MultiPolygon).coordinates;
      return {
        output: {
          length: polys.reduce(
            (s, rings) => s + rings.reduce((t, r) => t + ringLength(r), 0),
            0,
          ),
        },
      };
    }
    throw new Error(`measure.length 不支持 ${g.type}（点无长度）`);
  },
};

/** 鞋带公式（平面）；洞面积为负自动扣除。 */
function ringArea(ring: Position[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return sum / 2;
}

function polygonArea(rings: Position[][]): number {
  // 外环取绝对值，内环（洞）按环面积符号扣除
  return rings.reduce(
    (s, r, i) => (i === 0 ? Math.abs(ringArea(r)) : s - Math.abs(ringArea(r))),
    0,
  );
}

const areaOutput = z.object({ area: z.number() });

const measureArea: GeoCapability<z.infer<typeof idInput>, z.infer<typeof areaOutput>> = {
  id: 'measure.area',
  title: '量算面积',
  description:
    '量算面要素面积（CRS 单位²，平面鞋带公式，洞自动扣除；MultiPolygon 求和）。只读；线/点无面积会报错。',
  category: 'query',
  kind: 'read',
  tags: ['measure', 'query'],
  inputSchema: idInput,
  outputSchema: areaOutput,
  handler: async (ctx, input) => {
    const f = must(ctx.state, input.id);
    const g = f.geometry;
    if (g.type === 'Polygon') {
      return { output: { area: polygonArea((g as Polygon).coordinates) } };
    }
    if (g.type === 'MultiPolygon') {
      const polys = (g as MultiPolygon).coordinates;
      return { output: { area: polys.reduce((s, rings) => s + polygonArea(rings), 0) } };
    }
    throw new Error(`measure.area 只支持面要素，得到 ${g.type}`);
  },
};

// ---- spatial.distance / nearest / within（一期：中心点/bbox 级，平面欧氏）----

const distInput = z.object({ a: z.string(), b: z.string() });
const distOutput = z.object({ distance: z.number() });

const dist = (p: { x: number; y: number }, q: { x: number; y: number }): number =>
  Math.hypot(p.x - q.x, p.y - q.y);

const spatialDistance: GeoCapability<
  z.infer<typeof distInput>,
  z.infer<typeof distOutput>
> = {
  id: 'spatial.distance',
  title: '要素间距',
  description:
    '两个要素中心点（bbox 中心）之间的平面欧氏距离（CRS 单位）。只读；一期为中心点级近似，非边界最近距离。',
  category: 'query',
  kind: 'read',
  tags: ['spatial', 'query'],
  inputSchema: distInput,
  outputSchema: distOutput,
  handler: async (ctx, input) => ({
    output: {
      distance: dist(
        centerOf(must(ctx.state, input.a).geometry),
        centerOf(must(ctx.state, input.b).geometry),
      ),
    },
  }),
};

const nearestInput = z
  .object({
    id: z.string().optional().describe('参考要素 id（与 point 二选一；自身不计入结果）'),
    point: z.object({ x: z.number(), y: z.number() }).optional().describe('参考坐标'),
    k: z.number().int().positive().default(1).describe('返回最近的前 k 个'),
    propsEquals: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('先按属性全等过滤候选'),
  })
  .refine((v) => v.id !== undefined || v.point !== undefined, {
    message: '给 id 或 point 之一作参考位置',
  });
const nearestOutput = z.object({
  results: z.array(z.object({ id: z.string(), distance: z.number() })),
});

const spatialNearest: GeoCapability<
  z.infer<typeof nearestInput>,
  z.infer<typeof nearestOutput>
> = {
  id: 'spatial.nearest',
  title: '最近要素',
  description:
    '找离参考位置（要素或坐标）最近的 k 个要素（中心点平面欧氏距离，可先按属性过滤）。只读。',
  category: 'query',
  kind: 'read',
  tags: ['spatial', 'query'],
  inputSchema: nearestInput,
  outputSchema: nearestOutput,
  handler: async (ctx, input) => {
    const origin = input.point ?? centerOf(must(ctx.state, input.id!).geometry);
    let candidates = ctx.state.list().filter((f) => f.id !== input.id);
    if (input.propsEquals) {
      const entries = Object.entries(input.propsEquals);
      candidates = candidates.filter((f) =>
        entries.every(([k, v]) => f.properties[k] === v),
      );
    }
    const results = candidates
      .map((f) => ({ id: f.id, distance: dist(origin, centerOf(f.geometry)) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, input.k);
    return { output: { results } };
  },
};

const withinInput = z
  .object({
    bbox: z
      .tuple([z.number(), z.number(), z.number(), z.number()])
      .optional()
      .describe('[minX,minY,maxX,maxY] 范围'),
    containerId: z.string().optional().describe('容器要素 id（用其 bbox 作范围）'),
  })
  .refine((v) => v.bbox !== undefined || v.containerId !== undefined, {
    message: '给 bbox 或 containerId 之一',
  });
const withinOutput = z.object({ ids: z.array(z.string()), count: z.number() });

const bboxContains = (outer: Bbox, inner: Bbox): boolean =>
  outer[0] <= inner[0] &&
  outer[1] <= inner[1] &&
  outer[2] >= inner[2] &&
  outer[3] >= inner[3];

const spatialWithin: GeoCapability<
  z.infer<typeof withinInput>,
  z.infer<typeof withinOutput>
> = {
  id: 'spatial.within',
  title: '范围内要素',
  description:
    '找完全落在给定范围内的要素（范围=显式 bbox 或某容器要素的 bbox；一期为 bbox 级判定，非精确面内包含）。只读；容器自身不计入。',
  category: 'query',
  kind: 'read',
  tags: ['spatial', 'query'],
  inputSchema: withinInput,
  outputSchema: withinOutput,
  handler: async (ctx, input) => {
    const outer = input.bbox ?? bboxOf(must(ctx.state, input.containerId!).geometry);
    const ids = ctx.state
      .list()
      .filter(
        (f) => f.id !== input.containerId && bboxContains(outer, bboxOf(f.geometry)),
      )
      .map((f) => f.id);
    return { output: { ids, count: ids.length } };
  },
};

/** T9 查询与分析组（features.query 的谓词升级在 pack.ts 就地扩展）。 */
export const analysisCapabilities = [
  propsSchema,
  validate,
  measureLength,
  measureArea,
  spatialDistance,
  spatialNearest,
  spatialWithin,
];
