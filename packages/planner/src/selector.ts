import type { CapabilityDescriptor } from '@geoverse-sar/kernel';

/**
 * 目录选择器端口（阶段四 U0-6，目录规模化的第一半）：
 * goal + 权限裁剪后的目录 → top-k 工具子集。红线三：目录规模化用检索与分层披露，
 * 不用更大的 system prompt——目录仍每 run 动态重取，selector 只做**收窄**（入参
 * 已是裁剪后目录，永远选不出调用方无权看见的能力）。缺省启发式实现见
 * `createHeuristicSelector`；生产可换向量检索（复用 kb 端口，U5）。
 */
export interface CatalogSelector {
  select(
    goal: string,
    catalog: CapabilityDescriptor[],
  ): CapabilityDescriptor[] | Promise<CapabilityDescriptor[]>;
}

export interface HeuristicSelectorOptions {
  /** 子集上限（含钉住的 runtime 元能力），默认 40——LLM 工具列表的舒适上限。 */
  limit?: number;
}

/**
 * 缺省启发式选择器：按 goal 关键词对 id/标题/描述/tags 计分取 top-k
 * （中文逐字、tag×3、标题×2、id/描述×1——与 kb 内存检索同一血统），
 * `runtime` 分类的元能力（runtime.stats / catalog.search…）恒被钉住——
 * 模型即使拿到收窄目录，也永远能自己搜目录找回长尾工具（分层披露）。
 */
export function createHeuristicSelector(
  options: HeuristicSelectorOptions = {},
): CatalogSelector {
  const limit = options.limit ?? 40;
  return {
    select(goal, catalog) {
      if (catalog.length <= limit) return catalog;
      const pinned = catalog.filter((d) => d.category === 'runtime').slice(0, limit);
      const rest = catalog.filter((d) => d.category !== 'runtime');
      const quota = Math.max(0, limit - pinned.length);

      const q = goal.toLowerCase();
      const terms = new Set<string>();
      for (const m of q.match(/[a-z0-9_.-]+/g) ?? []) terms.add(m);
      // eslint-disable-next-line no-control-regex
      for (const ch of q.replace(/[\x00-\x7f]/g, '')) terms.add(ch);

      const score = (d: CapabilityDescriptor): number => {
        let s = 0;
        const title = d.title.toLowerCase();
        const desc = d.description.toLowerCase();
        const id = d.id.toLowerCase();
        const tags = (d.tags ?? []).map((t) => t.toLowerCase());
        for (const t of terms) {
          if (tags.some((tag) => tag.includes(t))) s += 3;
          if (title.includes(t)) s += 2;
          if (id.includes(t)) s += 1;
          if (desc.includes(t)) s += 1;
        }
        return s;
      };

      const picked = rest
        .map((d, i) => ({ d, i, s: score(d) }))
        .sort((a, b) => b.s - a.s || a.i - b.i) // 同分保目录序（稳定可复现）
        .slice(0, quota)
        .map((x) => x.d);
      // 保持目录原序输出（工具列表顺序稳定，利于缓存与快照断言）
      const keep = new Set([...pinned, ...picked].map((d) => d.id));
      return catalog.filter((d) => keep.has(d.id));
    },
  };
}
