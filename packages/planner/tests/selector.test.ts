/**
 * U0-6 目录选择器：goal→top-k 收窄（红线三：目录规模化用检索/分层披露，
 * 不用更大 system prompt）。收窄发生在**裁剪后**目录上——权限外能力结构性进不来。
 */
import { describe, expect, it } from 'vitest';
import { clientOf, createKernel, type CapabilityDescriptor } from '@geoverse-sar/kernel';
import { AI_CALLER } from '@geoverse-sar/skill';
import {
  InMemoryStateEngine,
  RecordDiffAlgebra,
  type RecordDiff,
  type RecordEntity,
} from '@geoverse-sar/engine-memory';
import {
  createMemoryViewService,
  createRecordsPack,
  VIEW_SERVICE_KEY,
} from '@geoverse-sar/capabilities-records';
import { createHeuristicSelector, createPlanner } from '../src/index';
import type { AssistantTurn, LlmClient, LlmRequest } from '../src/index';

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

describe('createHeuristicSelector', () => {
  it('小目录直通；大目录按 goal 计分收窄且 runtime 元能力恒钉住、输出保目录序', () => {
    const selector = createHeuristicSelector({ limit: 4 });
    const small = [
      desc('a.one', '甲', '第一个能力条目说明'),
      desc('b.two', '乙', '第二个能力条目说明'),
    ];
    expect(selector.select('随便', small)).toEqual(small);

    const catalog = [
      desc('catalog.search', '搜索能力目录', '目录检索元能力', 'runtime', ['catalog']),
      desc('road.buffer', '道路缓冲', '对道路要素做缓冲分析', 'edit', ['buffer']),
      desc('poi.query', '查询兴趣点', '按属性查询 POI 要素', 'query', ['query']),
      desc('water.fill', '水面填充', '填充水面要素的孔洞', 'edit', ['holes']),
      desc('road.split', '道路打断', '把道路线要素在交点打断', 'edit', ['split']),
      desc('misc.noop', '占位', '与任何目标都无关的占位能力', 'misc'),
    ];
    const picked = selector.select('把道路做一个缓冲', catalog) as CapabilityDescriptor[];
    const ids = picked.map((d) => d.id);
    expect(ids).toContain('catalog.search'); // runtime 钉住（分层披露的兜底入口）
    expect(ids).toContain('road.buffer');
    expect(ids).not.toContain('misc.noop');
    expect(ids.length).toBe(4);
    // 输出保目录原序
    const orderInCatalog = catalog.map((d) => d.id).filter((id) => ids.includes(id));
    expect(ids).toEqual(orderInCatalog);
  });
});

describe('planner × catalogSelector', () => {
  function scripted(turns: AssistantTurn[]): LlmClient & { requests: LlmRequest[] } {
    let i = 0;
    const requests: LlmRequest[] = [];
    return {
      requests,
      async complete(req) {
        requests.push(req);
        const t = turns[Math.min(i, turns.length - 1)];
        i += 1;
        return t;
      },
    };
  }

  function makeClient() {
    const engine = new InMemoryStateEngine([{ id: 'p1', x: 0, y: 0, props: {} }]);
    const kernel = createKernel<RecordEntity, RecordDiff>({
      engine,
      algebra: new RecordDiffAlgebra(),
      packs: [createRecordsPack()],
      services: { [VIEW_SERVICE_KEY]: createMemoryViewService() },
    });
    return clientOf(kernel, AI_CALLER);
  }

  it('run 时工具列表被收窄到 limit，且收窄发生在裁剪后目录上', async () => {
    const llm = scripted([{ text: '好的。', toolCalls: [] }]);
    const planner = createPlanner(makeClient(), {
      client: llm,
      catalogSelector: createHeuristicSelector({ limit: 3 }),
    });
    const result = await planner.run('把 p1 平移一下');
    expect(result.ok).toBe(true);
    expect(llm.requests[0].tools.length).toBe(3);
    expect(llm.requests[0].tools.map((t) => t.name)).toContain('records__translate');
  });

  it('selector 抛异常 → 退回全量目录（收窄是优化不是门禁）', async () => {
    const llm = scripted([{ text: '好的。', toolCalls: [] }]);
    const planner = createPlanner(makeClient(), {
      client: llm,
      catalogSelector: {
        select() {
          throw new Error('向量服务不可用');
        },
      },
    });
    const result = await planner.run('随便说点什么');
    expect(result.ok).toBe(true);
    expect(llm.requests[0].tools.length).toBeGreaterThan(3);
  });
});
