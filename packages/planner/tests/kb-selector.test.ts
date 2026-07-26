/**
 * U5-E kb 检索版目录选择器：向量/检索端口替换启发式计分，安全不变量不变——
 * 输出⊆输入目录（kb 陈旧/越权条目漏不进来）、runtime 恒钉住、召回不足按目录序
 * 补齐（确定性）、500 能力规模下 goal 精确召回（目录规模化验收缩影）。
 */
import { describe, expect, it } from 'vitest';
import type { CapabilityDescriptor } from '@geoverse-sar/kernel';
import { catalogKbDocs, createKbSelector, type KbSearchLike } from '../src/index';

const desc = (
  id: string,
  title: string,
  description: string,
  category = 'misc',
  tags: string[] = [],
): CapabilityDescriptor => ({
  id,
  title,
  description,
  category,
  kind: 'read',
  effects: { state: 'none', external: 'none', approval: 'never', idempotency: 'keyed' },
  tags,
  inputJsonSchema: { type: 'object' },
  outputJsonSchema: { type: 'object' },
});

/** 假 kb：按预设命中表返回（真实现=evolution createMemoryKb / 生产向量库）。 */
function fakeKb(hits: Record<string, string[]>): KbSearchLike & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async search(query) {
      queries.push(query);
      const ids = hits[query] ?? [];
      return ids.map((id, i) => ({ id, score: ids.length - i }));
    },
  };
}

describe('createKbSelector', () => {
  const catalog = [
    desc('catalog.search', '搜索能力目录', '目录检索元能力', 'runtime'),
    desc('road.buffer', '道路缓冲', '对道路要素做缓冲分析', 'edit'),
    desc('poi.query', '查询兴趣点', '按属性查询 POI', 'query'),
    desc('water.fill', '水面填充', '填充水面孔洞', 'edit'),
    desc('road.split', '道路打断', '道路线在交点打断', 'edit'),
  ];

  it('小目录直通（kb 不被调用）；大目录按 kb 命中序取额且 runtime 钉住、保目录序', async () => {
    const kb = fakeKb({ 缓冲: ['road.buffer', 'road.split'] });
    const selector = createKbSelector(kb, { limit: 3 });

    expect(await selector.select('随便', catalog.slice(0, 3))).toEqual(
      catalog.slice(0, 3),
    );
    expect(kb.queries).toHaveLength(0);

    const ids = (await selector.select('缓冲', catalog)).map((d) => d.id);
    expect(ids).toEqual(['catalog.search', 'road.buffer', 'road.split']); // 钉住+命中，目录原序
  });

  it('子集不变量：kb 命中目录外/越权 id 被丢弃；召回不足按目录序补齐到额度', async () => {
    const kb = fakeKb({ goal: ['ghost.cap', 'water.fill'] }); // ghost 不在目录
    const selector = createKbSelector(kb, { limit: 3 });
    const ids = (await selector.select('goal', catalog)).map((d) => d.id);
    expect(ids).not.toContain('ghost.cap');
    expect(ids).toContain('water.fill');
    expect(ids).toHaveLength(3); // 不足额按目录序补齐（road.buffer 补入）
    expect(ids).toEqual(['catalog.search', 'road.buffer', 'water.fill']);
  });

  it('500 能力规模：goal 命中的长尾能力被召回，规模收到 limit（红线三缩影）', async () => {
    const big: CapabilityDescriptor[] = [
      desc('catalog.search', '搜索能力目录', '目录检索元能力', 'runtime'),
      ...Array.from({ length: 499 }, (_, i) =>
        desc(`bulk.cap${i}`, `批量能力 ${i}`, `批量生成的占位能力 ${i}`, 'bulk'),
      ),
    ];
    const kb = fakeKb({ 长尾: ['bulk.cap420'] });
    const selector = createKbSelector(kb, { limit: 10 });
    const ids = (await selector.select('长尾', big)).map((d) => d.id);
    expect(ids).toHaveLength(10);
    expect(ids).toContain('catalog.search');
    expect(ids).toContain('bulk.cap420'); // 检索召回长尾，无需更大 system prompt
  });

  it('catalogKbDocs：描述符→kb 文档投影（宿主摄取入口，id 对齐）', () => {
    const docs = catalogKbDocs(catalog.slice(0, 2));
    expect(docs).toEqual([
      { id: 'catalog.search', title: '搜索能力目录', text: '目录检索元能力' },
      { id: 'road.buffer', title: '道路缓冲', text: '对道路要素做缓冲分析' },
    ]);
  });
});
