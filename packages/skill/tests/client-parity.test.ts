/**
 * T12/R6：client 版投影与回灌与 kernel 版**逐字节平价**——
 * toToolSpecsOf(catalog) ≡ toToolSpecs(kernel)、handleToolCallVia ≡ handleToolCall。
 * 平价是"入口层换依赖不换行为"的可证伪判据。
 */
import { describe, expect, it } from 'vitest';
import { clientOf, createKernel, type SarKernel } from '@geoverse-sar/kernel';
import {
  InMemoryStateEngine,
  RecordDiffAlgebra,
  type RecordDiff,
  type RecordEntity,
} from '@geoverse-sar/engine-memory';
import {
  createHighlightAndNudgeWorkflow,
  createMemoryViewService,
  createRecordsPack,
  VIEW_SERVICE_KEY,
} from '@geoverse-sar/capabilities-records';
import {
  AI_CALLER,
  handleToolCall,
  handleToolCallVia,
  toToolSpecs,
  toToolSpecsOf,
} from '../src/index';

const rec = (id: string, x: number, y: number): RecordEntity => ({
  id,
  x,
  y,
  props: {},
});

function makeKernel(): {
  kernel: SarKernel<RecordEntity, RecordDiff>;
  engine: InMemoryStateEngine;
} {
  const engine = new InMemoryStateEngine([rec('p1', 0, 0), rec('p2', 10, 0)]);
  const kernel = createKernel<RecordEntity, RecordDiff>({
    engine,
    algebra: new RecordDiffAlgebra(),
    packs: [createRecordsPack()],
    workflows: [createHighlightAndNudgeWorkflow()],
    services: { [VIEW_SERVICE_KEY]: createMemoryViewService() },
  });
  return { kernel, engine };
}

describe('client 版投影/回灌与 kernel 版平价（T12/R6）', () => {
  it('toToolSpecsOf(client.catalog()) ≡ toToolSpecs(kernel)（同 caller）', async () => {
    const { kernel } = makeKernel();
    const client = clientOf(kernel, AI_CALLER);
    const viaClient = toToolSpecsOf(await client.catalog());
    const viaKernel = toToolSpecs(kernel);
    expect(viaClient).toEqual(viaKernel);
  });

  it('handleToolCallVia ≡ handleToolCall：成功路径同 content、同终态', async () => {
    const a = makeKernel();
    const b = makeKernel();
    const client = clientOf(b.kernel, AI_CALLER);

    const viaKernel = await handleToolCall(a.kernel, 'records__translate', {
      ids: ['p1'],
      dx: 5,
      dy: 0,
    });
    const viaClient = await handleToolCallVia(client, 'records__translate', {
      ids: ['p1'],
      dx: 5,
      dy: 0,
    });

    expect(viaClient.is_error).toBe(false);
    expect(viaClient.content).toBe(viaKernel.content);
    expect(b.engine.snapshot().entities.get('p1')!.x).toBe(
      a.engine.snapshot().entities.get('p1')!.x,
    );
  });

  it('失败路径：capability_not_found 的 hint 用目录数组给相似建议（无 registry 可用）', async () => {
    const { kernel } = makeKernel();
    const client = clientOf(kernel, AI_CALLER);
    const catalog = await client.catalog();

    const res = await handleToolCallVia(
      client,
      'records__translte',
      { ids: ['p1'] },
      {
        catalog,
      },
    );
    expect(res.is_error).toBe(true);
    expect(res.content).toContain('records.translate'); // 相似能力建议来自 catalog
  });

  it('目录消歧：id 含 __ 时 catalog 命中原名不误转', async () => {
    const { kernel } = makeKernel();
    const client = clientOf(kernel, AI_CALLER);
    const catalog = await client.catalog();
    // records.query 经工具名 records__query 与直接 id 两种写法均可
    const viaToolName = await handleToolCallVia(
      client,
      'records__query',
      {},
      { catalog },
    );
    const viaId = await handleToolCallVia(client, 'records.query', {}, { catalog });
    expect(viaToolName.is_error).toBe(false);
    expect(viaToolName.content).toBe(viaId.content);
  });

  it('dryRun 透传：返回 diff、状态不变', async () => {
    const { kernel, engine } = makeKernel();
    const client = clientOf(kernel, AI_CALLER);
    const res = await handleToolCallVia(
      client,
      'records__translate',
      { ids: ['p1'], dx: 5, dy: 0 },
      { dryRun: true },
    );
    expect(res.is_error).toBe(false);
    expect(res.outcome.diff).toBeDefined();
    expect(engine.snapshot().entities.get('p1')!.x).toBe(0);
  });
});
