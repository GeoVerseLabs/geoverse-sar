# planner：NL→能力路由、流式进度与无头 UI（M3）

`@geoverse-sar/planner` 把 AI Copilot 入口从「示例代码」升级为「可复用单元」。分层承诺不变：**内核 NL-free**——自然语言→工具的映射只发生在 planner 与 LLM 之间；planner 只依赖 `kernel` + `skill`（ESLint 依赖门强制）。

```
用户 NL ──▶ planner（tool-use 循环）──▶ LlmClient（provider 端口）
                │  目录：kernel.describeAll → toToolSpecs（权限裁剪同源）
                └─ 回灌：handleToolCall → 单一 invoke 漏斗（caller.entry='ai'）
```

## 最小可跑（Node，任意 OpenAI 兼容端点）

```ts
import { clientOf } from '@geoverse-sar/kernel';
import {
  createPlanner,
  createOpenAiCompatClient,
  createChatController,
} from '@geoverse-sar/planner';

// T12 起 planner 依赖 SarClient 切面：身份构造绑定（本地 clientOf；远程由服务端注入）
const planner = createPlanner(clientOf(kernel, { entry: 'ai' }), {
  client: createOpenAiCompatClient({
    url: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-chat',
    headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
  }),
  system: '你是空间数据助手。先查后写；多步组合优先 workflow 工具。',
});

const result = await planner.run('把所有 poi 高亮并右移 15，一次完成');
// 模型自主路由到 workflow__highlightAndNudge → 宏撤销一个单元
```

浏览器场景密钥不进前端：走 dev 代理注入 Authorization（见 [entries.md](./entries.md) 的密钥代理模式），`url` 换 `/api/deepseek/chat/completions` 即可。

## 目录收窄（CatalogSelector，U0-6）

目录大到超出 LLM 工具列表舒适区（≈40）时，传 `catalogSelector` 按 goal 收窄 top-k——**不要**把能力清单写进 system prompt（目录仍每 run 动态重取，权限变化即时生效）：

```ts
import { createHeuristicSelector } from '@geoverse-sar/planner';

const planner = createPlanner(sarClient, {
  client,
  catalogSelector: createHeuristicSelector({ limit: 40 }),
});
```

三条纪律：收窄发生在**裁剪后**目录上（权限外能力结构性进不来）；`runtime` 分类元能力恒被钉住——模型拿到收窄子集后仍能经 `catalog.search` 自己找回长尾工具（分层披露）；selector 抛异常退回全量目录（收窄是优化不是门禁）。

检索版（U5-E）：`createKbSelector(kb, { limit })` 用 kb 检索端口替换关键词计分——`kb` 只需结构满足 `search(query, { limit }) → { id, score }[]`（evolution 的 `createMemoryKb` 天然兼容，生产可换真向量库，选择器零改动）；kb 命中先与目录求交（**输出恒为裁剪后目录的子集**，kb 里的陈旧/越权条目漏不进来），召回不足按目录序补齐。`catalogKbDocs(catalog)` 把描述符投成 kb 文档（宿主摄取入口）：

```ts
import { catalogKbDocs, createKbSelector } from '@geoverse-sar/planner';
import { createMemoryKb } from '@geoverse-sar/evolution';

const kb = createMemoryKb(catalogKbDocs(await sarClient.catalog()));
const planner = createPlanner(sarClient, {
  client,
  catalogSelector: createKbSelector(kb),
});
```

## prompt profile（U5-D）

能力包作者可随包携带「用法要点」（`CapabilityPack.promptProfile`，`PackPromptProfile{packId, usageNotes?, fewShot?}`），宿主装配时收集传给 `profiles`，**构造期**拼进 system：

```ts
const planner = createPlanner(sarClient, {
  client,
  profiles: [recordsPack.promptProfile!].filter(Boolean),
});
```

边界（超限构造即抛）：只写"何时怎么用"的经验层，**不复述目录/schema**（那是描述符投影的职责）；usageNotes ≤ 800 字；few-shot ≤ 3 条。不传 `profiles` 时 system 与既往**逐字节一致**（回归零影响）。

## 流式进度（PlannerEvent）

`run(text, { onEvent })` 按发生顺序回调：

| 事件          | 含义                                                    |
| ------------- | ------------------------------------------------------- |
| `round:start` | 第 N 轮补全开始（一轮=一次 LLM 请求，可含多个工具调用） |
| `text:delta`  | 正文流式增量（SSE；客户端不支持流式则无）               |
| `assistant`   | 一轮正文定稿（终稿覆盖增量拼接）                        |
| `tool:call`   | 模型发起调用：`{ name, capabilityId, args, argsRaw }`   |
| `tool:result` | 回灌结果：`{ ok, content }`（失败 content 带 hint）     |
| `run:end`     | 收束：`{ ok, rounds, stopReason }`                      |

收束原因 `stopReason`：`completed`（正文收束）/ `max_rounds`（轮数用尽）/ `aborted`（`signal` 中止）/ `error`（client 抛错）。`dryRun: true` 时所有写调用只出 diff 不落地（AI 预览门）。

## 无头 UI 绑定（createChatController）

框架无关的订阅式时间线投影——事件流折叠成 `{ items, busy }`，流式正文在同一条 `ChatItem` 上增长（`streaming: true`）：

```ts
const controller = createChatController(planner);
controller.subscribe((s) => {
  bubbles.value = s.items.map((i) => ({ ...i })); // Vue：浅拷贝触发响应
  busy.value = s.busy;
});
await controller.send('撤销刚才的操作');
controller.abort();
```

playground 的 `/chat.html`（内存 records 域）与 `/geo.html`（真地图 geo 域）共用同一装配函数（`createDeepSeekChat(kernel, system)`），差异只有 kernel 与系统提示——「AI Copilot 作入口」跑通的活样板。

会话恢复（T6b，配 workspace conversations 快照）：`createPlanner(sar, { history })` 恢复模型上下文、`createChatController(planner, { items })` 恢复时间线展示面——两份快照配对存取（run 落定时保存，启动时读出），`/chat.html` 即样板（装配在 main.ts 顶层 await，恢复先于挂载）。

## 测试策略

LLM 非确定性隔离在 `LlmClient` 端口之外：单测用**脚本化假 client**（按序吐预设回合）钉死路由、事件序、宏撤销、dryRun、abort、max_rounds；SSE 解析用 mock fetch + `ReadableStream` 钉死跨 chunk 断行与 tool_calls 增量归并。真实 LLM 只做冒烟（断言失败先重跑）。
