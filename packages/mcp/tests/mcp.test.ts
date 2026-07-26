import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createKernel, type SarKernel } from '@geoverse-sar/kernel';
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
import { createMemoryResourcePort } from '@geoverse-sar/kernel';
import { createSarMcpServer, RESOURCE_URI_PREFIX } from '../src/index';

const rec = (
  id: string,
  x: number,
  y: number,
  props: Record<string, unknown>,
): RecordEntity => ({
  id,
  x,
  y,
  props,
});

async function setup(opts: { withResources?: boolean } = {}): Promise<{
  client: Client;
  kernel: SarKernel<RecordEntity, RecordDiff>;
  engine: InMemoryStateEngine;
}> {
  const engine = new InMemoryStateEngine([
    rec('p1', 0, 0, { type: 'poi' }),
    rec('p2', 10, 0, { type: 'poi' }),
  ]);
  const kernel = createKernel<RecordEntity, RecordDiff>({
    engine,
    algebra: new RecordDiffAlgebra(),
    packs: [createRecordsPack()],
    workflows: [createHighlightAndNudgeWorkflow()],
    services: { [VIEW_SERVICE_KEY]: createMemoryViewService() },
    resources: opts.withResources
      ? createMemoryResourcePort([
          {
            descriptor: {
              id: 'demo.pois',
              title: '演示 POI 源',
              description: '只读演示数据源（MCP resources 投影用）',
              meta: { crs: 'local-planar' },
            },
            items: [
              { id: 's1', name: '源点1' },
              { id: 's2', name: '源点2' },
              { id: 's3', name: '源点3' },
            ],
          },
        ])
      : undefined,
  });
  const server = createSarMcpServer(kernel);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, kernel, engine };
}

const textOf = (res: unknown): string =>
  (
    ((res as { content?: { type: string; text: string }[] }).content ?? [])[0] ?? {
      text: '',
    }
  ).text;

describe('@geoverse-sar/mcp（外部 MCP 客户端经同一 Runtime 编辑）', () => {
  it('tools/list：目录 ≡ toToolSpecs（9 工具，schema 同源）', async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(9);
    const translate = tools.find((t) => t.name === 'records__translate')!;
    expect(translate.description).toContain('平移');
    expect(translate.inputSchema).toMatchObject({
      type: 'object',
      required: ['ids', 'dx', 'dy'],
    });
  });

  it('tools/call：读→写→undo 完整回环，与程序化入口终态平价', async () => {
    const { client, engine } = await setup();

    const q = await client.callTool({
      name: 'records__query',
      arguments: { propsEquals: { type: 'poi' } },
    });
    expect(q.isError ?? false).toBe(false);
    expect(JSON.parse(textOf(q)).count).toBe(2);

    const w = await client.callTool({
      name: 'workflow__highlightAndNudge',
      arguments: { propsEquals: { type: 'poi' }, dx: 5, dy: 0 },
    });
    expect(w.isError ?? false).toBe(false);
    expect(JSON.parse(textOf(w))).toEqual({ matchedIds: ['p1', 'p2'], count: 2 });
    expect(engine.undoDepth).toBe(1);
    expect(engine.snapshot().entities.get('p1')).toMatchObject({ x: 5 });

    const u = await client.callTool({ name: 'history__undo', arguments: {} });
    expect(JSON.parse(textOf(u))).toEqual({ done: true });
    expect(engine.snapshot().entities.get('p1')).toMatchObject({ x: 0 });
  });

  it('校验失败 → isError + 结构化 issues（MCP 客户端可自纠），状态零污染', async () => {
    const { client, engine } = await setup();
    const res = await client.callTool({
      name: 'records__translate',
      arguments: { ids: ['p1'], dx: '不是数', dy: 0 },
    });
    expect(res.isError).toBe(true);
    const payload = JSON.parse(textOf(res));
    expect(payload.error.code).toBe('validation_failed');
    expect(payload.issues[0].path).toBe('dx');
    expect(engine.undoDepth).toBe(0);
  });

  it('caller.entry=mcp 进统一事件流（人机同栈观测第三种入口）', async () => {
    const { client, kernel } = await setup();
    const entries: string[] = [];
    kernel.events.on((e) => {
      if (e.type === 'invoke:start') entries.push(e.caller.entry);
    });
    await client.callTool({ name: 'records__query', arguments: {} });
    expect(entries).toEqual(['mcp']);
  });

  it('权限化目录裁剪对 MCP 同样生效', async () => {
    const engine = new InMemoryStateEngine([]);
    const kernel = createKernel<RecordEntity, RecordDiff>({
      engine,
      algebra: new RecordDiffAlgebra(),
      packs: [createRecordsPack()],
      services: { [VIEW_SERVICE_KEY]: createMemoryViewService() },
    });
    const server = createSarMcpServer(kernel, {
      caller: { entry: 'mcp', grantedPermissions: [] },
    });
    kernel.registry.register({
      id: 'admin.wipe',
      title: '受限',
      description: '需要 admin。',
      category: 'admin',
      kind: 'action',
      permissions: ['admin'],
      inputSchema: kernel.registry.get('records.query')!.inputSchema,
      outputSchema: kernel.registry.get('records.query')!.outputSchema,
      handler: async () => ({ output: { records: [], count: 0 } }),
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain('admin__wipe');
  });
});

describe('resources 投影（U3，RFC-0010：ResourcePort → resources/list + resources/read）', () => {
  it('resources/list ≡ ResourcePort.list 投影（uri 方案 + _meta 剖面直通）', async () => {
    const { client, kernel } = await setup({ withResources: true });
    const { resources } = await client.listResources();
    expect(resources).toHaveLength(1);
    const r = resources[0];
    expect(r.uri).toBe(`${RESOURCE_URI_PREFIX}demo.pois`);
    expect(r.name).toBe('demo.pois');
    expect(r.mimeType).toBe('application/json');
    // 平价：与 kernel 端口 list 的描述符一致
    const [d] = await kernel.resources!.list();
    expect(r.title).toBe(d.title);
    expect((r._meta as { countHint: number }).countHint).toBe(3);
    expect((r._meta as { meta: { crs: string } }).meta.crs).toBe('local-planar');
  });

  it('resources/read：有界首页 JSON（与 kernel 端口 query 平价）；未知 uri 报错', async () => {
    const { client, kernel } = await setup({ withResources: true });
    const read = await client.readResource({ uri: `${RESOURCE_URI_PREFIX}demo.pois` });
    const content = read.contents[0] as { uri: string; text: string };
    const parsed = JSON.parse(content.text);
    const direct = await kernel.resources!.query('demo.pois', {
      page: { offset: 0, limit: 100 },
    });
    expect(parsed).toEqual(JSON.parse(JSON.stringify(direct)));
    expect(parsed.items).toHaveLength(3);
    expect(parsed.hasMore).toBe(false);

    await expect(client.readResource({ uri: 'sar://resource/nope' })).rejects.toThrow();
  });

  it('无数据面宿主：resources/list 为空（诚实缺席而非报错）', async () => {
    const { client } = await setup();
    const { resources } = await client.listResources();
    expect(resources).toEqual([]);
  });
});
