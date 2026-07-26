import { z } from 'zod';
import type {
  Capability,
  CapabilityPack,
  Command,
  NamedSetService,
} from '@geoverse-sar/kernel';
import { SETS_SERVICE_KEY } from '@geoverse-sar/kernel';
import { resolveTargetIds, targetSchema } from './target';
import {
  and,
  contains,
  eq,
  gt,
  lt,
  neq,
  oneOf,
  or,
  queryFeatures,
  range,
  type AttributePredicate,
  type ChangeSet,
  type EditableFeature,
} from '@geoverse-sar/engine-geo';
import type { Geometry, Point } from 'geojson';
import { featureSummarySchema, summarizeFeature } from '@geoverse-sar/geo-profile';
import { bboxIntersects, bboxOf, translateGeometry } from './geometry';
import { VIEW_SERVICE_KEY, type GeoViewService } from './view-service';
import { editCapabilities } from './edit';
import {
  createTransformCapabilities,
  type TransformCapabilityOptions,
} from './transform';
import { holeCapabilities } from './holes';
import { sourceCapabilities } from './source';
import { analysisCapabilities } from './analysis';

type GeoCapability<I, O> = Capability<I, O, EditableFeature, ChangeSet>;
type GeoCommand = Command<EditableFeature, ChangeSet>;

let txSeq = 0;
const nextTxId = (): string =>
  `cap-tx-${Date.now().toString(36)}-${(++txSeq).toString(36)}`;
let idSeq = 0;
const nextFeatureId = (): string =>
  `feat-${Date.now().toString(36)}-${(++idSeq).toString(36)}`;

/** LLM 友好的要素摘要（不倾倒完整坐标串）——规范形状收敛自 geo-profile（U0-3）。 */
const featureSummary = featureSummarySchema;
const summarize = summarizeFeature;

// ---- features.query ----

/** RFC-0007 谓词条件（T9 升级）：映射 editor-core eq/neq/gt/lt/range/oneOf/contains。 */
const whereCondition = z.object({
  field: z.string().describe('属性字段名'),
  op: z.enum(['eq', 'neq', 'gt', 'lt', 'range', 'oneOf', 'contains']),
  value: z.unknown().optional().describe('eq/neq/gt/lt/contains 的比较值'),
  min: z.number().optional().describe('range 下界'),
  max: z.number().optional().describe('range 上界'),
  values: z.array(z.unknown()).optional().describe('oneOf 候选值'),
});

const queryInput = z.object({
  ids: z.array(z.string()).optional().describe('按 id 精确取；与其他条件求交'),
  propsEquals: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('属性全等匹配，如 {"type":"building"}'),
  where: z
    .array(whereCondition)
    .optional()
    .describe('属性谓词条件（gt/lt/range/oneOf/contains 等），多条按 logic 组合'),
  logic: z.enum(['and', 'or']).default('and').describe('where 多条件的组合方式'),
  bbox: z
    .tuple([z.number(), z.number(), z.number(), z.number()])
    .optional()
    .describe('[minX, minY, maxX, maxY] 空间范围过滤（要素 bbox 相交即命中）'),
});

function toPredicate(c: z.infer<typeof whereCondition>): AttributePredicate {
  switch (c.op) {
    case 'eq':
      return eq(c.field, c.value);
    case 'neq':
      return neq(c.field, c.value);
    case 'gt':
      return gt(c.field, c.value as number);
    case 'lt':
      return lt(c.field, c.value as number);
    case 'range':
      if (c.min === undefined || c.max === undefined) {
        throw new Error('range 谓词需要 min 与 max');
      }
      return range(c.field, c.min, c.max);
    case 'oneOf':
      if (!c.values?.length) throw new Error('oneOf 谓词需要 values');
      return oneOf(c.field, c.values);
    case 'contains':
      return contains(c.field, String(c.value ?? ''));
  }
}
/** 句柄化回包（U3-C，RFC-0010 §五）：sample 有界，全量 id 存命名集经 setId 指代。 */
const QUERY_SAMPLE_LIMIT = 10;
const queryOutput = z.object({
  setId: z
    .string()
    .describe('命中结果的命名集句柄——写能力用 target:{setId} 指代这批要素'),
  count: z.number().describe('命中总数'),
  sample: z
    .array(featureSummary)
    .describe(`前 ${QUERY_SAMPLE_LIMIT} 条摘要（不全量倾倒坐标）`),
  hasMore: z.boolean().describe('命中数超出 sample——用 setId 指代全部'),
});

const query: GeoCapability<z.infer<typeof queryInput>, z.infer<typeof queryOutput>> = {
  id: 'features.query',
  title: '查询要素',
  description:
    '按 id / 属性全等 / 谓词条件（where：gt/lt/range/oneOf/contains 等，and/or 组合）/ 空间范围（bbox）过滤查询地图要素。' +
    '返回命名集句柄 setId + 命中总数 + 前几条摘要——**后续写操作用 target:{setId} 指代整批命中**，不必抄写 id。只读。',
  category: 'query',
  kind: 'read',
  tags: ['features', 'query'],
  since: '2026-07-27',
  requires: [SETS_SERVICE_KEY],
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
    if (input.where?.length) {
      const preds = input.where.map(toPredicate);
      const combined = input.logic === 'or' ? or(...preds) : and(...preds);
      const hit = new Set(queryFeatures(features, combined));
      features = features.filter((f) => hit.has(f.id));
    }
    if (input.bbox) {
      features = features.filter((f) => bboxIntersects(bboxOf(f.geometry), input.bbox!));
    }
    const sets = ctx.services.require<NamedSetService>(SETS_SERVICE_KEY);
    const setId = sets.save(
      features.map((f) => f.id),
      `features.query 命中 ${features.length} 条`,
    );
    const sample = features.slice(0, QUERY_SAMPLE_LIMIT).map(summarize);
    return {
      output: {
        setId,
        count: features.length,
        sample,
        hasMore: features.length > sample.length,
      },
    };
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

// U3-C target 统一寻址：ids（旧）与 target（setId/ids/filter）恰取其一
const translateInput = z.object({
  ids: z.array(z.string()).min(1).optional().describe('显式 id 列表（与 target 二选一）'),
  target: targetSchema.optional(),
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
  description:
    '把目标要素几何按 (dx, dy) 平移（任意几何类型）。目标用 ids 或 target（{setId}/{ids}/{filter}）指定。写操作、可撤销；目标不存在则整体失败。',
  category: 'edit',
  kind: 'write',
  tags: ['features', 'write'],
  since: '2026-07-27',
  inputSchema: translateInput,
  outputSchema: countOutput,
  handler: async (ctx, input) => {
    const ids = resolveTargetIds(ctx, input, 'features.translate');
    const cmd: GeoCommand = {
      label: '平移要素',
      plan: (state) => ({
        txId: nextTxId(),
        label: '平移要素',
        added: [],
        removed: [],
        modified: ids.map((id) => {
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
    return { output: { count: ids.length }, commands: [cmd] };
  },
};

// ---- features.setProps ----

const setPropsInput = z.object({
  ids: z.array(z.string()).min(1).optional().describe('显式 id 列表（与 target 二选一）'),
  target: targetSchema.optional(),
  props: z.record(z.string(), z.unknown()).describe('浅合并进既有属性'),
});

const setProps: GeoCapability<
  z.infer<typeof setPropsInput>,
  z.infer<typeof countOutput>
> = {
  id: 'features.setProps',
  title: '设置属性',
  description:
    '把给定属性浅合并进目标要素（如打高亮标记）。目标用 ids 或 target（{setId}/{ids}/{filter}）指定。经 ChangeSet propertyChanges 通道，写操作、可撤销。',
  category: 'edit',
  kind: 'write',
  tags: ['features', 'write'],
  since: '2026-07-27',
  inputSchema: setPropsInput,
  outputSchema: countOutput,
  handler: async (ctx, input) => {
    const ids = resolveTargetIds(ctx, input, 'features.setProps');
    const cmd: GeoCommand = {
      label: '设置属性',
      plan: (state) => ({
        txId: nextTxId(),
        label: '设置属性',
        added: [],
        removed: [],
        modified: [],
        propertyChanges: ids.map((id) => {
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
    return { output: { count: ids.length }, commands: [cmd] };
  },
};

// ---- features.remove ----

const removeInput = z.object({
  ids: z.array(z.string()).min(1).optional().describe('显式 id 列表（与 target 二选一）'),
  target: targetSchema.optional(),
});

const remove: GeoCapability<z.infer<typeof removeInput>, z.infer<typeof countOutput>> = {
  id: 'features.remove',
  title: '删除要素',
  description:
    '批量删除目标要素（removed 含完整快照，undo 可恢复）。目标用 ids 或 target（{setId}/{ids}/{filter}）指定。写操作。',
  category: 'edit',
  kind: 'write',
  tags: ['features', 'write'],
  since: '2026-07-27',
  inputSchema: removeInput,
  outputSchema: countOutput,
  handler: async (ctx, input) => {
    const ids = resolveTargetIds(ctx, input, 'features.remove');
    const cmd: GeoCommand = {
      label: '删除要素',
      plan: (state) => ({
        txId: nextTxId(),
        label: '删除要素',
        added: [],
        removed: ids.map((id) => {
          const f = state.get(id);
          if (!f) throw new Error(`要素不存在: ${id}`);
          return structuredClone(f);
        }),
        modified: [],
      }),
    };
    return { output: { count: ids.length }, commands: [cmd] };
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
  description: '重做最近一次被撤销的编辑（undo 的反向）；新编辑会清空重做栈。',
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
    target: targetSchema.optional(),
    center: z.object({ x: z.number(), y: z.number() }).optional(),
  })
  .refine((v) => (v.ids?.length ?? 0) > 0 || v.target || v.center, {
    message: 'ids / target / center 至少给一个',
  });
const focusOutput = z.object({
  center: z.object({ x: z.number(), y: z.number() }),
  ids: z.array(z.string()),
});

const focus: GeoCapability<z.infer<typeof focusInput>, z.infer<typeof focusOutput>> = {
  id: 'view.focus',
  title: '视野聚焦',
  description:
    '把视野聚焦到一批要素（ids 或 target:{setId}/{ids}/{filter}）的整体范围中心，或指定点。action：有副作用但不产生 diff、不可撤销。',
  category: 'view',
  kind: 'action',
  tags: ['view'],
  since: '2026-07-27',
  inputSchema: focusInput,
  outputSchema: focusOutput,
  handler: async (ctx, input) => {
    const view = ctx.services.require<GeoViewService>(VIEW_SERVICE_KEY);
    const ids =
      input.ids ??
      (input.target ? resolveTargetIds(ctx, { target: input.target }, 'view.focus') : []);
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

// ---- view.setBase ----

const setBaseInput = z.object({
  name: z
    .string()
    .describe(
      '底图名（宿主定义）；GMap 常见值：gd-vec 高德矢量 / gd-sat 高德影像 / bd-vec 百度矢量 / bd-sat 百度影像 / ocean 海图。名字不合法会报错并列出可用值。',
    ),
});
const setBaseOutput = z.object({ base: z.string() });

const setBase: GeoCapability<
  z.infer<typeof setBaseInput>,
  z.infer<typeof setBaseOutput>
> = {
  id: 'view.setBase',
  title: '切换底图',
  description:
    '切换地图底图（如矢量图↔卫星影像）。action：不产生 diff、不可撤销；宿主视野服务未实现底图切换时报错。',
  category: 'view',
  kind: 'action',
  tags: ['view'],
  requires: [VIEW_SERVICE_KEY],
  inputSchema: setBaseInput,
  outputSchema: setBaseOutput,
  handler: async (ctx, input) => {
    const view = ctx.services.require<GeoViewService>(VIEW_SERVICE_KEY);
    if (!view.setBase) throw new Error('当前视野服务不支持底图切换');
    return { output: { base: view.setBase(input.name) } };
  },
};

export interface CreateGeoPackOptions extends TransformCapabilityOptions {
  /**
   * 数据源能力组（U3-B）：source.list/checkout/commit。缺省 false——它们 requires
   * 数据面服务（runtime.resources）与同步桥（geo.sync），无此二者的宿主开了只会
   * 收获 doctor error 与 service_missing。宿主接好数据面后显式开启。
   */
  source?: boolean;
}

/** geo 能力包（M2：RFC-0008 capabilities-{view,query,edit}——含 draw/split/merge 映射）。 */
export function createGeoPack(
  options: CreateGeoPackOptions = {},
): CapabilityPack<EditableFeature, ChangeSet> {
  return {
    id: 'geo',
    capabilities: [
      query,
      add,
      ...editCapabilities,
      ...createTransformCapabilities(options),
      ...holeCapabilities,
      ...(options.source ? sourceCapabilities : []),
      ...analysisCapabilities,
      translate,
      setProps,
      remove,
      undo,
      redo,
      focus,
      zoom,
      setBase,
    ],
  };
}
