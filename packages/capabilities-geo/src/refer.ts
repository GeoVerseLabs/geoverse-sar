/**
 * 指代解析能力族（阶段四 U3-D，RFC-0010 §五）：让 LLM 用**组合引用**指代空间对象——
 * 「当前视野」→ bbox、「选中的」→ 命名集、「圈出来的范围」→ 命名集。
 * region.select 复用 editor-core regionSelect 纯命中（经 engine-geo 桥）；
 * 选择集/视野挂宿主视图服务（GeoViewService 可选方法，未实现如实报错）。
 */
import { z } from 'zod';
import type { Capability, NamedSetService } from '@geoverse-sar/kernel';
import { SETS_SERVICE_KEY } from '@geoverse-sar/kernel';
import {
  featureIdsInRegion,
  type ChangeSet,
  type EditableFeature,
  type RegionPredicate,
} from '@geoverse-sar/engine-geo';
import { bboxSchema, positionSchema } from '@geoverse-sar/geo-profile';
import { VIEW_SERVICE_KEY, type GeoViewService } from './view-service';

type GeoCapability<I, O> = Capability<I, O, EditableFeature, ChangeSet>;

// ---- view.bbox：「当前视野」→ bbox ----

const viewBboxInput = z.object({});
const viewBboxOutput = z.object({
  bbox: bboxSchema.describe('当前视野范围 [minX, minY, maxX, maxY]'),
});

const viewBbox: GeoCapability<
  z.infer<typeof viewBboxInput>,
  z.infer<typeof viewBboxOutput>
> = {
  id: 'view.bbox',
  title: '当前视野范围',
  description:
    '取当前地图视野的空间范围 bbox——把"当前视野内"翻译成可用于 features.query/source.query 的 bbox 条件。只读。',
  category: 'view',
  kind: 'read',
  tags: ['view', 'refer'],
  since: '2026-07-27',
  requires: [VIEW_SERVICE_KEY],
  inputSchema: viewBboxInput,
  outputSchema: viewBboxOutput,
  handler: async (ctx) => {
    const view = ctx.services.require<GeoViewService>(VIEW_SERVICE_KEY);
    const bbox = view.getViewport?.();
    if (!bbox)
      throw new Error('当前视野服务未提供视野范围（getViewport 未实现或视图未就绪）');
    return { output: { bbox } };
  },
};

// ---- selection.get：「选中的」→ 命名集 ----

const selectionInput = z.object({});
const selectionOutput = z.object({
  setId: z.string().describe('选择集的命名集句柄——写能力用 target:{setId} 指代'),
  count: z.number(),
  ids: z.array(z.string()).describe('选中要素 id（选择集通常很小，直接给全量）'),
});

const selectionGet: GeoCapability<
  z.infer<typeof selectionInput>,
  z.infer<typeof selectionOutput>
> = {
  id: 'selection.get',
  title: '取当前选择集',
  description:
    '取用户当前在地图上选中的要素，存成命名集句柄——把"选中的这些"翻译成 target:{setId}。只读；无选择时报错提示先选择。',
  category: 'query',
  kind: 'read',
  tags: ['selection', 'refer'],
  since: '2026-07-27',
  requires: [VIEW_SERVICE_KEY],
  inputSchema: selectionInput,
  outputSchema: selectionOutput,
  handler: async (ctx) => {
    const view = ctx.services.require<GeoViewService>(VIEW_SERVICE_KEY);
    if (!view.getSelection) throw new Error('当前宿主未接选择集（getSelection 未实现）');
    const ids = view.getSelection();
    if (ids.length === 0) throw new Error('当前没有选中的要素——请先在地图上选择');
    const sets = ctx.services.require<NamedSetService>(SETS_SERVICE_KEY);
    const setId = sets.save(ids, `selection.get 选中 ${ids.length} 条`);
    return { output: { setId, count: ids.length, ids } };
  },
};

// ---- region.select：「这个范围里的」→ 命名集 ----

const regionInput = z.object({
  ring: z
    .array(positionSchema)
    .min(3)
    .describe('区域外环顶点序列（自动闭合）；矩形给四角即可'),
  predicate: z
    .enum(['intersects', 'contains'])
    .default('intersects')
    .describe('命中判定：intersects=相交即中 / contains=完全落入才中'),
});
const regionOutput = z.object({
  setId: z.string().describe('命中要素的命名集句柄'),
  count: z.number(),
  sample: z.array(z.string()).describe('前 10 个命中 id'),
});

const regionSelect: GeoCapability<
  z.infer<typeof regionInput>,
  z.infer<typeof regionOutput>
> = {
  id: 'region.select',
  title: '按区域选择要素',
  description:
    '用一圈顶点划定区域，选出相交/被包含的要素并存成命名集句柄（复用 editor-core 框选/套索的同一命中逻辑）。只读。',
  category: 'query',
  kind: 'read',
  tags: ['region', 'refer', 'query'],
  since: '2026-07-27',
  inputSchema: regionInput,
  outputSchema: regionOutput,
  handler: async (ctx, input) => {
    const ids = featureIdsInRegion(ctx.state.list(), input.ring, {
      predicate: input.predicate as RegionPredicate,
    });
    const sets = ctx.services.require<NamedSetService>(SETS_SERVICE_KEY);
    const setId = sets.save(ids, `region.select 命中 ${ids.length} 条`);
    return { output: { setId, count: ids.length, sample: ids.slice(0, 10) } };
  },
};

// ---- view.snapGuide：对齐辅助线开关 ----

const snapGuideInput = z.object({ on: z.boolean().describe('开/关对齐辅助线') });
const snapGuideOutput = z.object({ on: z.boolean() });

const snapGuide: GeoCapability<
  z.infer<typeof snapGuideInput>,
  z.infer<typeof snapGuideOutput>
> = {
  id: 'view.snapGuide',
  title: '对齐辅助线开关',
  description:
    '开或关编辑时的对齐辅助线（snap guide）。纯 UI 面 action：不产生 diff、不可撤销；宿主未实现时报错。',
  category: 'view',
  kind: 'action',
  tags: ['view', 'snap'],
  since: '2026-07-27',
  requires: [VIEW_SERVICE_KEY],
  inputSchema: snapGuideInput,
  outputSchema: snapGuideOutput,
  handler: async (ctx, input) => {
    const view = ctx.services.require<GeoViewService>(VIEW_SERVICE_KEY);
    if (!view.setSnapGuide) throw new Error('当前宿主不支持对齐辅助线开关');
    return { output: { on: view.setSnapGuide(input.on) } };
  },
};

/** 指代解析 + 视图开关（挂视图服务的成员在无 view 宿主上经 requires 报 service_missing）。 */
export const referCapabilities = [viewBbox, selectionGet, regionSelect, snapGuide];
