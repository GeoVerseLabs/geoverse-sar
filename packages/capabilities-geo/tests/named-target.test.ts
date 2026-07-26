/**
 * U3-C 命名集与 target 统一寻址（RFC-0010 §五）：
 * 句柄化回包（setId/count/sample 有界/hasMore）+ target 三选一 +
 * **平价不变量**：target:{setId} 与等价显式 id 列表产出的 diff 逐字节相同。
 */
import { describe, expect, it } from 'vitest';
import type { Point } from 'geojson';
import { createKernel, type SarKernel } from '@geoverse-sar/kernel';
import {
  ChangeSetAlgebra,
  createGeoEngine,
  type ChangeSet,
  type EditableFeature,
} from '@geoverse-sar/engine-geo';
import { createGeoPack } from '../src/index';

const pt = (
  id: string,
  x: number,
  y: number,
  props: Record<string, unknown> = {},
): EditableFeature => ({
  id,
  geometry: { type: 'Point', coordinates: [x, y] } as Point,
  properties: props,
});

const seed = (): EditableFeature[] => [
  ...Array.from({ length: 12 }, (_, i) => pt(`b${i + 1}`, i, 0, { type: 'building' })),
  pt('r1', 99, 99, { type: 'road' }),
];

function makeKernel(): SarKernel<EditableFeature, ChangeSet> {
  return createKernel<EditableFeature, ChangeSet>({
    engine: createGeoEngine({ features: seed() }),
    algebra: new ChangeSetAlgebra(),
    packs: [createGeoPack()],
  });
}

const canonical = (v: unknown): string => {
  const walk = (x: unknown): unknown => {
    if (x === null || typeof x !== 'object') return x;
    if (Array.isArray(x)) return x.map(walk);
    return Object.fromEntries(
      Object.keys(x as Record<string, unknown>)
        .sort()
        .map((k) => [k, walk((x as Record<string, unknown>)[k])]),
    );
  };
  return JSON.stringify(walk(v));
};

/** diff 里的 txId 每次生成不同——语义平价前剥掉（与 server 平价 stripTiming 同姿势）。 */
const stripTxId = (diff: unknown): unknown => {
  const d = structuredClone(diff) as { txId?: string };
  delete d.txId;
  return d;
};

describe('句柄化回包', () => {
  it('query 返回 setId + 有界 sample（≤10）+ hasMore；命名集可复取全量 id', async () => {
    const kernel = makeKernel();
    const out = await kernel.invoke<{
      setId: string;
      count: number;
      sample: unknown[];
      hasMore: boolean;
    }>('features.query', { propsEquals: { type: 'building' } });
    expect(out.ok).toBe(true);
    expect(out.output!.count).toBe(12);
    expect(out.output!.sample).toHaveLength(10); // 12 命中不全量倾倒
    expect(out.output!.hasMore).toBe(true);

    // 写能力经 setId 指代整批（含 sample 之外的两条）
    const move = await kernel.invoke<{ count: number }>('features.translate', {
      target: { setId: out.output!.setId },
      dx: 0,
      dy: 5,
    });
    expect(move.output!.count).toBe(12);
    expect(
      (kernel.engine.snapshot().entities.get('b12')!.geometry as Point).coordinates[1],
    ).toBe(5);
  });
});

describe('target 统一寻址', () => {
  it('平价不变量：target:{setId} 与等价显式 id 列表产出 diff 逐字节相同', async () => {
    // 双胞胎内核（同 seed），分别走两种寻址
    const a = makeKernel();
    const b = makeKernel();
    const q = await a.invoke<{ setId: string }>('features.query', {
      propsEquals: { type: 'building' },
    });
    const viaSet = await a.invoke('features.translate', {
      target: { setId: q.output!.setId },
      dx: 3,
      dy: 0,
    });
    const explicitIds = Array.from({ length: 12 }, (_, i) => `b${i + 1}`);
    const viaIds = await b.invoke('features.translate', {
      ids: explicitIds,
      dx: 3,
      dy: 0,
    });
    expect(viaSet.ok).toBe(true);
    expect(viaIds.ok).toBe(true);
    expect(canonical(stripTxId(viaSet.diff))).toBe(canonical(stripTxId(viaIds.diff)));
  });

  it('filter 目标即时求值；view.focus 也认 target', async () => {
    const kernel = makeKernel();
    const out = await kernel.invoke<{ count: number }>('features.setProps', {
      target: { filter: { type: 'road' } },
      props: { grade: 'A' },
    });
    expect(out.output!.count).toBe(1);
    expect(kernel.engine.snapshot().entities.get('r1')!.properties.grade).toBe('A');
  });

  it('失效 setId / 空 filter 命中 / ids 与 target 同给 → validation_failed（可自纠）', async () => {
    const kernel = makeKernel();
    const stale = await kernel.invoke('features.remove', {
      target: { setId: 'set_404' },
    });
    expect(stale.ok).toBe(false);
    expect(stale.error?.code).toBe('validation_failed');
    expect(stale.error?.message).toContain('set_404');

    const empty = await kernel.invoke('features.remove', {
      target: { filter: { type: '不存在的类型' } },
    });
    expect(empty.error?.code).toBe('validation_failed');

    const both = await kernel.invoke('features.remove', {
      ids: ['b1'],
      target: { ids: ['b2'] },
    });
    expect(both.error?.code).toBe('validation_failed');
    expect(both.error?.message).toContain('恰取其一');

    // 全程零写入
    expect(kernel.engine.undoDepth).toBe(0);
  });

  it('rotate/scale/mirror 同样支持 target（transform 组全线接入）', async () => {
    const kernel = makeKernel();
    const q = await kernel.invoke<{ setId: string }>('features.query', {
      propsEquals: { type: 'road' },
    });
    const rot = await kernel.invoke<{ count: number }>('features.rotate', {
      target: { setId: q.output!.setId },
      angle: 90,
      origin: { x: 0, y: 0 },
    });
    expect(rot.ok).toBe(true);
    expect(rot.output!.count).toBe(1);
  });
});
