/**
 * 目录选择器向量/检索版（U5-E，RFC-0012；U0-6 的第二半）：复用 kb 检索端口做
 * goal→top-k 收窄，替换启发式计分——**结构镜像** evolution 的 KbService
 * （planner 依赖方向禁 import evolution；`createMemoryKb` 天然结构兼容，
 * 生产可换真向量库，选择器零改动）。
 *
 * 安全不变量与启发式版完全一致：
 * - 输出恒为输入目录的子集（kb 命中先与目录 id 求交——kb 里的陈旧/越权条目
 *   永远漏不进来，权限裁剪仍由切面负责）；
 * - `runtime` 元能力恒钉住（分层披露：模型总能 catalog.search 找回长尾）；
 * - kb 抛异常由 planner 统一退回全量目录（收窄是优化不是门禁）。
 */
import type { CapabilityDescriptor } from '@geoverse-sar/kernel';
import type { CatalogSelector } from './selector';

/** kb 检索端口的最小结构面（与 @geoverse-sar/evolution KbService.search 兼容）。 */
export interface KbSearchLike {
  search(
    query: string,
    opts?: { limit?: number },
  ): Promise<{ id: string; score: number }[]>;
}

export interface KbSelectorOptions {
  /** 子集上限（含钉住的 runtime 元能力），默认 40。 */
  limit?: number;
}

/** 把目录描述符投成 kb 文档（宿主喂 createMemoryKb 或真向量库的摄取入口）。 */
export function catalogKbDocs(
  catalog: readonly CapabilityDescriptor[],
): { id: string; title: string; text: string; tags?: readonly string[] }[] {
  return catalog.map((d) => ({
    id: d.id,
    title: d.title,
    text: d.description,
    ...(d.tags?.length ? { tags: d.tags } : {}),
  }));
}

/**
 * kb 检索版选择器：kb 命中序取额，不足按目录序补齐（确定性）；
 * 输出保持目录原序（工具列表顺序稳定，利于缓存与快照断言）。
 */
export function createKbSelector(
  kb: KbSearchLike,
  options: KbSelectorOptions = {},
): CatalogSelector {
  const limit = options.limit ?? 40;
  return {
    async select(goal, catalog) {
      if (catalog.length <= limit) return catalog;
      const pinned = catalog.filter((d) => d.category === 'runtime').slice(0, limit);
      const rest = catalog.filter((d) => d.category !== 'runtime');
      const quota = Math.max(0, limit - pinned.length);

      // 命中与目录求交：kb 是外部索引，目录才是事实源（子集不变量）
      const restIds = new Set(rest.map((d) => d.id));
      const hits = await kb.search(goal, { limit: quota * 2 });
      const hitOrder = hits.map((h) => h.id).filter((id) => restIds.has(id));
      const picked = new Set(hitOrder.slice(0, quota));
      // kb 召回不足时按目录序补齐到额度（收窄结果规模确定）
      for (const d of rest) {
        if (picked.size >= quota) break;
        picked.add(d.id);
      }
      const keep = new Set([...pinned.map((d) => d.id), ...picked]);
      return catalog.filter((d) => keep.has(d.id));
    },
  };
}
