/**
 * U3-B 数据源能力组：checkout（数据面→编辑区，可撤销、溯源、上限防呆）
 * + commit（editor-core SyncClient 收编：乐观锁/409；真栈 MemoryEditBackend）。
 * 复用纪律自证：合并/锁逻辑零自研——桥只搬运，语义全在 editor-core。
 */
import { describe, expect, it } from 'vitest';
import type { Point } from 'geojson';
import {
  createKernel,
  createMemoryResourcePort,
  type SarKernel,
} from '@geoverse-sar/kernel';
import {
  ChangeSetAlgebra,
  createGeoEngine,
  createSyncBridge,
  GEO_SYNC_SERVICE_KEY,
  GeoStateEngine,
  MemoryEditBackend,
  type ChangeSet,
  type EditableFeature,
} from '@geoverse-sar/engine-geo';
import { createGeoPack } from '../src/index';

const pt = (
  id: string,
  x: number,
  y: number,
  props: Record<string, unknown> = {},
  version?: number,
): EditableFeature => ({
  id,
  geometry: { type: 'Point', coordinates: [x, y] } as Point,
  properties: props,
  ...(version !== undefined ? { version } : {}),
});

const sourcePort = () =>
  createMemoryResourcePort([
    {
      descriptor: {
        id: 'demo.pois',
        title: '演示 POI 源',
        meta: { crs: 'local-planar' },
      },
      items: [
        pt('s1', 1, 1, { name: '甲' }, 1) as unknown as Record<string, unknown>,
        pt('s2', 2, 2, { name: '乙' }, 1) as unknown as Record<string, unknown>,
        { id: 'bad', geometry: { type: 'GeometryCollection', geometries: [] } },
      ].slice(0, 2),
    },
  ]);

function setup(
  opts: { seed?: EditableFeature[]; backendSeed?: EditableFeature[] } = {},
): {
  kernel: SarKernel<EditableFeature, ChangeSet>;
  engine: GeoStateEngine;
  backend: MemoryEditBackend;
} {
  const engine = createGeoEngine({ features: opts.seed ?? [] });
  const backend = new MemoryEditBackend();
  if (opts.backendSeed) backend.seed(opts.backendSeed);
  const bridge = createSyncBridge(engine, backend);
  const kernel = createKernel<EditableFeature, ChangeSet>({
    engine,
    algebra: new ChangeSetAlgebra(),
    packs: [createGeoPack({ source: true })],
    resources: sourcePort(),
    services: { [GEO_SYNC_SERVICE_KEY]: bridge },
  });
  return { kernel, engine, backend };
}

describe('source.list / source.checkout', () => {
  it('list 带 crs 剖面；checkout 可撤销写入 + _source 溯源 + version 基线保留', async () => {
    const { kernel, engine } = setup();
    const list = await kernel.invoke<{ sources: { id: string; crs?: string }[] }>(
      'source.list',
      {},
    );
    expect(list.ok).toBe(true);
    expect(list.output!.sources[0]).toMatchObject({
      id: 'demo.pois',
      crs: 'local-planar',
    });

    const co = await kernel.invoke<{ ids: string[]; count: number }>('source.checkout', {
      resource: 'demo.pois',
    });
    expect(co.ok).toBe(true);
    expect(co.output!.count).toBe(2);
    const f = engine.snapshot().entities.get('s1')!;
    expect(f.properties._source).toBe('demo.pois');
    expect(f.version).toBe(1);
    expect(engine.undoDepth).toBe(1);
    engine.undo();
    expect(engine.snapshot().entities.size).toBe(0);
  });

  it('id 冲突整体拒绝（先查后改）；超上限被 schema 拒绝', async () => {
    const { kernel } = setup({ seed: [pt('s1', 9, 9)] });
    const conflict = await kernel.invoke('source.checkout', { resource: 'demo.pois' });
    expect(conflict.ok).toBe(false);
    expect(conflict.error?.message).toContain('s1');

    const over = await kernel.invoke('source.checkout', {
      resource: 'demo.pois',
      limit: 10_000,
    });
    expect(over.ok).toBe(false);
    expect(over.error?.code).toBe('validation_failed');
  });
});

describe('source.commit（SyncClient 收编，真栈 MemoryEditBackend）', () => {
  it('无变更 → noop；检出+编辑后提交 → committed，临时 id 改名表与后端权威一致', async () => {
    const { kernel, engine, backend } = setup();
    const noop = await kernel.invoke<{ status: string }>('source.commit', {});
    expect(noop.output!.status).toBe('noop');

    await kernel.invoke('features.add', {
      features: [{ id: 'tmp-1', x: 5, y: 5, props: { name: '新点' } }],
    });
    const out = await kernel.invoke<{
      status: string;
      affected: number;
      newIds?: Record<string, string>;
    }>('source.commit', {});
    expect(out.ok).toBe(true);
    expect(out.output!.status).toBe('committed');
    expect(out.output!.affected).toBeGreaterThan(0);
    const real = out.output!.newIds?.['tmp-1'];
    expect(real).toBeTruthy();
    // 后端权威已含该要素；引擎侧临时 id 已被 SyncClient remap 成真实 id
    expect(backend.get(real!)).toBeDefined();
    expect(engine.snapshot().entities.has(real!)).toBe(true);
    expect(engine.snapshot().entities.has('tmp-1')).toBe(false);
  });

  it('乐观锁 409（无三路合并）→ status=conflict + conflictIds，引擎按 editor-core 语义采纳服务端', async () => {
    const seedF = pt('f1', 0, 0, {}, 1);
    const { kernel, backend } = setup({
      seed: [structuredClone(seedF)],
      backendSeed: [structuredClone(seedF)],
    });
    await kernel.invoke('features.translate', { ids: ['f1'], dx: 3, dy: 0 });
    backend.bumpVersion('f1'); // 模拟并发：服务端版本前进
    const out = await kernel.invoke<{ status: string; conflictIds?: string[] }>(
      'source.commit',
      {},
    );
    expect(out.ok).toBe(true);
    expect(out.output!.status).toBe('conflict');
    expect(out.output!.conflictIds).toContain('f1');
  });

  it('effects 声明：外部写 + 强制审批 + 幂等 + 不可逆（审批门跳预览的判据）', () => {
    const { kernel } = setup();
    const d = kernel.registry.describe('source.commit');
    expect(d.effects).toEqual({
      state: 'irreversible',
      external: 'write',
      approval: 'always',
      idempotency: 'keyed',
    });
    expect(d.undoable).toBe(false);
  });

  it('无数据面/同步桥的宿主：source.* 报 service_missing（doctor 可提前发现）', async () => {
    const engine = createGeoEngine({ features: [] });
    const kernel = createKernel<EditableFeature, ChangeSet>({
      engine,
      algebra: new ChangeSetAlgebra(),
      packs: [createGeoPack({ source: true })],
    });
    const listOut = await kernel.invoke('source.list', {});
    expect(listOut.error?.code).toBe('service_missing');
    const commitOut = await kernel.invoke('source.commit', {});
    expect(commitOut.error?.code).toBe('service_missing');
  });
});
