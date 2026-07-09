# @geoverse-sar/mcp

SAR 的 **MCP 入口**：把内核能力目录暴露为 MCP 工具（`tools/list`），把 `tools/call` 路由回单一 invoke 漏斗。外部 MCP 客户端（Claude Desktop / Claude Code / 任何 MCP host）由此经同一 Runtime 读写空间数据——与 UI/AI 入口完全平价。

```shell
pnpm add @geoverse-sar/mcp @geoverse-sar/kernel
```

## 用法

```ts
import { createSarMcpServer, connectStdio } from '@geoverse-sar/mcp';

const server = createSarMcpServer(kernel, { name: 'geoverse-sar', version: '0.1.0' });
await connectStdio(server); // stdio 传输，供 MCP host 拉起
```

MCP host 配置示例（Claude Code `.mcp.json` / Claude Desktop 同形）：

```json
{
  "mcpServers": {
    "geoverse-sar": { "command": "node", "args": ["path/to/your-sar-server.mjs"] }
  }
}
```

## 实现要点

- `tools/list` **直投**内核已派生的 `inputJsonSchema`（用 MCP SDK 低层 `Server` 而非 `McpServer`，避开 SDK 内置 zod v3 与本仓 zod v4 的互操作问题）。
- `tools/call` 复用 `@geoverse-sar/skill` 的 `handleToolCall`，`caller.entry='mcp'` 进统一事件流（人机同栈观测），错误带 `hint` 自纠提示。
- 测试用 `InMemoryTransport.createLinkedPair()` + 官方 `Client` 做真回环——"外部 MCP 客户端经同一 runtime 编辑"是 M2 验收项。

多入口对照与更多示例见 [入口指南](../../docs/entries.md)。
