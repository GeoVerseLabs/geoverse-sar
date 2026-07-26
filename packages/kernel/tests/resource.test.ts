/**
 * U3-A Resource 数据面端口（RFC-0010）：只读世界不进撤销时间线；
 * 提供端口才注入 runtime.resources 服务；参考实现的 filter/分页/hasMore 契约。
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createKernel,
  createMemoryResourcePort,
  RESOURCES_SERVICE_KEY,
  type Capability,
  type ResourcePort,
} from '../src/index';
import {
  allItemCapabilities,
  ItemAlgebra,
  ItemEngine,
  type Item,
  type ItemDiff,
} from './helpers';

const port = () =>
  createMemoryResourcePort([
    {
      descriptor: {
        id: 'demo.parcels',
        title: '演示地块表',
        description: '只读演示数据源',
        schemaSummary: { name: 'string', zone: 'string' },
        meta: { crs: 'local-planar' },
      },
      items: [
        { id: 'a', name: '地块A', properties: { zone: 'R1' } },
        { id: 'b', name: '地块B', properties: { zone: 'R2' } },
        { id: 'c', name: '地块C', properties: { zone: 'R1' } },
      ],
    },
  ]);

function makeKernel(resources?: ResourcePort) {
  const engine = new ItemEngine([{ id: 'a', value: 1 }]);
  return {
    engine,
    kernel: createKernel<Item, ItemDiff>({
      engine,
      algebra: new ItemAlgebra(),
      packs: [{ id: 'item', capabilities: allItemCapabilities() }],
      resources,
    }),
  };
}

describe('ResourcePort（数据面）', () => {
  it('list 带 countHint；query 支持浅等值 filter（含一层 properties 宽容）与分页 hasMore', async () => {
    const p = port();
    const list = await p.list();
    expect(list).toHaveLength(1);
    expect(list[0].countHint).toBe(3);

    const r1 = await p.query('demo.parcels', { filter: { zone: 'R1' } });
    expect(r1.items.map((i) => (i as { id: string }).id)).toEqual(['a', 'c']);
    expect(r1.total).toBe(2);
    expect(r1.hasMore).toBe(false);

    const page = await p.query('demo.parcels', { page: { offset: 0, limit: 2 } });
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);

    await expect(p.query('nope')).rejects.toThrow(/资源不存在/);
  });

  it('提供端口才注入 runtime.resources 服务并暴露 kernel.resources；查询不进撤销时间线', async () => {
    const { kernel, engine } = makeKernel(port());
    expect(kernel.resources).toBeDefined();
    expect(kernel.services.get(RESOURCES_SERVICE_KEY)).toBeDefined();

    await kernel.resources!.query('demo.parcels', { filter: { zone: 'R2' } });
    expect(engine.undoDepth).toBe(0); // 只读世界：无事务、无撤销单元

    const bare = makeKernel(undefined).kernel;
    expect(bare.resources).toBeUndefined();
    expect(bare.services.get(RESOURCES_SERVICE_KEY)).toBeUndefined();
  });

  it('requires 消费面：依赖 runtime.resources 的能力在无数据面宿主上报 service_missing', async () => {
    const probe: Capability<Record<string, never>, { n: number }, Item, ItemDiff> = {
      id: 'source.probe',
      title: '数据源探测',
      description: '统计首个数据源命中条数，用于数据面服务接线测试。',
      category: 'source',
      kind: 'read',
      requires: [RESOURCES_SERVICE_KEY],
      inputSchema: z.object({}),
      outputSchema: z.object({ n: z.number() }),
      handler: async (ctx) => {
        const res = ctx.services.require<ResourcePort>(RESOURCES_SERVICE_KEY);
        const [first] = await res.list();
        const q = await res.query(first.id);
        return { output: { n: q.items.length } };
      },
    };

    const withRes = makeKernel(port());
    withRes.kernel.registry.register(probe);
    const ok = await withRes.kernel.invoke<{ n: number }>('source.probe', {});
    expect(ok.ok).toBe(true);
    expect(ok.output!.n).toBe(3);

    const bare = makeKernel(undefined);
    bare.kernel.registry.register(probe);
    const missing = await bare.kernel.invoke('source.probe', {});
    expect(missing.ok).toBe(false);
    expect(missing.error?.code).toBe('service_missing');
  });
});
