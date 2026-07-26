/**
 * 几何变换组（阶段二 T7）：rotate / scale / mirror / buffer / offset。
 * 标准姿势同 edit.ts：editor-core 纯几何算子经 engine-geo 几何桥映射，
 * ChangeSet 在 SAR 命令 plan(state) 内构造（dryRun / TransactionGroup 投影态天然兼容）。
 * 平面欧氏运算（工作 CRS 内），距离/坐标单位=CRS 单位。
 */
import { z } from 'zod';
import type { Capability, Command } from '@geoverse-sar/kernel';
import {
  bufferGeometry,
  mirrorGeometry,
  offsetLine,
  rotateGeometry,
  scaleGeometry,
  type ChangeSet,
  type EditableFeature,
} from '@geoverse-sar/engine-geo';
import type { Geometry, LineString, Position } from 'geojson';
import {
  distanceSchema,
  resolveQuantity,
  type LocalUnit,
} from '@geoverse-sar/geo-profile';
import { bboxOf } from './geometry';

type GeoCapability<I, O> = Capability<I, O, EditableFeature, ChangeSet>;
type GeoCommand = Command<EditableFeature, ChangeSet>;

let txSeq = 0;
const nextTxId = (): string =>
  `xform-tx-${Date.now().toString(36)}-${(++txSeq).toString(36)}`;
let idSeq = 0;
const nextFeatureId = (): string =>
  `feat-${Date.now().toString(36)}-x${(++idSeq).toString(36)}`;

const pointSchema = z.object({ x: z.number(), y: z.number() });
const countOutput = z.object({ count: z.number() });
const idsOutput = z.object({ ids: z.array(z.string()) });

/** 所选要素集合的 bbox 中心（rotate/scale 缺省 origin）。 */
function collectiveCenter(features: EditableFeature[]): Position {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const f of features) {
    const [a, b, c, d] = bboxOf(f.geometry);
    minX = Math.min(minX, a);
    minY = Math.min(minY, b);
    maxX = Math.max(maxX, c);
    maxY = Math.max(maxY, d);
  }
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

/** rotate/scale/mirror 共用骨架：整组读出→逐个几何变换→modified ChangeSet。 */
function transformCommand(
  label: string,
  ids: string[],
  apply: (g: Geometry, all: EditableFeature[]) => Geometry,
): GeoCommand {
  return {
    label,
    plan: (state) => {
      const features = ids.map((id) => {
        const f = state.get(id);
        if (!f) throw new Error(`要素不存在: ${id}`);
        return f;
      });
      return {
        txId: nextTxId(),
        label,
        added: [],
        removed: [],
        modified: features.map((f) => ({
          id: f.id,
          before: structuredClone(f.geometry) as Geometry,
          after: apply(f.geometry, features),
        })),
      };
    },
  };
}

// ---- features.rotate ----

const rotateInput = z.object({
  ids: z.array(z.string()).min(1),
  angle: z.number().describe('旋转角度（度），逆时针为正'),
  origin: pointSchema.optional().describe('旋转中心；缺省=所选要素集合的 bbox 中心'),
});

const rotate: GeoCapability<z.infer<typeof rotateInput>, z.infer<typeof countOutput>> = {
  id: 'features.rotate',
  title: '旋转要素',
  description:
    '把一批要素绕中心点旋转指定角度（度，逆时针为正）；缺省绕所选集合的包围盒中心整体旋转。写操作、可撤销。',
  category: 'edit',
  kind: 'write',
  tags: ['features', 'write', 'transform'],
  inputSchema: rotateInput,
  outputSchema: countOutput,
  handler: async (_ctx, input) => ({
    output: { count: input.ids.length },
    commands: [
      transformCommand('旋转要素', input.ids, (g, all) =>
        rotateGeometry(
          g,
          input.angle,
          input.origin ? [input.origin.x, input.origin.y] : collectiveCenter(all),
        ),
      ),
    ],
  }),
};

// ---- features.scale ----

const scaleInput = z.object({
  ids: z.array(z.string()).min(1),
  factor: z.number().describe('缩放倍数（x 方向；2=放大一倍，0.5=缩半；不可为 0）'),
  factorY: z.number().optional().describe('y 方向倍数；缺省与 factor 相同（等比）'),
  origin: pointSchema.optional().describe('缩放中心；缺省=所选要素集合的 bbox 中心'),
});

const scale: GeoCapability<z.infer<typeof scaleInput>, z.infer<typeof countOutput>> = {
  id: 'features.scale',
  title: '缩放要素',
  description:
    '把一批要素绕中心点缩放（factor 倍；factorY 可单独指定纵向倍数）；缺省绕所选集合的包围盒中心。写操作、可撤销。',
  category: 'edit',
  kind: 'write',
  tags: ['features', 'write', 'transform'],
  inputSchema: scaleInput,
  outputSchema: countOutput,
  handler: async (_ctx, input) => {
    if (input.factor === 0 || input.factorY === 0) {
      throw new Error('缩放倍数不可为 0（会把几何压成退化点）');
    }
    return {
      output: { count: input.ids.length },
      commands: [
        transformCommand('缩放要素', input.ids, (g, all) =>
          scaleGeometry(
            g,
            input.factor,
            input.factorY ?? input.factor,
            input.origin ? [input.origin.x, input.origin.y] : collectiveCenter(all),
          ),
        ),
      ],
    };
  },
};

// ---- features.mirror ----

const mirrorInput = z.object({
  ids: z.array(z.string()).min(1),
  a: pointSchema.describe('镜像轴起点'),
  b: pointSchema.describe('镜像轴终点（与 a 不可重合）'),
});

const mirror: GeoCapability<z.infer<typeof mirrorInput>, z.infer<typeof countOutput>> = {
  id: 'features.mirror',
  title: '镜像要素',
  description:
    '把一批要素关于过 a、b 两点的直线做镜像翻转（如竖直镜像给同一 x 的两点）。写操作、可撤销。',
  category: 'edit',
  kind: 'write',
  tags: ['features', 'write', 'transform'],
  inputSchema: mirrorInput,
  outputSchema: countOutput,
  handler: async (_ctx, input) => {
    if (input.a.x === input.b.x && input.a.y === input.b.y) {
      throw new Error('镜像轴两点不可重合');
    }
    return {
      output: { count: input.ids.length },
      commands: [
        transformCommand('镜像要素', input.ids, (g) =>
          mirrorGeometry(g, [input.a.x, input.a.y], [input.b.x, input.b.y]),
        ),
      ],
    };
  },
};

// ---- features.buffer（派生新面要素，原要素保留）----

const bufferInput = z.object({
  ids: z.array(z.string()).min(1),
  distance: distanceSchema.describe(
    '缓冲距离：数字=CRS 平面单位，或 { value, unit }（unit: m/km/deg/local；m/km/deg 需宿主声明工作区单位）。正=外扩，负=内缩（仅面要素，收缩过头会报错）',
  ),
});

// ---- features.offset（线平行偏移，派生新线要素）----

const offsetInput = z.object({
  id: z.string().describe('线要素 id'),
  distance: distanceSchema.describe(
    '偏移距离：数字=CRS 平面单位，或 { value, unit }；正=沿行进方向左侧，负=右侧',
  ),
});
const idOutput = z.object({ id: z.string() });

export interface TransformCapabilityOptions {
  /**
   * 工作区平面单位（CRS 单位）声明：'m' 米制投影 / 'deg' 经纬度。
   * 声明后 Quantity 距离入参的 m/km/deg 才可换算；未声明只收裸数字与 unit:'local'
   * ——换算永不靠猜（U0-4）。
   */
  localUnit?: LocalUnit;
}

/** T7 几何变换组（U0-4 起 buffer/offset 接 Quantity 距离入参，故改工厂）。 */
export function createTransformCapabilities(options: TransformCapabilityOptions = {}) {
  const buffer: GeoCapability<z.infer<typeof bufferInput>, z.infer<typeof idsOutput>> = {
    id: 'features.buffer',
    title: '缓冲区',
    description:
      '对一批要素生成缓冲区面（点→圆、线→走廊、面→外扩/内缩），作为**新要素**加入并继承原属性，原要素保留。距离可写数字（CRS 平面单位）或 { value, unit }。写操作、可撤销。',
    category: 'edit',
    kind: 'write',
    tags: ['features', 'write', 'transform'],
    since: '2026-07-26',
    inputSchema: bufferInput,
    outputSchema: idsOutput,
    handler: async (ctx, input) => {
      const distance = resolveQuantity(input.distance, options);
      // handler 内用 ctx.state（组内即投影态）预计算——输出 ids 与 plan 的 ChangeSet 同源
      const added: EditableFeature[] = input.ids.map((id) => {
        const f = ctx.state.get(id);
        if (!f) throw new Error(`要素不存在: ${id}`);
        const g = bufferGeometry(f.geometry, distance);
        if (!g.coordinates.length) {
          throw new Error(`要素 ${id} 缓冲结果为空（内缩距离过大？）`);
        }
        return {
          id: nextFeatureId(),
          geometry: g,
          properties: structuredClone(f.properties),
        };
      });
      const cmd: GeoCommand = {
        label: '缓冲区',
        plan: (state) => {
          for (const id of input.ids) {
            if (!state.has(id)) throw new Error(`要素不存在: ${id}`);
          }
          return {
            txId: nextTxId(),
            label: '缓冲区',
            added: added.map((f) => structuredClone(f)),
            removed: [],
            modified: [],
          };
        },
      };
      return { output: { ids: added.map((f) => f.id) }, commands: [cmd] };
    },
  };

  const offset: GeoCapability<z.infer<typeof offsetInput>, z.infer<typeof idOutput>> = {
    id: 'features.offset',
    title: '平行偏移线',
    description:
      '对线要素做平行偏移（如从道路中心线生成车道线），产出**新线要素**并继承原属性，原要素保留。正距离=行进方向左侧；距离可写数字（CRS 平面单位）或 { value, unit }。写操作、可撤销。',
    category: 'edit',
    kind: 'write',
    tags: ['features', 'write', 'transform'],
    since: '2026-07-26',
    inputSchema: offsetInput,
    outputSchema: idOutput,
    handler: async (ctx, input) => {
      const distance = resolveQuantity(input.distance, options);
      const source = ctx.state.get(input.id);
      if (!source) throw new Error(`要素不存在: ${input.id}`);
      if (source.geometry.type !== 'LineString') {
        throw new Error(
          `features.offset 只支持 LineString，得到 ${source.geometry.type}`,
        );
      }
      const coords = offsetLine((source.geometry as LineString).coordinates, distance);
      const feature: EditableFeature = {
        id: nextFeatureId(),
        geometry: { type: 'LineString', coordinates: coords },
        properties: structuredClone(source.properties),
      };
      const cmd: GeoCommand = {
        label: '平行偏移线',
        plan: (state) => {
          if (!state.has(input.id)) throw new Error(`要素不存在: ${input.id}`);
          return {
            txId: nextTxId(),
            label: '平行偏移线',
            added: [structuredClone(feature)],
            removed: [],
            modified: [],
          };
        },
      };
      return { output: { id: feature.id }, commands: [cmd] };
    },
  };

  return [rotate, scale, mirror, buffer, offset];
}
