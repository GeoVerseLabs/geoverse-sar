/**
 * T17：知识端口（kb 服务 + kb.search 能力 + 观察增强器）与能力摄取原型。
 */
import { describe, expect, it } from 'vitest';
import { createKernel } from '@geoverse-sar/kernel';
import {
  InMemoryStateEngine,
  RecordDiffAlgebra,
  type RecordDiff,
  type RecordEntity,
} from '@geoverse-sar/engine-memory';
import {
  createKbEnricher,
  createKnowledgePack,
  createMemoryKb,
  ingestCapability,
  KB_SERVICE_KEY,
  type KbDocument,
} from '../src/index';

const DOCS: KbDocument[] = [
  {
    id: 'crs',
    title: '坐标系约定',
    text: '本工作区坐标为画布像素，原点左上，x 向右 y 向下，范围 0~420。',
    tags: ['坐标'],
  },
  {
    id: 'naming',
    title: '命名规范',
    text: 'poi 记录的 name 必须带仓库前缀。',
    tags: ['命名'],
  },
];

function makeKernel() {
  return createKernel<RecordEntity, RecordDiff>({
    engine: new InMemoryStateEngine([]),
    algebra: new RecordDiffAlgebra(),
    packs: [createKnowledgePack()],
    services: { [KB_SERVICE_KEY]: createMemoryKb(DOCS) },
  });
}

describe('知识端口', () => {
  it('kb.search 经单漏斗检索（中文逐字命中、tag 加权、limit 生效）', async () => {
    const kernel = makeKernel();
    const out = await kernel.invoke<{ hits: { id: string; score: number }[] }>(
      'kb.search',
      { query: '坐标范围是什么', limit: 1 },
    );
    expect(out.ok).toBe(true);
    expect(out.output!.hits).toHaveLength(1);
    expect(out.output!.hits[0].id).toBe('crs');
  });

  it('kb 服务缺席 → service_missing（requires 前置校验）', async () => {
    const kernel = createKernel<RecordEntity, RecordDiff>({
      engine: new InMemoryStateEngine([]),
      algebra: new RecordDiffAlgebra(),
      packs: [createKnowledgePack()],
    });
    const out = await kernel.invoke('kb.search', { query: '坐标' });
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('service_missing');
  });

  it('createKbEnricher：goal 命中注入 extra.kb，无命中不加位', async () => {
    const enrich = createKbEnricher(createMemoryKb(DOCS), { limit: 2 });
    const hit = await enrich({ goal: '把 poi 移到坐标 100,100', extra: { spatial: 1 } });
    expect(hit.extra?.spatial).toBe(1); // 既有扩展位保留
    expect(Array.isArray(hit.extra?.kb)).toBe(true);
    expect((hit.extra?.kb as { id: string }[])[0].id).toBe('crs');

    const miss = await enrich({ goal: 'zzzz' });
    expect(miss.extra).toBeUndefined();
  });
});

describe('能力摄取原型（dev-time）', () => {
  it('签名→schema/kind/描述→源码骨架：确定性映射', async () => {
    const cap = await ingestCapability(
      {
        name: 'translateFeatures',
        doc: '把一批要素按偏移量平移。',
        params: [
          { name: 'ids', type: 'string[]', doc: '目标要素 id' },
          { name: 'dx', type: 'number' },
          { name: 'dy', type: 'number', optional: true },
        ],
      },
      { idPrefix: 'features' },
    );
    expect(cap.id).toBe('features.translateFeatures');
    expect(cap.kind).toBe('write'); // 非 get/list/query 前缀 → write
    expect(cap.source).toContain('id: "features.translateFeatures"');
    expect(cap.source).toContain('ids: z.array(z.string()).describe("目标要素 id"),');
    expect(cap.source).toContain('dy: z.number().optional(),');
    expect(cap.testSource).toContain('schema 拒绝缺参');

    const read = await ingestCapability(
      { name: 'queryFeatures', params: [] },
      { idPrefix: 'features' },
    );
    expect(read.kind).toBe('read');
  });

  it('LLM 只润色 description（可注入假实现），不碰结构', async () => {
    const cap = await ingestCapability(
      {
        name: 'mergeLines',
        doc: '合并线。',
        params: [{ name: 'ids', type: 'string[]' }],
      },
      {
        idPrefix: 'features',
        llm: { complete: async () => '需要把多条线合成一条时调用：按顺序拼接坐标。' },
      },
    );
    expect(cap.description).toBe('需要把多条线合成一条时调用：按顺序拼接坐标。');
    expect(cap.source).toContain('z.array(z.string())');
  });
});
