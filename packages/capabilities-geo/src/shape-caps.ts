/**
 * 参数化形状能力（阶段四 U3-D）：矩形/圆——复用 editor-core shapes（经 engine-geo 桥），
 * 产物是带 SHAPE_PROPERTY 标记的普通多边形要素（宿主编辑器可据标记走专用手柄）。
 * 圆半径接 Quantity（U0-4 同一口径：m/km/deg 需宿主声明 localUnit，不猜）。
 */
import { z } from 'zod';
import type { Capability } from '@geoverse-sar/kernel';
import {
  circlePolygon,
  DEFAULT_CIRCLE_SEGMENTS,
  rectPolygon,
  SHAPE_PROPERTY,
  type ChangeSet,
  type EditableFeature,
} from '@geoverse-sar/engine-geo';
import {
  distanceSchema,
  positionSchema,
  resolveQuantity,
} from '@geoverse-sar/geo-profile';
import type { TransformCapabilityOptions } from './transform';

type GeoCapability<I, O> = Capability<I, O, EditableFeature, ChangeSet>;

let txSeq = 0;
const nextTxId = (): string =>
  `shape-tx-${Date.now().toString(36)}-${(++txSeq).toString(36)}`;
let idSeq = 0;
const nextFeatureId = (): string =>
  `feat-${Date.now().toString(36)}-s${(++idSeq).toString(36)}`;

const idOutput = z.object({ id: z.string() });

const rectInput = z.object({
  a: positionSchema.describe('矩形一角 [x, y]'),
  b: positionSchema.describe('对角 [x, y]（与 a 不可同点）'),
  props: z.record(z.string(), z.unknown()).default({}),
});

const circleInput = z.object({
  center: positionSchema.describe('圆心 [x, y]'),
  radius: distanceSchema.describe(
    '半径：数字=CRS 平面单位，或 { value, unit }（m/km/deg 需宿主声明工作区单位）',
  ),
  segments: z
    .number()
    .int()
    .min(8)
    .max(256)
    .default(DEFAULT_CIRCLE_SEGMENTS)
    .describe('圆的边数近似（缺省与宿主编辑器一致）'),
  props: z.record(z.string(), z.unknown()).default({}),
});

export function createShapeCapabilities(options: TransformCapabilityOptions = {}) {
  const drawRect: GeoCapability<z.infer<typeof rectInput>, z.infer<typeof idOutput>> = {
    id: 'features.drawRect',
    title: '画矩形',
    description:
      '按两个对角点新增矩形面要素（带形状标记，宿主编辑器可用专用手柄保形编辑）。写操作、可撤销。',
    category: 'edit',
    kind: 'write',
    tags: ['features', 'write', 'shape'],
    since: '2026-07-27',
    inputSchema: rectInput,
    outputSchema: idOutput,
    handler: async (_ctx, input) => {
      if (input.a[0] === input.b[0] || input.a[1] === input.b[1]) {
        throw new Error('矩形两角不可共线（宽或高为 0）');
      }
      const feature: EditableFeature = {
        id: nextFeatureId(),
        geometry: rectPolygon(input.a, input.b),
        properties: { ...input.props, [SHAPE_PROPERTY]: 'rect' },
      };
      return {
        output: { id: feature.id },
        commands: [
          {
            label: '画矩形',
            plan: (state) => {
              if (state.has(feature.id)) throw new Error(`要素已存在: ${feature.id}`);
              return {
                txId: nextTxId(),
                label: '画矩形',
                added: [structuredClone(feature)],
                removed: [],
                modified: [],
              };
            },
          },
        ],
      };
    },
  };

  const drawCircle: GeoCapability<
    z.infer<typeof circleInput>,
    z.infer<typeof idOutput>
  > = {
    id: 'features.drawCircle',
    title: '画圆',
    description:
      '按圆心与半径新增圆面要素（多边形近似，带形状标记；半径可写数字或 { value, unit }）。写操作、可撤销。',
    category: 'edit',
    kind: 'write',
    tags: ['features', 'write', 'shape'],
    since: '2026-07-27',
    inputSchema: circleInput,
    outputSchema: idOutput,
    handler: async (_ctx, input) => {
      const radius = resolveQuantity(input.radius, options);
      if (radius <= 0) throw new Error('半径必须为正数');
      const feature: EditableFeature = {
        id: nextFeatureId(),
        geometry: circlePolygon(input.center, radius, input.segments),
        properties: { ...input.props, [SHAPE_PROPERTY]: 'circle' },
      };
      return {
        output: { id: feature.id },
        commands: [
          {
            label: '画圆',
            plan: (state) => {
              if (state.has(feature.id)) throw new Error(`要素已存在: ${feature.id}`);
              return {
                txId: nextTxId(),
                label: '画圆',
                added: [structuredClone(feature)],
                removed: [],
                modified: [],
              };
            },
          },
        ],
      };
    },
  };

  return [drawRect, drawCircle];
}
