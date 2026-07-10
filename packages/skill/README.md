# @geoverse-sar/skill

SAR 的 **AI 入口**：把内核能力目录投影成 LLM 工具规格（`toToolSpecs`），把模型的 tool call 路由回单一 invoke 漏斗（`handleToolCall`）。零 LLM SDK 依赖——只做形状转换与路由，进程内 tool-use 循环由宿主实现。

```shell
pnpm add @geoverse-sar/skill @geoverse-sar/kernel
```

## 核心事实

- **`CapabilityDescriptor ≡ Claude 工具定义`**：`id≡name`、`description≡description`、`inputJsonSchema≡input_schema`。同一份投影也背 UI 面板（`toPaletteItems`）与 MCP `tools/list`——schema 平价是"一个运行时多入口"的根基。
- **工具名双射**：Claude tool name 不允许 `.`，`toToolName('records.query') === 'records__query'`；`handleToolCall` 兼容两种写法。
- **is_error 自纠回灌**：失败时 `content` 是结构化 JSON `{ error, issues, hint }`——`hint` 由内核 `explainError` 生成（逐条参数指引 / 相似能力建议 / 装配问题指向 doctor），实测能显著提高模型一次自纠成功率。
- **dryRun**：`handleToolCall(kernel, name, args, { dryRun: true })` 返回"将改什么"的 diff、不落状态——AI 预览/人审门。

## 用法（任意 OpenAI 兼容 / Claude tool-use 循环）

```ts
import { toToolSpecs, handleToolCall } from '@geoverse-sar/skill';

const tools = toToolSpecs(kernel); // → Claude tools 数组
// OpenAI 兼容侧：{ type:'function', function:{ name, description, parameters: spec.input_schema } }

// 模型回了 tool call：
const result = await handleToolCall(kernel, call.name, JSON.parse(call.arguments));
// → { content: string, is_error: boolean, outcome: InvokeOutcome }
// content 作为 tool_result 回灌；is_error=true 时模型读 hint 自纠
```

权限化目录裁剪：`toToolSpecs(kernel, { caller: { entry: 'ai', grantedPermissions: [...] } })`——模型看不见即调不到。

**client 版（T12/R6，planner/agent 用它）**：`toToolSpecsOf(await client.catalog())` 纯投影目录数组；`handleToolCallVia(client, name, args, { catalog })` 经 `SarClient.invoke` 回灌——caller 已在 client 构造绑定，`catalog` 供工具名消歧与失败 hint 的相似建议。本地/远程 client 共用同一实现。

端到端示例（DeepSeek 真实对话 + 密钥代理模式）见 `examples/playground` 的 `/chat.html` 与 [入口指南](../../docs/entries.md)。
