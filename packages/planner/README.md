# @geoverse-sar/planner

NL→能力路由 planner（RFC-0008 M3）：把「自然语言 → 工具选择 → 回灌执行」的 tool-use 循环打包成可复用单元，并带**流式进度事件**与**无头 UI 绑定**。内核保持 NL-free——自然语言只存在于本包与 LLM 之间。

```shell
pnpm add @geoverse-sar/planner @geoverse-sar/skill @geoverse-sar/kernel
```

依赖方向（ESLint 强制）：planner 只准依赖 `kernel` 与 `skill`——能力目录经 `client.catalog()`/`toToolSpecsOf` 投影获得，执行经 `handleToolCallVia` 回灌单一 invoke 漏斗，不碰引擎/能力实现。**T12 起入参是 `SarClient` 切面**：身份在 client 构造处绑定（本地 `clientOf(kernel, { entry: 'ai' })`、远程由服务端注入），目录异步化为远程化铺路。

## createPlanner——NL→能力路由

```ts
import { clientOf } from '@geoverse-sar/kernel';
import { createPlanner, createOpenAiCompatClient } from '@geoverse-sar/planner';

const client = createOpenAiCompatClient({
  url: '/api/deepseek/chat/completions', // 浏览器：dev 代理注入密钥；Node：headers 直给
  model: 'deepseek-chat',
});
const planner = createPlanner(clientOf(kernel, { entry: 'ai' }), {
  client,
  system: '业务口吻…',
  maxRounds: 8,
});

const result = await planner.run('把所有 poi 高亮并右移 15', {
  onEvent: (e) => {
    /* round:start | text:delta | assistant | tool:call | tool:result | run:end */
  },
  signal: aborter.signal, // 可中止
  dryRun: true, // AI 预览门：写调用只出 diff 不落地
});
// result: { ok, stopReason: 'completed'|'max_rounds'|'aborted'|'error', text, rounds, toolCallCount }
```

- **目录即 describeAll**：每次 `run` 重投影工具目录，注册/权限变化即时生效；`toolSpecs.caller` 可做权限化裁剪（模型看不见即调不到）。
- **失败自纠**：工具失败 content 自动带 `explainError` 的 hint（skill 层行为），以 `ERROR:` 前缀回灌。
- `history` 跨 run 持续（provider 中立格式），`reset()` 清空。

## LlmClient——provider 端口（零 SDK）

```ts
interface LlmClient {
  complete(
    req: { system; messages; tools },
    opts?: { signal?; onTextDelta? },
  ): Promise<{ text; toolCalls }>;
}
```

内置 `createOpenAiCompatClient`（DeepSeek/Kimi/vLLM 等同协议直用；`stream: true` 默认走 SSE，正文增量经 `onTextDelta` 逐段回吐，`tool_calls` 增量按 index 跨片归并）。其他 provider（Claude Messages API 等）自实现该接口即可。测试用脚本化假 client——LLM 的非确定性被隔离在端口之外。

## createChatController——无头 UI 绑定

```ts
import { createChatController } from '@geoverse-sar/planner';

const controller = createChatController(planner);
controller.subscribe((s) => render(s)); // { items: ChatItem[], busy }——订阅即回放当前态
await controller.send('撤销刚才的操作');
controller.abort(); // 中止进行中的 run
controller.clear(); // 清时间线 + 会话历史
```

`ChatItem` 时间线含用户消息、流式 assistant 正文（`streaming: true` 增量增长）、工具调用/结果轨迹（`detail` 载荷）与错误项——Vue/React/原生 DOM 只需浅拷贝渲染。playground 的 `/chat.html` 与 `/geo.html` 均由它驱动（见 `examples/playground/src/chat/llm.ts`，装配仅 ~20 行）。
