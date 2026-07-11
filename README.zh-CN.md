# GeoVerse SAR — 空间应用运行时

[English](./README.md) | **简体中文**

建在 GeoVerse SDK 之上的 AI-native 空间应用运行时，严格的端口-适配器（六边形）架构：**内核不知道"地图"是什么**。

> 状态：RFC-0008 的架构里程碑 M1~M4 已全部完成（145 个单元测试；AI Copilot 入口与自治 Agent 入口均通过真实 LLM 端到端验收）。各包**尚未发布 npm**——参见[从源码开发](#从源码开发)。

## 为什么是 SAR

多数 Agent 框架编排的是**对话**，SAR 编排的是**应用状态**——并把人类 UI、AI Copilot、自治 Agent、外部 MCP 客户端当作**同一个运行时的不同入口**：

- **一切能力注册成 Capability**——Zod 自描述、可发现、可调用、可组合。能力描述符**就是** Claude/MCP 工具定义（`id ≡ name`、`inputJsonSchema ≡ input_schema`）——同一份投影背起 UI 命令面板、AI 工具目录与 MCP `tools/list`。
- **一切操作走单一漏斗**——`dispatcher.invoke`：中间件洋葱 → 权限 → 服务校验 → Zod 校验 → handler → 写路由 → 事件。UI 点击、AI 调用、MCP 调用只差一个 `caller.entry`。**跨入口平价由测试钉死**，不靠约定。
- **领域状态的撤销是一等公民**——引擎经通用 diff 端口接入（`StateEngine<TEntity, TDiff>` + `DiffAlgebra{merge, invert, apply}`）；工作流把多步 diff 预合并成**一个撤销单元**（宏撤销），引擎零改动。
- **写操作可预览**——`dryRun` 返回"将改什么"的 diff 而不落地；agent 的审批门把这份 diff 交给人审后才执行。
- **治理长在内核，不长在 agent 循环里**——权限白名单同时裁剪目录与强制调用（同一判定）；`createAuditLog` 对所有入口全量入账；`AbortSignal` 贯穿漏斗（写路由前兜底，无半途落地）；`createJournal`/`replayJournal` 持久化并回放事务历史，终态**与撤销粒度**精确复现。
- **自然语言不进内核**——NL 路由在 `planner`/`agent` 包，隔离在 provider 无关端口（`LlmClient`、`AgentPolicy`）之外；145 个测试没有一个依赖真实 LLM。

## 架构

```
入口层（零领域逻辑：投影目录、回灌路由）
  program（kernel.invoke）· ui（toPaletteItems）· ai（skill）· planner（M3）· agent（M4）· mcp
        │                        caller.entry 区分来源；事件流人机同栈
        ▼
@geoverse-sar/kernel（只依赖 zod——ESLint 依赖方向门强制）
  Capability / Registry        read | write | action 三态
  Dispatcher 单漏斗             中间件 → 权限 → 校验 → handler → 写路由
  Workflow + TransactionGroup  步间数据流 + 宏撤销
  治理                          AbortSignal · 权限 · 审计 · 事务日志回放
  自检                          runDoctor 装配体检 · ErrorMonitor · explainError hint
        │   内核唯一认识的抽象：StateEngine<TEntity, TDiff> + DiffAlgebra
        ▼
引擎层    engine-memory（参考实现）· engine-geo（包 @geoverse/editor-core，零改动）
能力层    capabilities-records（内存记录域）· capabilities-geo（GeoJSON 要素域）
```

## 包清单

| 包                                                                      | 职责                                                                             | 测试 |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---- |
| [`@geoverse-sar/kernel`](./packages/kernel)                             | 纯机制内核：能力/单漏斗/工作流/宏撤销/权限/doctor/审计/journal/store/`SarClient` | 123  |
| [`@geoverse-sar/workspace`](./packages/workspace)                       | 生命周期组装：`openWorkspace`——恢复（快照+journal tail）/checkpoint/单写者锁     | 26   |
| [`@geoverse-sar/server`](./packages/server)                             | 服务形态（Node-only）：HTTP+WS 薄层——wire=`InvokeOutcome`、token→`CallerInfo`    | 17   |
| [`@geoverse-sar/evolution`](./packages/evolution)                       | 自进化起步：L2 workflow 合成（挖掘→起草→干跑验证→审批→注册）/知识端口/摄取原型   | 10   |
| [`@geoverse-sar/otel`](./packages/otel)                                 | OpenTelemetry 导出器（可选）：invoke 中间件 span + workflow/事务事件桥，BYO SDK  | 2    |
| [`@geoverse-sar/engine-memory`](./packages/engine-memory)               | 参考引擎 + diff 代数（fast-check 代数律）                                        | 11   |
| [`@geoverse-sar/engine-geo`](./packages/engine-geo)                     | GeoVerse 适配器：零改动包裹 `EditEngine` + 双通道 `ChangeSetAlgebra` + 几何桥    | 8    |
| [`@geoverse-sar/capabilities-records`](./packages/capabilities-records) | 记录域能力包：8 能力 + 宏撤销工作流                                              | 12   |
| [`@geoverse-sar/capabilities-geo`](./packages/capabilities-geo)         | GeoJSON 要素包：30+ 能力（画/切/合、变换、洞族、查询分析、空间观察）             | 32   |
| [`@geoverse-sar/skill`](./packages/skill)                               | AI 入口：`toToolSpecs` + `handleToolCall`（+ SarClient 孪生，逐字节平价）        | 18   |
| [`@geoverse-sar/planner`](./packages/planner)                           | NL→能力路由：tool-use 循环、SSE 流式 `LlmClient`、无头聊天控制器                 | 11   |
| [`@geoverse-sar/agent`](./packages/agent)                               | 自治入口：observe→plan→act 循环、`AgentPolicy` 端口、dryRun diff 预览审批门      | 11   |
| [`@geoverse-sar/mcp`](./packages/mcp)                                   | MCP 入口：`tools/list` ≡ 描述符投影，`tools/call` → 同一漏斗                     | 5    |

## 快速体验（playground）

五页一个运行时——`pnpm playground:dev` 后打开 `http://localhost:8090`：

| 页面           | 演示内容                                                                 |
| -------------- | ------------------------------------------------------------------------ |
| `/index.html`  | 命令面板（UI 入口）与手动工具调用并排，附一键 **doctor** 体检报告        |
| `/chat.html`   | 真实 LLM 对话（DeepSeek）驱动内存域——流式、中止、宏撤销                  |
| `/geo.html`    | 真实 GeoVerse 地图（`GMap`）：LLM 查询、画线画面、切分合并、切换底图     |
| `/agent.html`  | 自治 Agent：observe→plan→act 轨迹、审批门开关、实时审计面板              |
| `/remote.html` | 远程模式：整页只有一个 `createRemoteClient`——先 `pnpm playground:server` |

LLM 页面需要 DeepSeek 密钥：仓根 `.env` 写入 `DEEPSEEK_API_KEY=...`（已 gitignore；密钥由 Vite dev 代理注入，**不进浏览器 bundle**）。

## 从源码开发

前置：**Node ≥ 20、pnpm ≥ 10**，以及与本仓平级的 `geoverse` 仓库检出（`@geoverse/editor-core`、`@geoverse/core-ol` 在发布前经 pnpm `file:` 链接本地）：

```
workspace/
├── geoverse/   # 先构建：pnpm install && pnpm -r build
└── sar/        # 本仓库
```

```shell
pnpm install
pnpm build        # 包间经 dist 解析——先 build
pnpm typecheck && pnpm lint && pnpm test
pnpm playground:dev
```

完整的开发、调试与**验证**指南（质量门禁、冒烟测试、真实 LLM 验收规则、提交规范）见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 文档

[`docs/`](./docs/README.md) 是 VitePress 站（`pnpm docs:dev` 预览、`pnpm docs:build` 构建——含 typedoc API 参考）。看架构与实现细节从[架构与技术明细](./docs/architecture.md)开始（漏斗精确管线/端口契约/不变量/错误码表）。读者指南：[核心概念](./docs/concepts.md) · [写能力包](./docs/capabilities.md) · [工作流与宏撤销](./docs/workflows.md) · [入口](./docs/entries.md) · [NL planner 与无头聊天](./docs/planner.md) · [自治 Agent 与治理](./docs/agent.md) · [接入自有引擎](./docs/engines.md) · [持久化](./docs/persistence.md) · [远程模式](./docs/remote.md) · [自进化](./docs/evolution.md) · [自检与错误分析](./docs/doctor.md)——另有各包 README。

设计档案：RFC-0008 / RFC-0009 与 ADR-0010…0013（共享设计 vault，不在本仓）。

## 许可

MIT
