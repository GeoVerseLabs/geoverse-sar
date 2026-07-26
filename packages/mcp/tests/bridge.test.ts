/**
 * U5-B MCP-in 桥：外部工具挂载为能力包——同一漏斗治理的平价证据：
 * 事件/审计帧与本地能力同构、权限裁剪同判定、外部 schema 直挂描述符、
 * effects 保守缺省+显式降级、isError 结构化上抛。
 */
import { describe, expect, it } from 'vitest';
import {
  createAuditLog,
  createKernel,
  type SarEvent,
  type SarKernel,
} from '@geoverse-sar/kernel';
import {
  InMemoryStateEngine,
  RecordDiffAlgebra,
  type RecordDiff,
  type RecordEntity,
} from '@geoverse-sar/engine-memory';
import { createMcpCapabilityPack, type McpToolClient } from '../src/index';

const EXTERNAL_SCHEMA = {
  type: 'object',
  properties: { place: { type: 'string', description: '地名' } },
  required: ['place'],
};

function fakeMcpClient(): McpToolClient & { calls: { name: string; args: unknown }[] } {
  const calls: { name: string; args: unknown }[] = [];
  return {
    calls,
    async listTools() {
      return {
        tools: [
          {
            name: 'geocode',
            description: '地名转坐标（外部只读查询）。',
            inputSchema: EXTERNAL_SCHEMA,
          },
          { name: 'publish', description: '把数据发布到外部门户。' },
          { name: 'flaky' },
        ],
      };
    },
    async callTool({ name, arguments: args }) {
      calls.push({ name, args });
      if (name === 'geocode') {
        return { content: [{ type: 'text', text: '{"x":118.1,"y":24.5}' }] };
      }
      if (name === 'flaky') {
        return { content: [{ type: 'text', text: '上游超时' }], isError: true };
      }
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  };
}

async function setup(permissions?: readonly string[]): Promise<{
  kernel: SarKernel<RecordEntity, RecordDiff>;
  client: ReturnType<typeof fakeMcpClient>;
  audit: ReturnType<typeof createAuditLog>;
}> {
  const client = fakeMcpClient();
  const pack = await createMcpCapabilityPack(client, {
    namespace: 'demo',
    effects: { geocode: { external: 'read', approval: 'never', idempotency: 'keyed' } },
    ...(permissions ? { permissions } : {}),
  });
  const audit = createAuditLog();
  const kernel = createKernel<RecordEntity, RecordDiff>({
    engine: new InMemoryStateEngine([]),
    algebra: new RecordDiffAlgebra(),
    packs: [pack],
    middleware: [audit.middleware],
  });
  return { kernel, client, audit };
}

describe('createMcpCapabilityPack', () => {
  it('挂载目录：命名空间 id、外部 schema 直挂描述符、effects 保守缺省+显式降级', async () => {
    const { kernel } = await setup();
    const ids = kernel.describeAll().map((d) => d.id);
    expect(ids.sort()).toEqual([
      'mcp.demo.flaky',
      'mcp.demo.geocode',
      'mcp.demo.publish',
    ]);

    const geocode = kernel.registry.describe('mcp.demo.geocode');
    expect(geocode.inputJsonSchema).toEqual(EXTERNAL_SCHEMA); // 不可信 schema 原文直挂，不反推 Zod
    expect(geocode.effects).toMatchObject({ external: 'read', approval: 'never' });

    const publish = kernel.registry.describe('mcp.demo.publish');
    expect(publish.effects).toMatchObject({
      external: 'write',
      approval: 'policy',
      state: 'none',
    }); // 保守缺省：外部读写未知按外部写对待
  });

  it('同一漏斗平价：invoke 事件/审计帧与本地能力同构；参数原样透传外部', async () => {
    const { kernel, client, audit } = await setup();
    const frames: string[] = [];
    kernel.events.on((e: SarEvent) => frames.push(e.type));

    const out = await kernel.invoke<{ content: string }>('mcp.demo.geocode', {
      place: '厦门',
    });
    expect(out.ok).toBe(true);
    expect(JSON.parse(out.output!.content)).toEqual({ x: 118.1, y: 24.5 });
    expect(client.calls[0]).toEqual({ name: 'geocode', args: { place: '厦门' } });
    // 帧序列与本地能力同栈同构（invoke:start → invoke:end；action 无 engine 事务帧）
    expect(frames).toEqual(['invoke:start', 'invoke:end']);
    const entry = audit.entries().find((e) => e.capabilityId === 'mcp.demo.geocode');
    expect(entry).toMatchObject({ ok: true, entry: 'program' });
  });

  it('外部 isError → handler_error 结构化上抛（模型可自纠）；审计记失败', async () => {
    const { kernel, audit } = await setup();
    const out = await kernel.invoke('mcp.demo.flaky', {});
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('handler_error');
    expect(out.error?.message).toContain('上游超时');
    expect(audit.entries().find((e) => e.capabilityId === 'mcp.demo.flaky')?.ok).toBe(
      false,
    );
  });

  it('权限裁剪同判定：无授权调用方看不见也调不动（与本地能力一致）', async () => {
    const { kernel } = await setup(['external:call']);
    const restricted = { entry: 'ai' as const, grantedPermissions: [] };
    expect(kernel.describeAll({ caller: restricted })).toHaveLength(0);
    const denied = await kernel.invoke(
      'mcp.demo.geocode',
      { place: 'x' },
      { caller: restricted },
    );
    expect(denied.error?.code).toBe('permission_denied');

    const granted = await kernel.invoke(
      'mcp.demo.geocode',
      { place: 'x' },
      { caller: { entry: 'ai', grantedPermissions: ['external:call'] } },
    );
    expect(granted.ok).toBe(true);
  });

  it('非法命名空间拒绝', async () => {
    await expect(
      createMcpCapabilityPack(fakeMcpClient(), { namespace: 'bad.ns' }),
    ).rejects.toThrow(/非法字符/);
  });
});
