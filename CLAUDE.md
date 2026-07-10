# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> 注：上级工作区 `d:\workspace\claude\CLAUDE.md` 记录 GeoVerse 重构背景与任务工作流规范（三段式），对本仓库同样适用。设计依据在共享 vault：`docs/rfc/0008-spatial-application-runtime.md` + `docs/adr/0010~0013`。

## 这是什么

**GeoVerse SAR（Spatial Application Runtime）**——建在 GeoVerse SDK 之上的独立运行时（本仓库不依赖 geoverse 代码，M2 起以适配器接入）。核心思想：一切能力注册成 **Capability**（Zod 自描述、可发现/调用/组合），一切操作走 **Command + Workflow** 的单一 `dispatcher.invoke` 漏斗；GIS app / AI Copilot / 自治 Agent 只是同一 Runtime 的不同**入口**（`caller.entry` 区分）。

要求 **Node >= 20、pnpm >= 10**（`packageManager` 锁 `pnpm@10.11.0`）。

## 常用命令（仓库根目录执行）

```shell
pnpm install
pnpm typecheck           # pnpm -r typecheck（各包 tsc --noEmit）
pnpm lint                # eslint .（含依赖方向门，见下）
pnpm test                # pnpm -r test（vitest，node 环境）
pnpm build               # pnpm -r build（各包 vite build，ESM + d.ts）
pnpm playground:dev      # playground 三页：/index.html 两面板 · /chat.html LLM 对话 · /geo.html 真地图

pnpm --filter @geoverse-sar/kernel test          # 单包测试
pnpm --filter @geoverse-sar/kernel exec vitest run tests/txgroup.test.ts   # 单文件
```

> **包间经 dist 解析**：首次克隆或改内层包接口后，先 `pnpm build`（或构建对应内层包）再跑依赖方 typecheck/test，否则 "Failed to resolve entry" / 读到陈旧 d.ts。playground 例外（vite alias 指 `packages/*/src` 源码活联，但其 `tsc --noEmit` 仍读 dist 类型）。

## 包结构与依赖方向（ESLint 强制，违则 lint 红）

```
入口层：skill（AI）· planner（NL→能力路由 + 流式 + 无头聊天，只依赖 kernel+skill）
        · agent（自治 observe→plan→act，只依赖 kernel+skill+planner）· mcp（MCP，复用 skill）· examples/playground
            ↓
组装层：workspace（openWorkspace 生命周期：SarStore 恢复/checkpoint/锁/close，只依赖 kernel；引擎与能力包经入参注入）
            ↓
能力层：capabilities-records → engine-memory（MVP 内存引擎，零 geoverse）
        capabilities-geo     → engine-geo（geoverse 适配器：包 @geoverse/editor-core EditEngine + 几何桥）
            ↓
              @geoverse-sar/kernel（纯机制内核，只依赖 zod；含 SarStore 存储端口 + store-idb/store-file 子导出 + createRuntimePack 内建能力）
```

- **`@geoverse-sar/kernel` 禁止 import 任何 geoverse 包 / 地图库 / 同仓其它包**——这是"内核是运行时而非 SDK 封装"的可证伪判据（RFC-0008）。`engine-geo`/`capabilities-geo` 是唯二可碰 geoverse 的适配层。
- **SarClient 切面（T12/R5+R6）**：入口层（planner/agent/UI）一律依赖 `SarClient`（catalog 异步 + invoke + onEvent 的可序列化最小子集）而非全功能 SarKernel——**caller 在 client 构造处绑定**（本地 `clientOf(kernel, caller)`；远程由服务端从 token 换算注入，R7），权限/审计归因从"约定"变"结构"、客户端无处伪造身份；`workspace` 暴露 `ws.client`（`clientCaller` 可配）。skill 配套 `toToolSpecsOf(catalog)` / `handleToolCallVia(client, …, { catalog })`（与 kernel 版逐字节平价，平价测试钉死）。
- **planner（M3；T12 起吃 SarClient）**：`createPlanner(sarClient, …)`（tool-use 循环，目录=`client.catalog()` 投影、回灌=handleToolCallVia 单漏斗）+ `createOpenAiCompatClient`（SSE 流式，`onTextDelta` 增量）+ `createChatController`（框架无关订阅式时间线，Vue/React 浅拷贝渲染）。**内核 NL-free 不因 planner 破例**——NL 只存在于 planner↔LLM 之间；LLM 非确定性隔离在 `LlmClient` 端口外（单测用脚本化假 client）。指南见 `docs/planner.md`。
- **agent + 治理（M4；T12 起吃 SarClient）**：`createAgent(sarClient, …)`（observe→plan→act，`AgentPolicy` 端口 + 审批门=写动作 dryRun diff 预览过 `approve`；观察面经 `runtime.stats` 能力取数，未注册则计数缺席——切面下无 engine 可戳）+ kernel 治理三件——`InvokeOptions.signal`（AbortSignal，handler 前+写路由前双检查，错误码 `aborted`）、`createAuditLog`（中间件，每次 invoke 按 entry/callerId 归因入账，JSON 往返）、`createJournal`/`replayJournal`（事务日志：录 dispatch/undo/redo，同 seed 新内核重放出**相同终态与撤销粒度**——宏撤销折叠在录制时已发生）。**治理长在内核不长在循环里**。指南见 `docs/agent.md`。
- **`@geoverse/editor-core` 经 pnpm `file:` 链接本地 geoverse 仓**（npm 上无此包——历史已删、待发版未发布）；本地 geoverse 构建产物变化后需重装。
- **playground 四页**（`pnpm playground:dev`，端口 8090）：`/index.html` 两面板（含「🩺 体检」按钮直出 doctor 报告）；`/chat.html` 真实 LLM 对话（Vue 3，planner 驱动：流式光标+中止）；`/geo.html` 真地图（core-ol `file:` 接入——**仓外包须 vite `server.fs.allow` 放行**；点/线/面分型渲染，LLM 可 draw/split/merge/切底图；**openWorkspace 工作区**：恢复=快照+journal tail、💾 保存进度=checkpoint、双开只读、🗑 清空）；`/index.html` 主页同样工作区化（`buildWorkspaceDomain`，IDB 名 `sar-playground-records`）；chat/agent 两页暂未工作区化（`<script setup>` 顶层同步装配需 Suspense 重构，见 Backlog T6b）；`/agent.html` 自治 Agent（DeepSeek 策略 + 审批开关 + 审计面板）。**DeepSeek 密钥读仓根 `.env`（gitignored，模板 `.env.example`），经 vite dev 代理 `/api/deepseek` 注入 Authorization——不进浏览器 bundle**；`vite build` 产物无代理，chat 页会提示需 dev server。
- **自检与错误分析**（kernel `doctor.ts` / `diagnostics.ts`）：`runDoctor` 装配体检（能力目录/工具名双射/schema 派生/`requires` 服务/工作流引用/端口冒烟；error 拦 warn 不拦）；`createErrorMonitor` 中间件聚合失败（含 capability_not_found——未注册能力也过完整漏斗）；`explainError` 生成可操作 hint，skill 失败 content 自动带 `hint` 回灌模型自纠。能力可声明 `requires: ['服务键']`，dispatcher 前置校验（`service_missing`）。指南见 `docs/doctor.md`。
- 内核对状态变更只认通用 diff 端口：`StateEngine<TEntity,TDiff>` + `DiffAlgebra<TEntity,TDiff>{merge,invert,apply}`（ADR-0011）。
- **TransactionGroup** 是唯一新增运行时抽象：投影上下文 `stage`（第 N 步 plan 能看见第 N-1 步）+ `algebra.merge` 预合并 + `ReplayDiffCommand` 一次 dispatch → 整条工作流一个撤销单元，引擎不改（ADR-0012）。
- **客人式生命周期**：`createKernel({ engine, algebra })` 收已建好的引擎，`dispose()` 默认不销毁宿主资源（仅 `ownsEngine: true` 时代管）（ADR-0013）。
- 写路径永远同步收口在 `engine.dispatch` 内（async 边界是 handler 不是 diff 应用）；能力 handler 返回 `{output}` / `{output,commands,label?}` / `{output,diff}`。
- `CapabilityDescriptor ≡ Claude/MCP 工具定义`（`id≡name`、`inputJsonSchema≡input_schema`，由 Zod 经 `z.toJSONSchema` 派生一份，背 UI 面板 + AI tool + 后续 MCP）。内核 NL-free：自然语言→工具映射留模型侧。

## M1 验收基线（tests 里的核心断言，改动勿破坏）

- **跨入口平价**：`kernel.invoke('records.translate', p)` ≡ `handleToolCall(kernel, 'records.translate', p)` 产出相同 diff/outcome（`skill` 包 parity 测试）。
- **宏撤销折叠**：`highlightAndNudge` 工作流多写步 → `engine.undoDepth === 1`，一次 undo 全回退。
- **schema 平价**：`toToolSpecs` 与 `toPaletteItems` 的 JSON Schema 同源快照。
- **dryRun 不改状态**：返回 diff 但 snapshot 不变、undo 栈不长。
- txgroup 测试矩阵：add-then-modify 折叠进 added、modified 折叠首 before/末 after、add-then-remove 相消、staged id 跨步引用、plan 抛异常 abort 全组。

## 文档

读者向指南在仓内 `docs/`（concepts / capabilities / workflows / entries / planner / agent / engines / doctor，索引 `docs/README.md`）+ 各包 README；升级 VitePress 站按共享 vault 的 `SAR_DOCS_PLAN.md`（D1/D2）。**改公共 API 时同步对应指南与包 README**（文档即验收：代码块须与真实 API 一致）。

## Git 提交规范

沿用 geoverse 的 **Conventional Commits**：`type(scope): 中文简述`；scope 用包简称 `kernel` / `engine-memory` / `capabilities-records` / `skill` / `playground` / `repo`，跨多包逗号分隔。**只在用户明确要求时提交/推送**；changeset 单独成 `chore(changeset)` 提交。
