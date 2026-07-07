# 四个入口：同一 Runtime 的不同面孔

入口层零领域逻辑：只做**描述符投影**（出目录）+ **回灌路由**（回漏斗）。四个入口共享一个 kernel，`caller.entry` 区分来源，事件流人机同栈。

## 1. 程序化（entry: 'program'）

```ts
const out = await kernel.invoke('records.translate', { ids: ['a'], dx: 3, dy: 4 });
// out: { ok, output, diff?, issues?, error?, durationMs }
await kernel.invoke('records.translate', input, { dryRun: true });   // 只看 diff 不落地
```

## 2. UI 命令面板（entry: 'ui'）

```ts
const items = kernel.toPaletteItems();   // [{ id, title, description, kind, undoable, inputJsonSchema }]
// inputJsonSchema 驱动表单；提交即 invoke(id, formValue, { caller: { entry: 'ui' } })
```

与 AI 工具规格**同源**（同一份 JSON Schema）——schema 平价有快照测试钉死。

## 3. AI（entry: 'ai'）——LLM tool-use 循环

```ts
import { toToolSpecs, handleToolCall } from '@geoverse-sar/skill';

const tools = toToolSpecs(kernel);   // Claude: 原样作 tools；OpenAI 兼容: 包一层 function
// 循环：模型出 tool_calls → 逐条回灌：
const res = await handleToolCall(kernel, call.name, args);
messages.push({ role: 'tool', tool_call_id: call.id,
  content: res.is_error ? `ERROR: ${res.content}` : res.content });
```

- 失败 content 含 `{ error, issues, hint }`——`hint` 是可操作提示（参数逐条指引/相似能力建议），模型读后自纠。
- 工具名双射：`records.query` ↔ `records__query`（Claude tool name 不允许 `.`）。
- **密钥管理（浏览器场景）**：密钥永不进前端。playground 的做法——`.env` 放仓根（gitignored），vite dev 代理注入：

```ts
// vite.config.ts
const env = loadEnv(mode, envDir, '');
server: { proxy: { '/api/deepseek': {
  target: 'https://api.deepseek.com', changeOrigin: true,
  rewrite: (p) => p.replace(/^\/api\/deepseek/, ''),
  headers: { Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
}}}
// 浏览器只 fetch('/api/deepseek/chat/completions')，无 Authorization
```

tool-use 循环已打包成 `@geoverse-sar/planner`（M3：`createPlanner` NL→能力路由 + 流式进度事件 + 无头聊天控制器，见 [planner.md](./planner.md)）——playground 两个 LLM 页面的装配只剩 ~20 行（`examples/playground/src/chat/llm.ts`）。系统提示词写法要点：告知模型"先查后写、写可 undo、多步优先用 workflow 工具"。

## 4. MCP（entry: 'mcp'）——外部 agent/客户端

```ts
import { createSarMcpServer, connectStdio } from '@geoverse-sar/mcp';
await connectStdio(createSarMcpServer(kernel, { name: 'geoverse-sar', version: '0.1.0' }));
```

Claude Desktop / Claude Code 等 MCP host 配 `command` 拉起后，`tools/list` 看到与其他入口完全一致的目录，`tools/call` 走同一漏斗。

## 5. 自治 Agent（entry: 'agent'）——M4

```ts
import { createAgent, createLlmPolicy } from '@geoverse-sar/agent';
const agent = createAgent(kernel, { policy, maxSteps, caller: { entry: 'agent', id }, approve });
await agent.run('目标…', { signal, onEvent });
```

observe→plan→act 循环 + 审批门（写动作 dryRun 预览过审）；动作仍经 `handleToolCall` 回灌同一漏斗——治理（权限/审计/中止）由内核承担。详见 [agent.md](./agent.md)。

## 跨入口平价（核心承诺）

同参数在任何入口产生**相同 diff、相同 output、相同引擎终态**——`invoke ≡ handleToolCall ≡ MCP tools/call`。这不是巧合而是结构：入口不含业务逻辑，全部行为收敛在漏斗内。skill/mcp 包的测试用双 kernel 对照钉死这一点。

## 权限：目录裁剪 + 调用强制

```ts
const caller = { entry: 'ai', grantedPermissions: ['records:read'] } as const;
toToolSpecs(kernel, { caller });                    // 模型看不见未授权能力
await kernel.invoke('records.remove', x, { caller }); // 即使硬调也 permission_denied
```

两处用同一判定（`isGranted`），"看不见"与"调不到"不会脱节。
