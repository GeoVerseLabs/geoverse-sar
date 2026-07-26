/**
 * @geoverse-sar/geo-profile —— 能力层共享 geo schema 底座（阶段四 U0，ADR-0015）。
 *
 * 定位：规范化的 Geometry / Feature / FeatureRef / BBox / CRS / Quantity Zod schema
 * 与纯平面 bbox 工具，供 capabilities-* 与第三方能力包在**跨包边界**复用——
 * 没有共享底座，包 A 的输出喂不进包 B 的输入（类型巴别塔）。
 *
 * 三条位置纪律（ESLint 依赖门执行）：
 * - 叶子包：运行时只依赖 zod（geojson 仅类型），不依赖 kernel / editor-core / 同仓任何包；
 * - kernel 永不 import 本包——geo 类型在 kernel **旁**不在内（红线一）；
 * - 与 editor-core 的 `EditableFeature` **同构不互引**：形状一致靠 TS 结构类型 +
 *   capabilities-geo 侧的类型级断言测试钉死（editor-core 改形状测试先红）。
 *
 * 入包硬门槛：每个导出 schema 必须可经 `z.toJSONSchema` 派生（工具规格的唯一来源）。
 */
import { z } from 'zod';
import type { Geometry, Position } from 'geojson';

// ---- 基元 ----

/** 平面坐标 [x, y]（遵守 geoverse 平面欧氏约束；与既有能力入参 coordSchema 同派生）。 */
export const positionSchema = z.tuple([z.number(), z.number()]);

/** [minX, minY, maxX, maxY]。 */
export const bboxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type Bbox = [number, number, number, number];

// ---- 几何（GeoJSON 六个具体类型；GeometryCollection 刻意不收）----
// 编辑面约定：能力入参/出参只交换具体几何；GeometryCollection 进不了拓扑算子
// 且会让每个消费方背上递归分支。bbox 工具仍支持它（读取面宽容）。

const ringSchema = z.array(positionSchema).min(4);

export const pointGeometrySchema = z.object({
  type: z.literal('Point'),
  coordinates: positionSchema,
});
export const multiPointGeometrySchema = z.object({
  type: z.literal('MultiPoint'),
  coordinates: z.array(positionSchema),
});
export const lineStringGeometrySchema = z.object({
  type: z.literal('LineString'),
  coordinates: z.array(positionSchema).min(2),
});
export const multiLineStringGeometrySchema = z.object({
  type: z.literal('MultiLineString'),
  coordinates: z.array(z.array(positionSchema).min(2)),
});
export const polygonGeometrySchema = z.object({
  type: z.literal('Polygon'),
  coordinates: z.array(ringSchema).min(1),
});
export const multiPolygonGeometrySchema = z.object({
  type: z.literal('MultiPolygon'),
  coordinates: z.array(z.array(ringSchema).min(1)),
});

/** 六个具体几何的判别联合；只做结构校验，几何有效性（自交等）归引擎/后端。 */
export const geometrySchema = z.discriminatedUnion('type', [
  pointGeometrySchema,
  multiPointGeometrySchema,
  lineStringGeometrySchema,
  multiLineStringGeometrySchema,
  polygonGeometrySchema,
  multiPolygonGeometrySchema,
]);
export type GeoGeometry = z.infer<typeof geometrySchema>;

// ---- 要素 ----

/**
 * 规范要素形状（wire/目录层）：与 editor-core 的 `EditableFeature` 同构。
 * geometry 用 GeoJSON 全量 `Geometry` 类型（含 GeometryCollection）保双向可赋值；
 * `featureSchema` 的运行时校验则收窄到六个具体类型（见上）。
 */
export interface GeoFeature {
  id: string;
  geometry: Geometry;
  properties: Record<string, unknown>;
}

export const featureSchema = z.object({
  id: z.string(),
  geometry: geometrySchema,
  properties: z.record(z.string(), z.unknown()),
});

/** 要素引用：跨能力传递"指哪个要素"的最小形状。 */
export const featureRefSchema = z.object({ id: z.string().describe('要素 id') });
export type FeatureRef = z.infer<typeof featureRefSchema>;

/** LLM 友好的要素摘要（不倾倒完整坐标串）——read 能力出参的标准形态。 */
export const featureSummarySchema = z.object({
  id: z.string(),
  geometryType: z.string(),
  bbox: bboxSchema,
  center: z.object({ x: z.number(), y: z.number() }),
  props: z.record(z.string(), z.unknown()),
});
export type FeatureSummary = z.infer<typeof featureSummarySchema>;

// ---- CRS 与量纲 ----

/** 坐标参考系引用：跨包交换数据时显式声明口径（缺省约定=工作区平面坐标）。 */
export const crsRefSchema = z.object({
  code: z
    .string()
    .describe("坐标参考系代码，如 'EPSG:4326'；工作区平面坐标用 'local-planar'"),
});
export type CrsRef = z.infer<typeof crsRefSchema>;

/**
 * 带单位量（消"缓冲 500——米还是度"一类静默错误）：距离/长度类入参
 * 用 Quantity 替代裸数字，能力在 description 写明接受的单位与换算口径。
 */
export const quantitySchema = z.object({
  value: z.number().describe('数值'),
  unit: z
    .enum(['m', 'km', 'deg', 'local'])
    .describe('单位：m 米 / km 千米 / deg 度 / local 工作区平面单位'),
});
export type Quantity = z.infer<typeof quantitySchema>;

/**
 * 距离入参的过渡形态（U0-4 采纳期）：裸数字=工作区平面单位（等价 unit:'local'，
 * 兼容既有调用方），推荐写带单位对象。新能力应直接用 quantitySchema。
 */
export const distanceSchema = z.union([
  z.number().describe("工作区平面单位的距离（等价 { value, unit: 'local' }）"),
  quantitySchema,
]);
export type DistanceInput = z.infer<typeof distanceSchema>;

/** 工作区平面单位（CRS 单位）的宿主声明：米制投影='m'，经纬度='deg'。 */
export type LocalUnit = 'm' | 'deg';

/**
 * 距离归一化：把 number|Quantity 换算成工作区平面单位的数值。
 * m/km/deg 的换算依赖宿主声明的 localUnit——未声明或不匹配时**结构化拒绝而非猜**，
 * 消掉"缓冲 500——米还是度"静默错误的另一半（schema 管形状，这里管口径）。
 */
export function resolveQuantity(
  input: number | Quantity,
  opts: { localUnit?: LocalUnit } = {},
): number {
  if (typeof input === 'number') return input;
  const { value, unit } = input;
  if (unit === 'local') return value;
  const { localUnit } = opts;
  if (unit === 'deg') {
    if (localUnit === 'deg') return value;
    throw new Error(
      localUnit === 'm'
        ? "单位 'deg' 与工作区平面单位（米）不匹配——请自行换算后改用 unit:'local' 或 'm'"
        : "宿主未声明工作区平面单位，无法解释 'deg'——请改用 unit:'local'，或由宿主声明单位",
    );
  }
  if (localUnit !== 'm') {
    throw new Error(
      localUnit === 'deg'
        ? `单位 '${unit}' 与工作区平面单位（度）不匹配——请自行换算后改用 unit:'local' 或 'deg'`
        : `宿主未声明工作区平面单位，无法解释 '${unit}'——请改用 unit:'local'，或由宿主声明单位`,
    );
  }
  return unit === 'km' ? value * 1000 : value;
}

// ---- 纯平面工具（从 capabilities-geo 收敛；零依赖，可被任何能力包复用）----

function walkPositions(g: Geometry, fn: (pos: Position) => void): void {
  if (g.type === 'GeometryCollection') {
    for (const sub of g.geometries) walkPositions(sub, fn);
    return;
  }
  const visit = (c: unknown): void => {
    if (typeof (c as Position)[0] === 'number') {
      fn(c as Position);
      return;
    }
    for (const sub of c as unknown[]) visit(sub);
  };
  visit(g.coordinates);
}

export function bboxOf(g: Geometry): Bbox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  walkPositions(g, (pos) => {
    minX = Math.min(minX, pos[0]);
    minY = Math.min(minY, pos[1]);
    maxX = Math.max(maxX, pos[0]);
    maxY = Math.max(maxY, pos[1]);
  });
  return [minX, minY, maxX, maxY];
}

export function centerOf(g: Geometry): { x: number; y: number } {
  const [minX, minY, maxX, maxY] = bboxOf(g);
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

export function bboxIntersects(a: Bbox, b: Bbox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/** 要素 → LLM 友好摘要（featureSummarySchema 的生成侧；泛型结构兼容 EditableFeature）。 */
export function summarizeFeature(f: GeoFeature): FeatureSummary {
  return {
    id: f.id,
    geometryType: f.geometry.type,
    bbox: bboxOf(f.geometry),
    center: centerOf(f.geometry),
    props: f.properties,
  };
}
