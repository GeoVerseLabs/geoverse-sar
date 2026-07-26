/**
 * 历史版本能力（阶段四 U3-D，复用 geoverse RFC-0006 全套）：SAR 只做能力投影与
 * effects 标注——版本模型/存储契约（HistoryStore：Memory/Http/PostGIS）全在
 * editor-core/宿主侧；**回滚=一次普通编辑**（modified before/after，可撤销），
 * 与 RFC-0006「回滚不新增机制」同一立场。
 */
import { z } from 'zod';
import { SarError, type Capability } from '@geoverse-sar/kernel';
import type { ChangeSet, EditableFeature, HistoryStore } from '@geoverse-sar/engine-geo';

type GeoCapability<I, O> = Capability<I, O, EditableFeature, ChangeSet>;

/** 宿主注入的历史存储服务键（editor-core HistoryStore 契约的实现：Memory/Http/…）。 */
export const GEO_HISTORY_SERVICE_KEY = 'geo.history';

let txSeq = 0;
const nextTxId = (): string =>
  `hist-tx-${Date.now().toString(36)}-${(++txSeq).toString(36)}`;

// ---- history.list ----

const listInput = z.object({
  featureId: z.string().describe('要素 id'),
  limit: z.number().int().min(1).max(100).default(20).describe('最多返回版本数（新→旧）'),
});
const listOutput = z.object({
  featureId: z.string(),
  total: z.number(),
  versions: z.array(
    z.object({
      version: z.number(),
      op: z.string().describe('add / modify / remove'),
      txId: z.string().optional(),
      actor: z.string().optional(),
      validFrom: z.number().describe('生效时刻（epoch ms）'),
      current: z.boolean().describe('是否当前版本'),
    }),
  ),
});

const list: GeoCapability<z.infer<typeof listInput>, z.infer<typeof listOutput>> = {
  id: 'history.list',
  title: '查看要素历史',
  description:
    '列出某要素的历史版本（版本号/操作类型/时间，不倾倒几何）。回滚前先用它确认目标版本。只读。',
  category: 'history',
  kind: 'read',
  tags: ['history'],
  since: '2026-07-27',
  requires: [GEO_HISTORY_SERVICE_KEY],
  inputSchema: listInput,
  outputSchema: listOutput,
  handler: async (ctx, input) => {
    const store = ctx.services.require<HistoryStore>(GEO_HISTORY_SERVICE_KEY);
    const versions = await store.listVersions(input.featureId);
    const sorted = [...versions].sort((a, b) => b.version - a.version);
    return {
      output: {
        featureId: input.featureId,
        total: versions.length,
        versions: sorted.slice(0, input.limit).map((v) => ({
          version: v.version,
          op: v.op,
          ...(v.txId ? { txId: v.txId } : {}),
          ...(v.actor ? { actor: v.actor } : {}),
          validFrom: v.validFrom,
          current: v.validTo === undefined,
        })),
      },
    };
  },
};

// ---- history.rollback ----

const rollbackInput = z.object({
  featureId: z.string().describe('要素 id（须仍存在于编辑区）'),
  version: z.number().int().describe('回滚到的目标版本号（history.list 可见）'),
});
const rollbackOutput = z.object({
  featureId: z.string(),
  version: z.number(),
  restored: z.boolean(),
});

const rollback: GeoCapability<
  z.infer<typeof rollbackInput>,
  z.infer<typeof rollbackOutput>
> = {
  id: 'history.rollback',
  title: '回滚要素版本',
  description:
    '把要素的几何与属性还原到指定历史版本。回滚就是一次普通编辑（可撤销、走同一漏斗），不改历史本身。',
  category: 'history',
  kind: 'write',
  tags: ['history', 'write'],
  since: '2026-07-27',
  requires: [GEO_HISTORY_SERVICE_KEY],
  inputSchema: rollbackInput,
  outputSchema: rollbackOutput,
  handler: async (ctx, input) => {
    const store = ctx.services.require<HistoryStore>(GEO_HISTORY_SERVICE_KEY);
    const target = await store.getVersion(input.featureId, input.version);
    if (!target) {
      throw new SarError(
        'validation_failed',
        `版本不存在: ${input.featureId}@v${input.version}——先用 history.list 确认`,
      );
    }
    if (!target.geometry) {
      throw new SarError(
        'validation_failed',
        `版本 v${input.version} 是删除记录（无几何可还原）——选择更早的版本`,
      );
    }
    const geometry = target.geometry;
    const properties = target.properties;
    return {
      output: { featureId: input.featureId, version: input.version, restored: true },
      commands: [
        {
          label: `回滚到 v${input.version}`,
          plan: (state) => {
            const current = state.get(input.featureId);
            if (!current) throw new Error(`要素不存在于编辑区: ${input.featureId}`);
            return {
              txId: nextTxId(),
              label: `回滚到 v${input.version}`,
              added: [],
              removed: [],
              modified: [
                {
                  id: input.featureId,
                  before: structuredClone(current.geometry),
                  after: structuredClone(geometry),
                },
              ],
              propertyChanges: [
                {
                  id: input.featureId,
                  before: structuredClone(current.properties),
                  after: structuredClone(properties),
                },
              ],
            };
          },
        },
      ],
    };
  },
};

/** U3-D 历史能力组（createGeoPack({ history: true }) 时并入——宿主接好历史存储才开）。 */
export const historyCapabilities = [list, rollback];
