/**
 * Resource 数据面端口（阶段四 U3，RFC-0010）：与能力目录并列的第二内核端口。
 * 世界观修正：可编辑状态从"世界的全部"降级为"资源的特例"——只读、超大或远程的
 * 数据（数据库表/要素服务/目录）经本端口发现与查询，**不进撤销时间线**（无 undo、
 * 无 diff、不产生事务）；要编辑就 checkout 子集进 StateEngine，提交回去是一次
 * external write 能力（既有治理零改动覆盖）。
 *
 * 领域中立纪律（红线一）：描述符/查询不含任何领域词汇——领域剖面（如 geo 的
 * 坐标系与空间范围）经 `meta` / `ext` 装入，形状由领域侧（geo-profile）约定，
 * kernel 不解释。
 */

export interface ResourceDescriptor {
  id: string;
  title: string;
  description?: string;
  /** 字段摘要（字段名→类型说明字符串）：只为发现与提示，非严格 JSON Schema。 */
  schemaSummary?: Record<string, string>;
  /** 数量级提示（估算值，非精确计数）。 */
  countHint?: number;
  /** 领域剖面：kernel 不解释（geo 侧形状见 geo-profile 的 ResourceMetaGeo）。 */
  meta?: Record<string, unknown>;
}

export interface ResourceQuery {
  /** 属性等值过滤（实现按自身语义解释；参考实现为浅等值）。 */
  filter?: Record<string, unknown>;
  page?: { offset: number; limit: number };
  /** 领域扩展位（如 geo 的空间范围条件）——kernel 不解释。 */
  ext?: Record<string, unknown>;
}

export interface ResourceQueryResult<TItem = unknown> {
  items: TItem[];
  /** 命中总数（分页前；实现可省略）。 */
  total?: number;
  /** 本页之外还有更多（读端有界回包的诚实位）。 */
  hasMore?: boolean;
}

export interface ResourcePort<TItem = unknown> {
  list(): ResourceDescriptor[] | Promise<ResourceDescriptor[]>;
  query(id: string, q?: ResourceQuery): Promise<ResourceQueryResult<TItem>>;
}

/** createKernel 注入的资源服务键（提供 resources 端口时才存在；能力经 requires 消费）。 */
export const RESOURCES_SERVICE_KEY = 'runtime.resources';

export interface MemoryResourceSource<TItem> {
  descriptor: ResourceDescriptor;
  items: TItem[];
}

/**
 * 内存参考实现（测试/playground/MCP 平价基准）：浅等值 filter + 分页。
 * ext 不解释（领域侧要空间过滤请在自己的端口实现里做）。
 */
export function createMemoryResourcePort<TItem extends Record<string, unknown>>(
  sources: MemoryResourceSource<TItem>[],
): ResourcePort<TItem> {
  const byId = new Map(sources.map((s) => [s.descriptor.id, s]));
  return {
    list: () => sources.map((s) => ({ ...s.descriptor, countHint: s.items.length })),
    async query(id, q = {}) {
      const src = byId.get(id);
      if (!src) throw new Error(`资源不存在: ${id}`);
      let items = src.items;
      if (q.filter) {
        const entries = Object.entries(q.filter);
        items = items.filter((it) =>
          entries.every(([k, v]) => matchesFilterValue(it, k, v)),
        );
      }
      const total = items.length;
      const offset = q.page?.offset ?? 0;
      const limit = q.page?.limit ?? total;
      const pageItems = items.slice(offset, offset + limit);
      return { items: pageItems, total, hasMore: offset + pageItems.length < total };
    },
  };
}

function matchesFilterValue(item: Record<string, unknown>, key: string, v: unknown) {
  const direct = item[key];
  if (Object.is(direct, v)) return true;
  // 一层嵌套宽容（如要素的 properties.xxx）——参考实现的取用便利，非规范语义
  const props = item['properties'];
  if (props && typeof props === 'object') {
    return Object.is((props as Record<string, unknown>)[key], v);
  }
  return false;
}
