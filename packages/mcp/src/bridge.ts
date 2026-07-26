/**
 * MCP-in 桥（阶段四 U5-B，RFC-0012 §二）：把外部 MCP server 的 tools **挂载为能力包**
 * ——从此外部地理工具（geocoder/路由/别家 STAC）也过同一漏斗：权限裁剪、审计归因、
 * guardrails、审批门全部生效。「通用性的最大来源不是自己写几百个能力，而是让别人的
 * 工具进你的治理体系。」
 *
 * 信任边界：
 * - 外部 inputSchema 是**不可信 JSON Schema**——不反推 Zod：入参用宽松对象透传校验，
 *   目录投影经 `inputJsonSchemaOverride` 直挂外部原文（模型侧看到真形状）；
 * - effects 保守缺省 `{ state:'none', external:'write', approval:'policy' }`——
 *   外部世界读写未知，宁可保守；宿主按工具显式降级（如纯查询 → external:'read'）；
 * - 命名空间隔离：`mcp.<namespace>.<tool>`（`.`↔`__` 双射照旧）。
 */
import { z } from 'zod';
import type { Capability, CapabilityPack, EffectDescriptor } from '@geoverse-sar/kernel';

/** 桥所需的最小 MCP 客户端面（SDK Client 结构兼容；测试可用假实现）。 */
export interface McpToolClient {
  listTools(): Promise<{
    tools: {
      name: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
    }[];
  }>;
  callTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<unknown>;
}

export interface CreateMcpCapabilityPackOptions {
  /** 命名空间（进能力 id：`mcp.<namespace>.<tool>`）；字符集 [A-Za-z0-9_-]。 */
  namespace: string;
  /** 按工具覆写 effects（如纯查询 geocoder → { external:'read', approval:'never' }）。 */
  effects?: Record<string, Partial<EffectDescriptor>>;
  /** 应用到全部桥接能力的权限点（目录裁剪与 invoke 强制同一判定）。 */
  permissions?: readonly string[];
}

const NAMESPACE_RE = /^[A-Za-z0-9_-]+$/;

/** 宽松透传校验：结构上是对象即可——真形状由外部 schema 表达（描述符直挂）。 */
const passthroughInput = z.object({}).catchall(z.unknown());
const bridgeOutput = z.object({
  content: z.string().describe('外部工具返回的文本内容（多段拼接）'),
});

function textOf(result: unknown): { text: string; isError: boolean } {
  const r = result as {
    content?: { type?: string; text?: string }[];
    isError?: boolean;
  };
  const text = (r.content ?? [])
    .map((c) => (typeof c.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('\n');
  return { text, isError: r.isError === true };
}

/**
 * 把外部 MCP server 的工具目录挂载为能力包（listTools 异步，故工厂异步）。
 * 目录是挂载时刻的快照——外部服务后续增删工具需重建包（刻意：目录稳定性优先）。
 */
export async function createMcpCapabilityPack(
  client: McpToolClient,
  options: CreateMcpCapabilityPackOptions,
): Promise<CapabilityPack> {
  if (!NAMESPACE_RE.test(options.namespace)) {
    throw new Error(
      `MCP 桥命名空间含非法字符（允许 [A-Za-z0-9_-]）: ${options.namespace}`,
    );
  }
  const { tools } = await client.listTools();
  const capabilities: Capability[] = tools.map((tool) => {
    const id = `mcp.${options.namespace}.${tool.name}`;
    return {
      id,
      title: `外部工具 ${tool.name}`,
      description:
        (tool.description?.trim() ||
          `外部 MCP 工具 ${tool.name}（服务方未提供说明——谨慎使用）`) +
        `（经 MCP 桥接自 ${options.namespace}，外部执行）`,
      category: 'mcp',
      kind: 'action',
      tags: ['mcp', options.namespace],
      since: '2026-07-27',
      // 保守缺省：外部世界读写未知——external:'write' + 交宿主策略审批；
      // 宿主经 options.effects[tool] 显式降级，不做自动推断（宁可保守不猜）。
      effects: {
        state: 'none',
        external: 'write',
        approval: 'policy',
        idempotency: 'none',
        ...options.effects?.[tool.name],
      },
      ...(options.permissions ? { permissions: options.permissions } : {}),
      inputSchema: passthroughInput,
      outputSchema: bridgeOutput,
      ...(tool.inputSchema ? { inputJsonSchemaOverride: tool.inputSchema } : {}),
      handler: async (_ctx, input) => {
        const result = await client.callTool({
          name: tool.name,
          arguments: input as Record<string, unknown>,
        });
        const { text, isError } = textOf(result);
        if (isError) {
          throw new Error(`外部工具 ${tool.name} 返回错误: ${text || '（无详情）'}`);
        }
        return { output: { content: text } };
      },
    };
  });
  return { id: `mcp-${options.namespace}`, capabilities };
}
