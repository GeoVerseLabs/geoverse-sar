/**
 * 数据源能力组（阶段四 U3-B，RFC-0010 §四）：checkout / commit——
 * 把「Live 平台 useEditSession 的手动内联流程」能力化进单漏斗：
 * - source.list / source.checkout 经 kernel 数据面服务（runtime.resources）取数；
 * - checkout 的写入走正常 diff（可撤销、进 journal）——检出集有上限，
 *   远程分页世界不进 undo 世界（防呆）；
 * - source.commit 委托 engine-geo 的同步收编桥（editor-core SyncClient：
 *   乐观锁 baseVersions + 409 三路合并 rebase）——effects 声明 external write +
 *   强制审批 + keyed 幂等；合并/锁语义全在 editor-core，这里只做结构化上抛。
 */
import { z } from 'zod';
import type { Capability, ResourcePort } from '@geoverse-sar/kernel';
import { RESOURCES_SERVICE_KEY } from '@geoverse-sar/kernel';
import {
  GEO_SYNC_SERVICE_KEY,
  type ChangeSet,
  type CommitOutcome,
  type EditableFeature,
  type SyncBridge,
  type ThreeWayMergeResult,
} from '@geoverse-sar/engine-geo';
import {
  bboxSchema,
  featureSchema,
  resourceMetaGeoSchema,
} from '@geoverse-sar/geo-profile';

type GeoCapability<I, O> = Capability<I, O, EditableFeature, ChangeSet>;

let txSeq = 0;
const nextTxId = (): string =>
  `src-tx-${Date.now().toString(36)}-${(++txSeq).toString(36)}`;

/** 检出上限（防呆）：更大的世界请留在数据面里查询，不要塞进 undo 世界。 */
export const CHECKOUT_LIMIT = 500;

// ---- source.list ----

const listInput = z.object({});
const listOutput = z.object({
  sources: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      description: z.string().optional(),
      countHint: z.number().optional().describe('数量级提示（估算）'),
      crs: z.string().optional().describe('数据源坐标参考系（geo 剖面）'),
    }),
  ),
});

const list: GeoCapability<z.infer<typeof listInput>, z.infer<typeof listOutput>> = {
  id: 'source.list',
  title: '列出数据源',
  description:
    '列出宿主接入的只读数据源（数据库表/要素服务等）及其数量级与坐标系提示。检出编辑或查询之前先调它。只读。',
  category: 'source',
  kind: 'read',
  tags: ['source', 'resource'],
  since: '2026-07-27',
  requires: [RESOURCES_SERVICE_KEY],
  inputSchema: listInput,
  outputSchema: listOutput,
  handler: async (ctx) => {
    const port = ctx.services.require<ResourcePort>(RESOURCES_SERVICE_KEY);
    const descriptors = await port.list();
    return {
      output: {
        sources: descriptors.map((d) => {
          const geoMeta = resourceMetaGeoSchema.safeParse(d.meta ?? {});
          return {
            id: d.id,
            title: d.title,
            ...(d.description ? { description: d.description } : {}),
            ...(d.countHint !== undefined ? { countHint: d.countHint } : {}),
            ...(geoMeta.success && geoMeta.data.crs ? { crs: geoMeta.data.crs } : {}),
          };
        }),
      },
    };
  },
};

// ---- source.checkout ----

const checkoutInput = z.object({
  resource: z.string().describe('数据源 id（source.list 可见）'),
  filter: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('属性等值过滤（按数据源语义）'),
  bbox: bboxSchema.optional().describe('空间范围过滤 [minX, minY, maxX, maxY]'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(CHECKOUT_LIMIT)
    .default(100)
    .describe(`检出条数上限（硬上限 ${CHECKOUT_LIMIT}——编辑集应远小于数据源）`),
});
const checkoutOutput = z.object({
  ids: z.array(z.string()),
  count: z.number(),
  hasMore: z
    .boolean()
    .optional()
    .describe('数据源里还有更多命中未检出（收窄条件或分批）'),
});

const checkout: GeoCapability<
  z.infer<typeof checkoutInput>,
  z.infer<typeof checkoutOutput>
> = {
  id: 'source.checkout',
  title: '检出要素到编辑区',
  description:
    '从只读数据源查询一批要素并检出到当前编辑区（作为可撤销的新增写入，属性带 _source 溯源）。' +
    '检出后即可用全部编辑能力修改，改完用 source.commit 提交回数据源。' +
    'id 已存在于编辑区的要素会整体拒绝（先查后改）。写操作、可撤销。',
  category: 'source',
  kind: 'write',
  tags: ['source', 'checkout', 'write'],
  since: '2026-07-27',
  requires: [RESOURCES_SERVICE_KEY],
  inputSchema: checkoutInput,
  outputSchema: checkoutOutput,
  handler: async (ctx, input) => {
    const port = ctx.services.require<ResourcePort>(RESOURCES_SERVICE_KEY);
    const result = await port.query(input.resource, {
      filter: input.filter,
      page: { offset: 0, limit: input.limit },
      ...(input.bbox ? { ext: { bbox: input.bbox } } : {}),
    });

    const added: EditableFeature[] = result.items.map((item, i) => {
      const parsed = featureSchema.safeParse(item);
      if (!parsed.success) {
        throw new Error(
          `数据源条目 #${i} 不是合法要素（featureSchema 拒绝）：${parsed.error.issues[0]?.message ?? ''}`,
        );
      }
      const f = parsed.data;
      // 乐观锁基线：数据源若带 version 一并保留（提交时 baseVersions 用）
      const version = (item as { version?: unknown }).version;
      return {
        id: f.id,
        geometry: f.geometry,
        properties: { ...f.properties, _source: input.resource },
        ...(typeof version === 'number' ? { version } : {}),
      };
    });

    const conflicts = added.filter((f) => ctx.state.has(f.id)).map((f) => f.id);
    if (conflicts.length > 0) {
      throw new Error(
        `检出冲突：编辑区已存在同 id 要素 ${conflicts.join(', ')}——先处理（提交/删除）再检出`,
      );
    }

    return {
      output: {
        ids: added.map((f) => f.id),
        count: added.length,
        ...(result.hasMore !== undefined ? { hasMore: result.hasMore } : {}),
      },
      commands: [
        {
          label: '检出要素',
          plan: (state) => {
            for (const f of added) {
              if (state.has(f.id)) throw new Error(`检出冲突：要素已存在 ${f.id}`);
            }
            return {
              txId: nextTxId(),
              label: '检出要素',
              added: added.map((f) => structuredClone(f)),
              removed: [],
              modified: [],
            };
          },
        },
      ],
    };
  },
};

// ---- source.commit ----

const commitInput = z.object({});
const mergeSummary = z.object({
  localWins: z.array(z.string()).describe('保留本地编辑并 rebase 重提交的要素'),
  remoteWins: z.array(z.string()).describe('采纳服务端版本的要素（本地编辑被覆盖）'),
  diverged: z.array(z.string()).describe('双方真分歧、由裁决策略定夺的要素'),
});
const commitOutput = z.object({
  status: z.enum(['noop', 'committed', 'conflict']),
  affected: z.number().optional().describe('提交生效的要素数'),
  newIds: z
    .record(z.string(), z.string())
    .optional()
    .describe('临时 id → 服务端真实 id（新增要素的改名表）'),
  issues: z.array(z.string()).optional().describe('服务端校验意见'),
  conflictIds: z.array(z.string()).optional().describe('冲突要素（未配三路合并时）'),
  merge: mergeSummary.optional().describe('三路合并裁决明细（经历过 409 时）'),
});

function summarizeMerge(m: ThreeWayMergeResult | undefined) {
  if (!m) return {};
  return {
    merge: {
      localWins: m.localWins.map((e) => e.id),
      remoteWins: m.remoteWins.map((e) => e.id),
      diverged: m.diverged.map((e) => e.id),
    },
  };
}

function toCommitOutput(outcome: CommitOutcome): z.infer<typeof commitOutput> {
  if (outcome.status === 'noop') return { status: 'noop' };
  if (outcome.status === 'committed') {
    const newIds = Object.fromEntries(
      Object.entries(outcome.idMap).filter(([tmp, real]) => tmp !== real),
    );
    return {
      status: 'committed',
      affected: Object.keys(outcome.versions).length,
      ...(Object.keys(newIds).length ? { newIds } : {}),
      ...(outcome.issues.length
        ? { issues: outcome.issues.map((i) => String(i.message ?? i)) }
        : {}),
      ...summarizeMerge(outcome.merge),
    };
  }
  return {
    status: 'conflict',
    conflictIds: outcome.conflicts.map((f) => f.id),
    ...summarizeMerge(outcome.merge),
  };
}

const commit: GeoCapability<z.infer<typeof commitInput>, z.infer<typeof commitOutput>> = {
  id: 'source.commit',
  title: '提交回数据源',
  description:
    '把编辑区累积的全部未提交变更打包提交回数据源（乐观锁；配三路合并时 409 自动 rebase，' +
    '裁决明细在 merge 里如实回报——status=committed 也可能有要素被判给服务端，务必检查）。' +
    '外部写、强制审批、幂等键下可安全重试；提交本身不可撤销（撤销请在提交前）。',
  category: 'source',
  kind: 'action',
  tags: ['source', 'commit', 'sync'],
  since: '2026-07-27',
  // state:'irreversible'——SyncClient 成功后 remap 临时 id / 409 时按策略改写引擎，
  // 这些调整不产生可 undo 的 diff（editor-core 契约），如实声明；审批门据此跳过
  // dryRun 预览（预览会真提交）并强制人审。
  effects: {
    state: 'irreversible',
    external: 'write',
    approval: 'always',
    idempotency: 'keyed',
  },
  requires: [GEO_SYNC_SERVICE_KEY],
  inputSchema: commitInput,
  outputSchema: commitOutput,
  handler: async (ctx) => {
    const bridge = ctx.services.require<SyncBridge>(GEO_SYNC_SERVICE_KEY);
    const outcome = await bridge.commit();
    return { output: toCommitOutput(outcome) };
  },
};

/** U3-B 数据源能力组（createGeoPack({ source: true }) 时并入——宿主有数据面才开）。 */
export const sourceCapabilities = [list, checkout, commit];
