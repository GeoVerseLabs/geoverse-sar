import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { CallerInfo, SarKernel } from '@geoverse-sar/kernel';
import { handleToolCall, toToolSpecs } from '@geoverse-sar/skill';

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
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toToolSpecs(kernel, { caller }).map((spec) => ({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.input_schema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const result = await handleToolCall(kernel, req.params.name, req.params.arguments ?? {}, {
      caller,
    });
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
