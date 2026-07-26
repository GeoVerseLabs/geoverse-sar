import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallerInfo, SarKernel } from '@geoverse-sar/kernel';
import { handleToolCall, toToolSpecs } from '@geoverse-sar/skill';

/** MCP resources 投影的 uri 方案（RFC-0010）：sar://resource/<id>。 */
export const RESOURCE_URI_PREFIX = 'sar://resource/';

/** resources/read 单次回包的条数上限（读端有界；更多经 hasMore 明示）。 */
const READ_LIMIT = 100;

export interface CreateSarMcpServerOptions {
  name?: string;
  version?: string;
  /** MCP 主体身份与权限（describeAll 目录裁剪 + invoke 强制同一判定）。 */
  caller?: CallerInfo;
}

export const MCP_CALLER: CallerInfo = { entry: 'mcp' };

/**
 * MCP 入口（RFC-0008 §4.4）：零领域逻辑的描述符投影 + 回灌路由。
 * - `tools/list` ≡ `toToolSpecs`（与 AI 技能/UI 面板同一份 inputJsonSchema——schema 平价）；
 * - `tools/call` → `handleToolCall` → 单一 invoke 漏斗（`caller.entry='mcp'`）。
 * 外部 MCP 客户端由此经同一 Runtime 读写状态：与 UI 点击/进程内 Copilot 完全平价。
 */
export function createSarMcpServer(
  kernel: SarKernel,
  opts: CreateSarMcpServerOptions = {},
): Server {
  const caller = opts.caller ?? MCP_CALLER;
  const server = new Server(
    { name: opts.name ?? 'geoverse-sar', version: opts.version ?? '0.1.0' },
    // resources（U3，RFC-0010）：MCP 本就有 tools/resources 两个面——
    // ResourcePort 是 resources 的天然投影（一份描述符、多入口投影的配方延续）
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toToolSpecs(kernel, { caller }).map((spec) => ({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.input_schema,
    })),
  }));

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const descriptors = kernel.resources ? await kernel.resources.list() : [];
    return {
      resources: descriptors.map((d) => ({
        uri: `${RESOURCE_URI_PREFIX}${d.id}`,
        name: d.id,
        title: d.title,
        description: d.description,
        mimeType: 'application/json',
        ...(d.meta || d.schemaSummary || d.countHint !== undefined
          ? {
              _meta: {
                ...(d.schemaSummary ? { schemaSummary: d.schemaSummary } : {}),
                ...(d.countHint !== undefined ? { countHint: d.countHint } : {}),
                ...(d.meta ? { meta: d.meta } : {}),
              },
            }
          : {}),
      })),
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    if (!kernel.resources || !uri.startsWith(RESOURCE_URI_PREFIX)) {
      throw new Error(`资源不存在: ${uri}`);
    }
    const id = uri.slice(RESOURCE_URI_PREFIX.length);
    // 读端有界：只取首页，hasMore 明示还有更多（全量倾倒不是 read 的职责）
    const result = await kernel.resources.query(id, {
      page: { offset: 0, limit: READ_LIMIT },
    });
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(result),
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const result = await handleToolCall(
      kernel,
      req.params.name,
      req.params.arguments ?? {},
      {
        caller,
      },
    );
    return {
      content: [{ type: 'text', text: result.content }],
      isError: result.is_error,
    };
  });

  return server;
}

/** stdio 传输便捷启动（宿主进程装配 kernel 后调用）。 */
export async function connectStdio(server: Server): Promise<void> {
  await server.connect(new StdioServerTransport());
}

// MCP-in 桥（U5-B）：外部 MCP 工具 → 能力包（同一漏斗治理）
export {
  createMcpCapabilityPack,
  type CreateMcpCapabilityPackOptions,
  type McpToolClient,
} from './bridge';
