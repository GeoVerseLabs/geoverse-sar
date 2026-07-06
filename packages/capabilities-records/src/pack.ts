import { z } from 'zod';
import type { Capability, CapabilityPack } from '@geoverse-sar/kernel';
import type { RecordDiff, RecordEntity } from '@geoverse-sar/engine-memory';
import {
  AddRecordsCommand,
  RemoveRecordsCommand,
  SetPropsCommand,
  TranslateRecordsCommand,
} from './commands';
import { VIEW_SERVICE_KEY, type ViewService } from './view-service';

type RecCapability<I, O> = Capability<I, O, RecordEntity, RecordDiff>;

const recordSchema = z.object({
  id: z.string(),
  x: z.number(),
  y: z.number(),
  props: z.record(z.string(), z.unknown()),
});

// ---- records.query ----

const queryInput = z.object({
  ids: z.array(z.string()).optional().describe('按 id 精确取；与其他条件求交'),
  propsEquals: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('属性全等匹配，如 {"type":"poi"}'),
  bbox: z
    .tuple([z.number(), z.number(), z.number(), z.number()])
    .optional()
    .describe('[minX, minY, maxX, maxY] 空间范围过滤'),
});
const queryOutput = z.object({
  records: z.array(recordSchema),
  count: z.number(),
});

const query: RecCapability<z.infer<typeof queryInput>, z.infer<typeof queryOutput>> = {
  id: 'records.query',
  title: '查询记录',
  description:
    '按 id / 属性全等 / 空间范围（bbox）过滤查询点记录。只读、无副作用；写操作前先用它确认目标记录。',
  category: 'records',
  kind: 'read',
  tags: ['records', 'query'],
  inputSchema: queryInput,
  outputSchema: queryOutput,
  handler: async (ctx, input) => {
    let records = ctx.state.list();
    if (input.ids) {
      const set = new Set(input.ids);
      records = records.filter((r) => set.has(r.id));
    }
    if (input.propsEquals) {
      const entries = Object.entries(input.propsEquals);
      records = records.filter((r) => entries.every(([k, v]) => r.props[k] === v));
    }
    if (input.bbox) {
      const [minX, minY, maxX, maxY] = input.bbox;
      records = records.filter(
        (r) => r.x >= minX && r.x <= maxX && r.y >= minY && r.y <= maxY,
      );
    }
    return { output: { records, count: records.length } };
  },
};

// ---- records.add ----

let idSeq = 0;
const nextId = (): string => `rec-${Date.now().toString(36)}-${(++idSeq).toString(36)}`;

const addInput = z.object({
  records: z
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

const add: RecCapability<z.infer<typeof addInput>, z.infer<typeof addOutput>> = {
  id: 'records.add',
  title: '新增记录',
  description: '批量新增点记录（id 缺省自动生成）。写操作、可撤销。',
  category: 'records',
  kind: 'write',
  tags: ['records', 'write'],
  inputSchema: addInput,
  outputSchema: addOutput,
  handler: async (_ctx, input) => {
    const records: RecordEntity[] = input.records.map((r) => ({
      id: r.id ?? nextId(),
      x: r.x,
      y: r.y,
      props: r.props,
    }));
    return {
      output: { ids: records.map((r) => r.id) },
      commands: [new AddRecordsCommand(records)],
    };
  },
};

// ---- records.translate ----

const translateInput = z.object({
  ids: z.array(z.string()).min(1),
  dx: z.number(),
  dy: z.number(),
});
const countOutput = z.object({ count: z.number() });

const translate: RecCapability<
  z.infer<typeof translateInput>,
  z.infer<typeof countOutput>
> = {
  id: 'records.translate',
  title: '平移记录',
  description: '把一批记录按 (dx, dy) 平移。写操作、可撤销；id 不存在则整体失败。',
  category: 'records',
  kind: 'write',
  tags: ['records', 'write'],
  inputSchema: translateInput,
  outputSchema: countOutput,
  handler: async (_ctx, input) => ({
    output: { count: input.ids.length },
    commands: [new TranslateRecordsCommand(input.ids, input.dx, input.dy)],
  }),
};

// ---- records.setProps ----

const setPropsInput = z.object({
  ids: z.array(z.string()).min(1),
  props: z.record(z.string(), z.unknown()).describe('浅合并进既有 props'),
});

const setProps: RecCapability<
  z.infer<typeof setPropsInput>,
  z.infer<typeof countOutput>
> = {
  id: 'records.setProps',
  title: '设置属性',
  description: '把给定属性浅合并进一批记录的 props（如打高亮标记）。写操作、可撤销。',
  category: 'records',
  kind: 'write',
  tags: ['records', 'write'],
  inputSchema: setPropsInput,
  outputSchema: countOutput,
  handler: async (_ctx, input) => ({
    output: { count: input.ids.length },
    commands: [new SetPropsCommand(input.ids, input.props)],
  }),
};

// ---- records.remove ----

const removeInput = z.object({ ids: z.array(z.string()).min(1) });

const remove: RecCapability<z.infer<typeof removeInput>, z.infer<typeof countOutput>> = {
  id: 'records.remove',
  title: '删除记录',
  description: '按 id 批量删除记录。写操作、可撤销（undo 可恢复）。',
  category: 'records',
  kind: 'write',
  tags: ['records', 'write'],
  inputSchema: removeInput,
  outputSchema: countOutput,
  handler: async (_ctx, input) => ({
    output: { count: input.ids.length },
    commands: [new RemoveRecordsCommand(input.ids)],
  }),
};

// ---- history.undo / history.redo ----

const emptyInput = z.object({});
const doneOutput = z.object({ done: z.boolean() });

const undo: RecCapability<z.infer<typeof emptyInput>, z.infer<typeof doneOutput>> = {
  id: 'history.undo',
  title: '撤销',
  description: '撤销最近一次写操作（工作流宏撤销=一次全回退）。出错想回退时调它。',
  category: 'history',
  kind: 'action',
  tags: ['history'],
  inputSchema: emptyInput,
  outputSchema: doneOutput,
  handler: async (ctx) => ({ output: { done: ctx.engine.undo() } }),
};

const redo: RecCapability<z.infer<typeof emptyInput>, z.infer<typeof doneOutput>> = {
  id: 'history.redo',
  title: '重做',
  description: '重做最近一次被撤销的写操作（undo 的反向）；新写操作会清空重做栈。',
  category: 'history',
  kind: 'action',
  tags: ['history'],
  inputSchema: emptyInput,
  outputSchema: doneOutput,
  handler: async (ctx) => ({ output: { done: ctx.engine.redo() } }),
};

// ---- view.focus ----

const focusInput = z
  .object({
    ids: z.array(z.string()).optional().describe('聚焦这批记录的质心'),
    center: z.object({ x: z.number(), y: z.number() }).optional().describe('直接给中心点'),
  })
  .refine((v) => (v.ids?.length ?? 0) > 0 || v.center, {
    message: 'ids 与 center 至少给一个',
  });
const focusOutput = z.object({
  center: z.object({ x: z.number(), y: z.number() }),
  ids: z.array(z.string()),
});

const focus: RecCapability<z.infer<typeof focusInput>, z.infer<typeof focusOutput>> = {
  id: 'view.focus',
  title: '视野聚焦',
  description:
    '把"视野"聚焦到一批记录的质心或指定中心点。action：有副作用但不产生 diff、不可撤销。',
  category: 'view',
  kind: 'action',
  tags: ['view'],
  inputSchema: focusInput,
  outputSchema: focusOutput,
  handler: async (ctx, input) => {
    const view = ctx.services.require<ViewService>(VIEW_SERVICE_KEY);
    const ids = input.ids ?? [];
    let center = input.center;
    if (!center) {
      const found = ids
        .map((id) => ctx.state.get(id))
        .filter((r): r is RecordEntity => !!r);
      if (found.length === 0) throw new Error('聚焦目标不存在');
      center = {
        x: found.reduce((s, r) => s + r.x, 0) / found.length,
        y: found.reduce((s, r) => s + r.y, 0) / found.length,
      };
    }
    view.focus(center, ids);
    return { output: { center, ids } };
  },
};

/** 记录域能力包：5 记录能力 + 2 历史 + 1 视野（RFC-0008 §4.2 的"5+2"，另含 remove）。 */
export function createRecordsPack(): CapabilityPack<RecordEntity, RecordDiff> {
  return {
    id: 'records',
    capabilities: [query, add, translate, setProps, remove, undo, redo, focus],
  };
}
