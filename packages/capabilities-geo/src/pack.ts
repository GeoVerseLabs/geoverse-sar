import { z } from 'zod';
import type { Capability, CapabilityPack, Command } from '@geoverse-sar/kernel';
import type { ChangeSet, EditableFeature } from '@geoverse-sar/engine-geo';
import type { Geometry, Point } from 'geojson';
import { bboxIntersects, bboxOf, centerOf, translateGeometry } from './geometry';
import { VIEW_SERVICE_KEY, type GeoViewService } from './view-service';

type GeoCapability<I, O> = Capability<I, O, EditableFeature, ChangeSet>;
type GeoCommand = Command<EditableFeature, ChangeSet>;

let txSeq = 0;
const nextTxId = (): string => `cap-tx-${Date.now().toString(36)}-${(++txSeq).toString(36)}`;
let idSeq = 0;
const nextFeatureId = (): string =>
  `feat-${Date.now().toString(36)}-${(++idSeq).toString(36)}`;

/** LLM 友好的要素摘要（不倾倒完整坐标串）。 */
const featureSummary = z.object({
  id: z.string(),
  geometryType: z.string(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  center: z.object({ x: z.number(), y: z.number() }),
  props: z.record(z.string(), z.unknown()),
});

function summarize(f: EditableFeature) {
  return {
    id: f.id,
    geometryType: f.geometry.type,
    bbox: bboxOf(f.geometry),
    center: centerOf(f.geometry),
    props: f.properties,
  };
}

// ---- features.query ----

const queryInput = z.object({
  ids: z.array(z.string()).optional().describe('按 id 精确取；与其他条件求交'),
  propsEquals: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('属性全等匹配，如 {"type":"building"}'),
  bbox: z
    .tuple([z.number(), z.number(), z.number(), z.number()])
    .optional()
    .describe('[minX, minY, maxX, maxY] 空间范围过滤（要素 bbox 相交即命中）'),
});
const queryOutput = z.object({ features: z.array(featureSummary), count: z.number() });

const query: GeoCapability<z.infer<typeof queryInput>, z.infer<typeof queryOutput>> = {
  id: 'features.query',
  title: '查询要素',
  description:
    '按 id / 属性全等 / 空间范围（bbox）过滤查询地图要素，返回摘要（几何类型、bbox、中心点、属性）。只读；写操作前先用它确认目标。',
  category: 'query',
  kind: 'read',
  tags: ['features', 'query'],
  inputSchema: queryInput,
  outputSchema: queryOutput,
  handler: async (ctx, input) => {
    let features = ctx.state.list();
    if (input.ids) {
      const set = new Set(input.ids);
      features = features.filter((f) => set.has(f.id));
    }
    if (input.propsEquals) {
      const entries = Object.entries(input.propsEquals);
      features = features.filter((f) => entries.every(([k, v]) => f.properties[k] === v));
    }
    if (input.bbox) {
      features = features.filter((f) => bboxIntersects(bboxOf(f.geometry), input.bbox!));
    }
    return { output: { features: features.map(summarize), count: features.length } };
  },
};

// ---- features.add（点要素，LLM 友好；复杂几何走 M2 后续 edit 能力）----

const addInput = z.object({
  features: z
    .array(
      z.object({
        id: z.string().optional().describe('缺省自动生成'),
        x: z.number(),
        y: z.number(),
        props: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .min(1),
});
const addOutput = z.object({ ids: z.array(z.string()) });

const add: GeoCapability<z.infer<typeof addInput>, z.infer<typeof addOutput>> = {
  id: 'features.add',
  title: '新增点要素',
  description: '批量新增点要素（x/y 平面坐标 + 属性）。写操作、可撤销。',
  category: 'edit',
  kind: 'write',
  tags: ['features', 'write'],
  inputSchema: addInput,
  outputSchema: addOutput,
  handler: async (_ctx, input) => {
    const features: EditableFeature[] = input.features.map((f) => ({
      id: f.id ?? nextFeatureId(),
      geometry: { type: 'Point', coordinates: [f.x, f.y] } as Point,
      properties: f.props,
    }));
    const cmd: GeoCommand = {
      label: '新增要素',
      plan: (state) => {
        for (const f of features) {
          if (state.has(f.id)) throw new Error(`要素 id 已存在: ${f.id}`);
        }
        return {
          txId: nextTxId(),
          label: '新增要素',
          added: features.map((f) => structuredClone(f)),
          removed: [],
          modified: [],
        };
      },
    };
    return { output: { ids: features.map((f) => f.id) }, commands: [cmd] };
  },
};

// ---- features.translate ----

const translateInput = z.object({
  ids: z.array(z.string()).min(1),
  dx: z.number(),
  dy: z.number(),
});
const countOutput = z.object({ count: z.number() });

const translate: GeoCapability<
  z.infer<typeof translateInput>,
  z.infer<typeof countOutput>
> = {
  id: 'features.translate',
  title: '平移要素',
  description: '把一批要素几何按 (dx, dy) 平移（任意几何类型）。写操作、可撤销；id 不存在则整体失败。',
  category: 'edit',
  kind: 'write',
  tags: ['features', 'write'],
  inputSchema: translateInput,
  outputSchema: countOutput,
  handler: async (_ctx, input) => {
    const cmd: GeoCommand = {
      label: '平移要素',
      plan: (state) => ({
        txId: nextTxId(),
        label: '平移要素',
        added: [],
        removed: [],
        modified: input.ids.map((id) => {
          const f = state.get(id);
          if (!f) throw new Error(`要素不存在: ${id}`);
          return {
            id,
            before: structuredClone(f.geometry) as Geometry,
            after: translateGeometry(f.geometry, input.dx, input.dy),
          };
        }),
      }),
    };
    return { output: { count: input.ids.length }, commands: [cmd] };
  },
};

// ---- features.setProps ----

const setPropsInput = z.object({
  ids: z.array(z.string()).min(1),
  props: z.record(z.string(), z.unknown()).describe('浅合并进既有属性'),
});

const setProps: GeoCapability<
  z.infer<typeof setPropsInput>,
  z.infer<typeof countOutput>
> = {
  id: 'features.setProps',
  title: '设置属性',
  description:
    '把给定属性浅合并进一批要素（如打高亮标记）。经 ChangeSet propertyChanges 通道，写操作、可撤销。',
  category: 'edit',
  kind: 'write',
  tags: ['features', 'write'],
  inputSchema: setPropsInput,
  outputSchema: countOutput,
  handler: async (_ctx, input) => {
    const cmd: GeoCommand = {
      label: '设置属性',
      plan: (state) => ({
        txId: nextTxId(),
        label: '设置属性',
        added: [],
        removed: [],
        modified: [],
        propertyChanges: input.ids.map((id) => {
          const f = state.get(id);
          if (!f) throw new Error(`要素不存在: ${id}`);
          return {
            id,
            before: structuredClone(f.properties),
            after: { ...structuredClone(f.properties), ...input.props },
          };
        }),
      }),
    };
    return { output: { count: input.ids.length }, commands: [cmd] };
  },
};

// ---- features.remove ----

const removeInput = z.object({ ids: z.array(z.string()).min(1) });

const remove: GeoCapability<z.infer<typeof removeInput>, z.infer<typeof countOutput>> = {
  id: 'features.remove',
  title: '删除要素',
  description: '按 id 批量删除要素（removed 含完整快照，undo 可恢复）。写操作。',
  category: 'edit',
  kind: 'write',
  tags: ['features', 'write'],
  inputSchema: removeInput,
  outputSchema: countOutput,
  handler: async (_ctx, input) => {
    const cmd: GeoCommand = {
      label: '删除要素',
      plan: (state) => ({
        txId: nextTxId(),
        label: '删除要素',
        added: [],
        removed: input.ids.map((id) => {
          const f = state.get(id);
          if (!f) throw new Error(`要素不存在: ${id}`);
          return structuredClone(f);
        }),
        modified: [],
      }),
    };
    return { output: { count: input.ids.length }, commands: [cmd] };
  },
};

// ---- history / view ----

const emptyInput = z.object({});
const doneOutput = z.object({ done: z.boolean() });

const undo: GeoCapability<z.infer<typeof emptyInput>, z.infer<typeof doneOutput>> = {
  id: 'history.undo',
  title: '撤销',
  description: '撤销最近一次编辑（工作流宏撤销=一次全回退）。出错想回退时调它。',
  category: 'history',
  kind: 'action',
  tags: ['history'],
  inputSchema: emptyInput,
  outputSchema: doneOutput,
  handler: async (ctx) => ({ output: { done: ctx.engine.undo() } }),
};

const redo: GeoCapability<z.infer<typeof emptyInput>, z.infer<typeof doneOutput>> = {
  id: 'history.redo',
  title: '重做',
  description: '重做最近一次被撤销的编辑。',
  category: 'history',
  kind: 'action',
  tags: ['history'],
  inputSchema: emptyInput,
  outputSchema: doneOutput,
  handler: async (ctx) => ({ output: { done: ctx.engine.redo() } }),
};

const focusInput = z
  .object({
    ids: z.array(z.string()).optional().describe('聚焦这批要素的整体范围中心'),
    center: z.object({ x: z.number(), y: z.number() }).optional(),
  })
  .refine((v) => (v.ids?.length ?? 0) > 0 || v.center, {
    message: 'ids 与 center 至少给一个',
  });
const focusOutput = z.object({
  center: z.object({ x: z.number(), y: z.number() }),
  ids: z.array(z.string()),
});

const focus: GeoCapability<z.infer<typeof focusInput>, z.infer<typeof focusOutput>> = {
  id: 'view.focus',
  title: '视野聚焦',
  description:
    '把视野聚焦到一批要素的整体范围中心或指定点。action：有副作用但不产生 diff、不可撤销。M2 真地图接入后由 IGMap 适配实现。',
  category: 'view',
  kind: 'action',
  tags: ['view'],
  inputSchema: focusInput,
  outputSchema: focusOutput,
  handler: async (ctx, input) => {
    const view = ctx.services.require<GeoViewService>(VIEW_SERVICE_KEY);
    const ids = input.ids ?? [];
    let center = input.center;
    if (!center) {
      const found = ids
        .map((id) => ctx.state.get(id))
        .filter((f): f is EditableFeature => !!f);
      if (found.length === 0) throw new Error('聚焦目标不存在');
      const boxes = found.map((f) => bboxOf(f.geometry));
      const minX = Math.min(...boxes.map((b) => b[0]));
      const minY = Math.min(...boxes.map((b) => b[1]));
      const maxX = Math.max(...boxes.map((b) => b[2]));
      const maxY = Math.max(...boxes.map((b) => b[3]));
      center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
    }
    view.focus(center, ids);
    return { output: { center, ids } };
  },
};

// ---- view.zoom ----

const zoomInput = z
  .object({
    level: z.number().optional().describe('绝对缩放级别（与 delta 二选一）'),
    delta: z.number().optional().describe('增量，如 +1 放大一级、-2 缩小两级'),
  })
  .refine((v) => v.level !== undefined || v.delta !== undefined, {
    message: 'level 与 delta 至少给一个',
  });
const zoomOutput = z.object({ level: z.number() });

const zoom: GeoCapability<z.infer<typeof zoomInput>, z.infer<typeof zoomOutput>> = {
  id: 'view.zoom',
  title: '视野缩放',
  description:
    '按绝对级别（level）或增量（delta）缩放视野。action：不产生 diff、不可撤销；宿主视野服务未实现缩放时报错。',
  category: 'view',
  kind: 'action',
  tags: ['view'],
  inputSchema: zoomInput,
  outputSchema: zoomOutput,
  handler: async (ctx, input) => {
    const view = ctx.services.require<GeoViewService>(VIEW_SERVICE_KEY);
    if (!view.zoom) throw new Error('当前视野服务不支持缩放');
    return { output: { level: view.zoom(input) } };
  },
};

/** geo 能力包（M2 第一片：RFC-0008 capabilities-{view,query,edit} 的核心子集）。 */
export function createGeoPack(): CapabilityPack<EditableFeature, ChangeSet> {
  return {
    id: 'geo',
    capabilities: [query, add, translate, setProps, remove, undo, redo, focus, zoom],
  };
}
