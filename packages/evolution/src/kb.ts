/**
 * 知识端口（RFC-0009 T17，runtime RAG）：`kb` 服务 + `kb.search` read 能力 +
 * agent 观察增强器——全是能力包+服务，零内核改动。
 * KbService 是端口：内置 createMemoryKb 是零依赖参考实现（关键词计分），
 * 生产宿主可换向量检索/外部知识库，能力面与 agent 侧零改动。
 */
import { z } from 'zod';
import { defineCapability, type CapabilityPack } from '@geoverse-sar/kernel';

export const KB_SERVICE_KEY = 'kb';

export interface KbDocument {
  id: string;
  title: string;
  text: string;
  tags?: readonly string[];
}

export interface KbHit extends KbDocument {
  /** 相关性得分（实现自定标度，仅用于排序）。 */
  score: number;
}

export interface KbService {
  search(query: string, opts?: { limit?: number }): Promise<KbHit[]>;
}

/** 查询切词：空白/标点分段 + CJK 逐字（中文无空格分词的最小可用姿势）。 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const seg of text.toLowerCase().split(/[\s\p{P}]+/u)) {
    if (!seg) continue;
    if (/^[一-鿿]+$/u.test(seg)) tokens.push(...seg);
    else tokens.push(seg);
  }
  return tokens;
}

/** 零依赖内存实现：token 命中计分（标题命中加权 ×2，tag 命中 ×3）。 */
export function createMemoryKb(docs: readonly KbDocument[]): KbService {
  const indexed = docs.map((doc) => ({
    doc,
    title: doc.title.toLowerCase(),
    text: doc.text.toLowerCase(),
    tags: (doc.tags ?? []).map((t) => t.toLowerCase()),
  }));
  return {
    async search(query, opts) {
      const limit = opts?.limit ?? 5;
      const tokens = [...new Set(tokenize(query))];
      if (!tokens.length) return [];
      const hits: KbHit[] = [];
      for (const { doc, title, text, tags } of indexed) {
        let score = 0;
        for (const token of tokens) {
          if (tags.some((t) => t.includes(token))) score += 3;
          if (title.includes(token)) score += 2;
          if (text.includes(token)) score += 1;
        }
        if (score > 0) hits.push({ ...doc, score });
      }
      return hits.sort((a, b) => b.score - a.score).slice(0, limit);
    },
  };
}

const searchInput = z.object({
  query: z.string().min(1).describe('检索问题/关键词（支持中文）'),
  limit: z.number().int().min(1).max(20).optional().describe('最多返回条数，默认 5'),
});
const hitSchema = z.object({
  id: z.string(),
  title: z.string(),
  text: z.string(),
  tags: z.array(z.string()).optional(),
  score: z.number(),
});

/** 知识检索能力包：`kb.search`（read，requires 'kb' 服务——缺服务报 service_missing）。 */
export function createKnowledgePack(): CapabilityPack {
  return {
    id: 'knowledge',
    capabilities: [
      defineCapability({
        id: 'kb.search',
        title: '知识检索',
        description:
          '检索宿主注入的领域知识库（约定/规范/操作指南）。不确定领域约定（坐标系、字段含义、业务规则）时先调它再动手。',
        category: 'knowledge',
        kind: 'read',
        inputSchema: searchInput,
        outputSchema: z.object({ hits: z.array(hitSchema) }),
        requires: [KB_SERVICE_KEY],
        handler: async (ctx, input) => {
          const kb = ctx.services.require<KbService>(KB_SERVICE_KEY);
          const hits = await kb.search(input.query, { limit: input.limit });
          return { output: { hits } };
        },
      }),
    ],
  };
}

/**
 * agent 观察增强器（与 capabilities-geo createSpatialObserver 同姿势：
 * 泛型结构兼容 ObservationEnricher，不 import agent 包）：
 * 用当前 goal 查 kb，命中注入 observation.extra[key]——策略无需先学会调 kb.search
 * 也能拿到领域约定；无命中不加位。
 */
export function createKbEnricher<
  T extends { goal: string; extra?: Record<string, unknown> },
>(
  kb: KbService,
  opts: { limit?: number; key?: string } = {},
): (observation: T) => Promise<T> {
  const limit = opts.limit ?? 3;
  const key = opts.key ?? 'kb';
  return async (observation) => {
    const hits = await kb.search(observation.goal, { limit });
    if (!hits.length) return observation;
    return {
      ...observation,
      extra: {
        ...(observation.extra ?? {}),
        [key]: hits.map((h) => ({ id: h.id, title: h.title, text: h.text })),
      },
    };
  };
}
