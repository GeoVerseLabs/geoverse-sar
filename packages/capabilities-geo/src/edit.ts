import { z } from 'zod';
import type { Capability, Command } from '@geoverse-sar/kernel';
import {
  mergeLines,
  splitLineAt,
  splitPolygonByLine,
  unionPolygons,
  type ChangeSet,
  type EditableFeature,
} from '@geoverse-sar/engine-geo';
import type { LineString, MultiPolygon, Polygon, Position } from 'geojson';

type GeoCapability<I, O> = Capability<I, O, EditableFeature, ChangeSet>;
type GeoCommand = Command<EditableFeature, ChangeSet>;

let txSeq = 0;
const nextTxId = (): string =>
  `edit-tx-${Date.now().toString(36)}-${(++txSeq).toString(36)}`;
let idSeq = 0;
const nextFeatureId = (): string =>
  `feat-${Date.now().toString(36)}-${(++idSeq).toString(36)}`;

const coordSchema = z.tuple([z.number(), z.number()]);

// ---- features.draw（画线 / 画面；点要素走 features.add）----

const drawInput = z.object({
  features: z
    .array(
      z.object({
        id: z.string().optional().describe('缺省自动生成'),
        type: z.enum(['LineString', 'Polygon']),
        coordinates: z
          .array(coordSchema)
          .min(2)
          .describe(
            '顶点序列 [[x,y],...]；线≥2 点，面≥3 点（外环，首尾未闭合会自动闭合）',
          ),
        props: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .min(1),
});
const idsOutput = z.object({ ids: z.array(z.string()) });

function toGeometry(
  type: 'LineString' | 'Polygon',
  coords: Position[],
): LineString | Polygon {
  if (type === 'LineString') return { type: 'LineString', coordinates: coords };
  if (coords.length < 3) throw new Error('面要素外环至少 3 个顶点');
  const ring = [...coords];
  const [fx, fy] = ring[0];
  const [lx, ly] = ring[ring.length - 1];
  if (fx !== lx || fy !== ly) ring.push([fx, fy]);
  if (ring.length < 4) throw new Error('面要素外环闭合后至少 4 个坐标');
  return { type: 'Polygon', coordinates: [ring] };
}

const draw: GeoCapability<z.infer<typeof drawInput>, z.infer<typeof idsOutput>> = {
  id: 'features.draw',
  title: '画线/画面',
  description:
    '按顶点序列批量新增线要素（LineString）或面要素（Polygon，给外环顶点即可，自动闭合）。写操作、可撤销；点要素请用 features.add。',
  category: 'edit',
  kind: 'write',
  tags: ['features', 'write', 'draw'],
  inputSchema: drawInput,
  outputSchema: idsOutput,
  handler: async (_ctx, input) => {
    const features: EditableFeature[] = input.features.map((f) => ({
      id: f.id ?? nextFeatureId(),
      geometry: toGeometry(f.type, f.coordinates),
      properties: f.props,
    }));
    const cmd: GeoCommand = {
      label: '绘制要素',
      plan: (state) => {
        for (const f of features) {
          if (state.has(f.id)) throw new Error(`要素 id 已存在: ${f.id}`);
        }
        return {
          txId: nextTxId(),
          label: '绘制要素',
          added: features.map((f) => structuredClone(f)),
          removed: [],
          modified: [],
        };
      },
    };
    return { output: { ids: features.map((f) => f.id) }, commands: [cmd] };
  },
};

// ---- features.split（线打断 1→2 / 面按线切分 1→N）----

const splitInput = z
  .object({
    id: z.string().describe('要切分的要素 id（线或面）'),
    at: z
      .object({ x: z.number(), y: z.number() })
      .optional()
      .describe('线要素：打断点（自动吸附到线上最近点；落在端点会报错）'),
    line: z
      .array(coordSchema)
      .min(2)
      .optional()
      .describe('面要素：切割线顶点序列，必须完整贯穿面的外环（一侧进另一侧出）'),
  })
  .refine((v) => v.at !== undefined || v.line !== undefined, {
    message: '线要素给 at（打断点），面要素给 line（切割线），至少一个',
  });

const split: GeoCapability<z.infer<typeof splitInput>, z.infer<typeof idsOutput>> = {
  id: 'features.split',
  title: '切分要素',
  description:
    '切分单个要素：线要素在指定点打断成两段（at）；面要素被切割线拆成多块（line，须完整贯穿外环，含洞面保持洞语义）。原要素删除、新块继承其属性。写操作、可撤销。',
  category: 'edit',
  kind: 'write',
  tags: ['features', 'write', 'split'],
  inputSchema: splitInput,
  outputSchema: idsOutput,
  handler: async (ctx, input) => {
    // 在 handler 内用 ctx.state（组内即投影态）计算切分结果——
    // 输出 ids 与 plan 的 ChangeSet 同源；plan 只复验目标仍存在。
    const source = ctx.state.get(input.id);
    if (!source) throw new Error(`要素不存在: ${input.id}`);

    let parts: (LineString | Polygon)[];
    if (source.geometry.type === 'LineString') {
      if (!input.at) throw new Error('线要素切分需要 at（打断点）');
      parts = splitLineAt(source.geometry as LineString, [input.at.x, input.at.y]);
    } else if (source.geometry.type === 'Polygon') {
      if (!input.line) throw new Error('面要素切分需要 line（切割线）');
      parts = splitPolygonByLine(source.geometry as Polygon, {
        type: 'LineString',
        coordinates: input.line,
      });
    } else {
      throw new Error(
        `features.split 只支持 LineString/Polygon，得到 ${source.geometry.type}`,
      );
    }

    const added: EditableFeature[] = parts.map((g) => ({
      id: nextFeatureId(),
      geometry: g,
      properties: structuredClone(source.properties),
    }));
    const removedSnapshot = structuredClone(source);
    const cmd: GeoCommand = {
      label: '切分要素',
      plan: (state) => {
        if (!state.has(input.id)) throw new Error(`要素不存在: ${input.id}`);
        return {
          txId: nextTxId(),
          label: '切分要素',
          added: added.map((f) => structuredClone(f)),
          removed: [structuredClone(removedSnapshot)],
          modified: [],
        };
      },
    };
    return { output: { ids: added.map((f) => f.id) }, commands: [cmd] };
  },
};

// ---- features.merge（线首尾相接合并 N→1 / 面并集 N→1）----

const mergeInput = z.object({
  ids: z
    .array(z.string())
    .min(2)
    .describe('要合并的要素 id（≥2，须同类：全为线或全为面）；线按给定顺序首尾相接'),
});
const mergeOutput = z.object({ id: z.string() });

const merge: GeoCapability<z.infer<typeof mergeInput>, z.infer<typeof mergeOutput>> = {
  id: 'features.merge',
  title: '合并要素',
  description:
    '把多个同类要素合并成一个：线要素按给定顺序首尾相接（端点须相连）；面要素求并集（自动处理共享边，可 Polygon/MultiPolygon 混合）。原要素删除、结果继承第一个要素的属性。写操作、可撤销。',
  category: 'edit',
  kind: 'write',
  tags: ['features', 'write', 'merge'],
  inputSchema: mergeInput,
  outputSchema: mergeOutput,
  handler: async (ctx, input) => {
    const sources = input.ids.map((id) => {
      const f = ctx.state.get(id);
      if (!f) throw new Error(`要素不存在: ${id}`);
      return f;
    });

    const kinds = new Set(sources.map((f) => f.geometry.type));
    let mergedGeometry: LineString | Polygon | MultiPolygon;
    if ([...kinds].every((k) => k === 'LineString')) {
      mergedGeometry = sources
        .map((f) => f.geometry as LineString)
        .reduce((acc, cur) => mergeLines(acc, cur));
    } else if ([...kinds].every((k) => k === 'Polygon' || k === 'MultiPolygon')) {
      mergedGeometry = unionPolygons(
        sources.map((f) => f.geometry as Polygon | MultiPolygon),
      );
    } else {
      throw new Error(
        `features.merge 要求同类要素（全线或全面），得到: ${[...kinds].join(', ')}`,
      );
    }

    const mergedFeature: EditableFeature = {
      id: nextFeatureId(),
      geometry: mergedGeometry,
      properties: structuredClone(sources[0].properties),
    };
    const removedSnapshots = sources.map((f) => structuredClone(f));
    const cmd: GeoCommand = {
      label: '合并要素',
      plan: (state) => {
        for (const id of input.ids) {
          if (!state.has(id)) throw new Error(`要素不存在: ${id}`);
        }
        return {
          txId: nextTxId(),
          label: '合并要素',
          added: [structuredClone(mergedFeature)],
          removed: removedSnapshots.map((f) => structuredClone(f)),
          modified: [],
        };
      },
    };
    return { output: { id: mergedFeature.id }, commands: [cmd] };
  },
};

/** M2 收尾（二）：draw/split/merge —— editor-core 几何算子的能力映射。 */
export const editCapabilities = [draw, split, merge];
