/**
 * target 统一寻址（阶段四 U3-C，RFC-0010 §五）：写能力的目标要素三选一——
 * 命名集句柄 / 显式 id 列表 / 属性过滤（即时求值）。平价不变量（测试钉死）：
 * `target:{setId}` 与等价显式 id 列表产出的 diff 逐字节相同。
 * target 原样落审计入参——"改了谁"从此可追溯为组合引用而非坐标倾倒。
 */
import { z } from 'zod';
import {
  SarError,
  SETS_SERVICE_KEY,
  type CapabilityContext,
  type NamedSetService,
} from '@geoverse-sar/kernel';
import type { ChangeSet, EditableFeature } from '@geoverse-sar/engine-geo';

export const targetSchema = z
  .union([
    z.object({
      setId: z.string().describe('命名集句柄（features.query 等 read 能力返回）'),
    }),
    z.object({ ids: z.array(z.string()).min(1).describe('显式要素 id 列表') }),
    z.object({
      filter: z
        .record(z.string(), z.unknown())
        .describe('属性全等过滤（对当前编辑区即时求值）'),
    }),
  ])
  .describe('目标要素（三选一）：{setId} / {ids} / {filter}');
export type Target = z.infer<typeof targetSchema>;

/**
 * 解析目标 id 列表。约定：能力入参 `ids`（旧）与 `target`（新）**恰取其一**；
 * 空命中/失效句柄结构化拒绝（validation_failed，模型可自纠）。
 */
export function resolveTargetIds(
  ctx: CapabilityContext<EditableFeature, ChangeSet>,
  input: { ids?: string[]; target?: Target },
  capabilityId: string,
): string[] {
  const hasIds = input.ids !== undefined;
  const hasTarget = input.target !== undefined;
  if (hasIds === hasTarget) {
    throw new SarError(
      'validation_failed',
      `${capabilityId} 的目标要素须在 ids 与 target 之间恰取其一`,
    );
  }
  if (hasIds) return input.ids!;

  const target = input.target!;
  if ('ids' in target) return target.ids;
  if ('setId' in target) {
    const sets = ctx.services.require<NamedSetService>(SETS_SERVICE_KEY);
    const set = sets.get(target.setId);
    if (!set) {
      throw new SarError(
        'validation_failed',
        `命名集不存在或已过期: ${target.setId}——先用 features.query 重新取得句柄`,
      );
    }
    if (set.ids.length === 0) {
      throw new SarError('validation_failed', `命名集 ${target.setId} 为空集`);
    }
    return set.ids;
  }
  const entries = Object.entries(target.filter);
  const ids = ctx.state
    .list()
    .filter((f) => entries.every(([k, v]) => f.properties[k] === v))
    .map((f) => f.id);
  if (ids.length === 0) {
    throw new SarError('validation_failed', 'filter 目标零命中——先查询确认条件');
  }
  return ids;
}
