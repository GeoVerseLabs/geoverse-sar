import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Geometry } from 'geojson';
import {
  bboxIntersects,
  bboxOf,
  bboxSchema,
  centerOf,
  crsRefSchema,
  featureRefSchema,
  featureSchema,
  featureSummarySchema,
  geometrySchema,
  positionSchema,
  quantitySchema,
  summarizeFeature,
  type GeoFeature,
} from '../src/index';

const toJson = (s: z.ZodType) =>
  z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' });

describe('geo-profile：派生硬门槛', () => {
  it('每个导出 schema 都可经 z.toJSONSchema 派生且 JSON 往返稳定', () => {
    const all = {
      positionSchema,
      bboxSchema,
      geometrySchema,
      featureSchema,
      featureRefSchema,
      featureSummarySchema,
      crsRefSchema,
      quantitySchema,
    };
    for (const [name, schema] of Object.entries(all)) {
      const json = toJson(schema as z.ZodType);
      expect(JSON.parse(JSON.stringify(json)), name).toEqual(json);
    }
  });

  it('positionSchema/bboxSchema/featureSummarySchema 与既有内联写法派生逐字节一致（U0-3 迁移地基）', () => {
    // capabilities-geo 迁移前的内联原文（edit.ts coordSchema / pack.ts featureSummary）
    const inlineCoord = z.tuple([z.number(), z.number()]);
    const inlineBbox = z.tuple([z.number(), z.number(), z.number(), z.number()]);
    const inlineSummary = z.object({
      id: z.string(),
      geometryType: z.string(),
      bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
      center: z.object({ x: z.number(), y: z.number() }),
      props: z.record(z.string(), z.unknown()),
    });
    expect(JSON.stringify(toJson(positionSchema))).toBe(
      JSON.stringify(toJson(inlineCoord)),
    );
    expect(JSON.stringify(toJson(bboxSchema))).toBe(JSON.stringify(toJson(inlineBbox)));
    expect(JSON.stringify(toJson(featureSummarySchema))).toBe(
      JSON.stringify(toJson(inlineSummary)),
    );
  });
});

describe('geo-profile：几何与要素 schema', () => {
  it('geometrySchema 接受六个具体类型、拒绝 GeometryCollection 与坏环', () => {
    expect(geometrySchema.safeParse({ type: 'Point', coordinates: [1, 2] }).success).toBe(
      true,
    );
    expect(
      geometrySchema.safeParse({
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      }).success,
    ).toBe(true);
    expect(
      geometrySchema.safeParse({ type: 'GeometryCollection', geometries: [] }).success,
    ).toBe(false);
    // 环少于 4 个点 → 结构性拒绝
    expect(
      geometrySchema.safeParse({
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [0, 0],
          ],
        ],
      }).success,
    ).toBe(false);
  });

  it('featureSchema 的推断输出可赋值给 GeoFeature（结构同构，无 cast）', () => {
    const parsed = featureSchema.parse({
      id: 'f1',
      geometry: { type: 'Point', coordinates: [3, 4] },
      properties: { name: '样例' },
    });
    const asGeoFeature: GeoFeature = parsed; // 编译期断言：子类型可赋值
    expect(asGeoFeature.geometry.type).toBe('Point');
  });

  it('quantitySchema：合法单位通过，未知单位结构化拒绝', () => {
    expect(quantitySchema.parse({ value: 500, unit: 'm' })).toEqual({
      value: 500,
      unit: 'm',
    });
    expect(quantitySchema.safeParse({ value: 500, unit: 'mile' }).success).toBe(false);
    expect(quantitySchema.safeParse(500).success).toBe(false);
  });
});

describe('geo-profile：纯平面工具', () => {
  const poly: Geometry = {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [4, 0],
        [4, 2],
        [0, 2],
        [0, 0],
      ],
    ],
  };

  it('bboxOf/centerOf（含 GeometryCollection 宽容读取）', () => {
    expect(bboxOf(poly)).toEqual([0, 0, 4, 2]);
    expect(centerOf(poly)).toEqual({ x: 2, y: 1 });
    const gc: Geometry = {
      type: 'GeometryCollection',
      geometries: [poly, { type: 'Point', coordinates: [10, 10] }],
    };
    expect(bboxOf(gc)).toEqual([0, 0, 10, 10]);
  });

  it('bboxIntersects：相交/相离/边界相切', () => {
    expect(bboxIntersects([0, 0, 2, 2], [1, 1, 3, 3])).toBe(true);
    expect(bboxIntersects([0, 0, 2, 2], [3, 3, 4, 4])).toBe(false);
    expect(bboxIntersects([0, 0, 2, 2], [2, 2, 4, 4])).toBe(true);
  });

  it('summarizeFeature 与 featureSummarySchema 互证（生成即合法）', () => {
    const summary = summarizeFeature({
      id: 'p1',
      geometry: poly,
      properties: { kind: 'lot' },
    });
    expect(featureSummarySchema.parse(summary)).toEqual({
      id: 'p1',
      geometryType: 'Polygon',
      bbox: [0, 0, 4, 2],
      center: { x: 2, y: 1 },
      props: { kind: 'lot' },
    });
  });
});
