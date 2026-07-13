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
pnpm build               # pnpm -r build（各包 vite build，ESM + d.ts；d.ts 假绿由 build/strict-dts 拦截）
pnpm verify              # 唯一权威门禁：build→typecheck→lint→format:check→test 串行（CI 同口径，阶段三 G0-3）
pnpm playground:dev      # playground 五页：两面板 / LLM 对话 / 真地图 / 自治 Agent / 远程模式
pnpm playground:server   # T13 远程演示服务（端口 8130，先 pnpm build）
pnpm docs:dev            # 文档站本地预览（VitePress，docs/ 即站源）
pnpm docs:build          # typedoc（→ docs/public/api，勿手改）+ vitepress build（D1 验收命令）

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
        · server（Node-only HTTP+WS 薄层：wire=InvokeOutcome、token→CallerInfo、EventBus→WS；只依赖 kernel+ws）
        · evolution（自进化：L2 workflow 合成/知识端口/摄取原型，只依赖 kernel，LLM 走自带 DraftLlm 端口）
        · otel（可观测出口：invoke 中间件 span + 事件桥，只依赖 kernel + @opentelemetry/api）
            ↓
能力层：capabilities-records → engine-memory（MVP 内存引擎，零 geoverse）
        capabilities-geo     → engine-geo（geoverse 适配器：包 @geoverse/editor-core EditEngine + 几何桥）
            ↓
              @geoverse-sar/kernel（纯机制内核，只依赖 zod；含 SarStore 存储端口 + store-idb/store-file 子导出 + createRuntimePack 内建能力）
```

- **`@geoverse-sar/kernel` 禁止 import 任何 geoverse 包 / 地图库 / 同仓其它包**——这是"内核是运行时而非 SDK 封装"的可证伪判据（RFC-0008）。`engine-geo`/`capabilities-geo` 是唯二可碰 geoverse 的适配层。
- **SarClient 切面（T12/R5+R6）**：入口层（planner/agent/UI）一律依赖 `SarClient`（catalog 异步 + invoke + onEvent 的可序列化最小子集）而非全功能 SarKernel——**caller 在 client 构造处绑定**（本地 `clientOf(kernel, caller)`；远程由服务端从 token 换算注入），权限/审计归因从"约定"变"结构"、客户端无处伪造身份；`workspace` 暴露 `ws.client`（`clientCaller` 可配）。skill 配套 `toToolSpecsOf(catalog)` / `handleToolCallVia(client, …, { catalog })`（与 kernel 版逐字节平价，平价测试钉死）。
- **远程化（T13/R7）**：`@geoverse-sar/server` 薄层不发明协议——wire 就是 `InvokeOutcome`（能力失败=200+ok:false，HTTP 状态码只表达传输层）、`Authorization: Bearer token`→CallerInfo 逐请求注入（请求体伪造 caller 无效）、WS=EventBus 直桥（帧序列与本地逐帧一致）、请求断开→内核 AbortSignal 兜底；kernel 子导出 `client-remote` 的 `createRemoteClient(url, token)` 还原同一 SarClient（**本地/远程入口平价**由 server 包平价测试钉死；`eventsReady()` 是懒连接不丢帧的就绪点；Node 20 无全局 WebSocket 经 `webSocket` 选项注入 ws 实现；不自动重连，断线走 `onSocketDown`）。演示：`pnpm playground:server` + `/remote.html`。指南见 `docs/remote.md`。
- **planner（M3；T12 起吃 SarClient）**：`createPlanner(sarClient, …)`（tool-use 循环，目录=`client.catalog()` 投影、回灌=handleToolCallVia 单漏斗）+ `createOpenAiCompatClient`（SSE 流式，`onTextDelta` 增量）+ `createChatController`（框架无关订阅式时间线，Vue/React 浅拷贝渲染）。**内核 NL-free 不因 planner 破例**——NL 只存在于 planner↔LLM 之间；LLM 非确定性隔离在 `LlmClient` 端口外（单测用脚本化假 client）。指南见 `docs/planner.md`。
- **agent + 治理（M4；T12 起吃 SarClient）**：`createAgent(sarClient, …)`（observe→plan→act，`AgentPolicy` 端口 + 审批门=写动作 dryRun diff 预览过 `approve`；观察面经 `runtime.stats` 能力取数，未注册则计数缺席——切面下无 engine 可戳）+ kernel 治理三件——`InvokeOptions.signal`（AbortSignal，handler 前+写路由前双检查，错误码 `aborted`）、`createAuditLog`（中间件，每次 invoke 按 entry/callerId 归因入账，JSON 往返）、`createJournal`/`replayJournal`（事务日志：录 dispatch/undo/redo，同 seed 新内核重放出**相同终态与撤销粒度**——宏撤销折叠在录制时已发生）。**治理长在内核不长在循环里**。指南见 `docs/agent.md`。
- **`@geoverse/editor-core` 经 pnpm `file:` 链接本地 geoverse 仓**（npm 上无此包——历史已删、待发版未发布）；本地 geoverse 构建产物变化后需重装。
- **playground 五页**（`pnpm playground:dev`，端口 8090；`/remote.html` 远程模式=整页仅一个 createRemoteClient，目录/调用/事件全来自 `pnpm playground:server` 的远端工作区，换 token 即换身份）：`/index.html` 两面板（含「🩺 体检」按钮直出 doctor 报告）；`/chat.html` 真实 LLM 对话（Vue 3，planner 驱动：流式光标+中止）；`/geo.html` 真地图（core-ol `file:` 接入——**仓外包须 vite `server.fs.allow` 放行**；点/线/面分型渲染，LLM 可 draw/split/merge/切底图；**openWorkspace 工作区**：恢复=快照+journal tail、💾 保存进度=checkpoint、双开只读、🗑 清空）；`/index.html` 主页同样工作区化（`buildWorkspaceDomain`，IDB 名 `sar-playground-records`）；**chat/agent 两页 T6b 起也工作区化**（装配移到 main.ts **顶层 await**——比 Suspense 重构更简，组件吃 props；chat 对话恢复=`items`+`history` 两份 conversations 快照配对（planner `history` 选项 + controller `items` 选项）；agent 审批门接 `createApprovalGate`——pending 落 store、崩溃遗留启动时读出补决策、遗留批准=continuation 重新 invoke）；`/agent.html` 自治 Agent（DeepSeek 策略 + 审批开关 + 审计面板）。**DeepSeek 密钥读仓根 `.env`（gitignored，模板 `.env.example`），经 vite dev 代理 `/api/deepseek` 注入 Authorization——不进浏览器 bundle**；`vite build` 产物无代理，chat 页会提示需 dev server。
- **自进化起步（RFC-0009，T15~T17+F4）**：红线"进化数据不进化代码"。L1=kernel `createTuningReport`（ErrorMonitor+audit → schema/description/usage 修订建议 + few-shot 素材；确定性零 LLM，修订由人执行）；L2=`@geoverse-sar/evolution` `createSynthesis`（挖掘→LLM 起草纯 JSON 草稿→静态检查+逐步 dryRun 干跑→审批→注册+provenance 落 `synthesized-workflows` 流；**缺省停 pending 不进目录**；模板语言只有取值引用 `$input.x`/`$steps.id.x`/`*` 投影，不图灵完备；undo 固定 macro）+ `loadSynthesizedWorkflows` 重启装载；知识端口=`createKnowledgePack`（kb.search requires 'kb' 服务）+ `createKbEnricher`（goal 命中注入 observation.extra.kb）；摄取原型=`ingestCapability`（签名→Zod→description→能力文件+测试骨架，dev-time 人审进仓）；F4=`@geoverse-sar/otel`（invoke 中间件 span + workflow/事务事件桥，BYO SDK）。指南见 `docs/evolution.md`。
- **自检与错误分析**（kernel `doctor.ts` / `diagnostics.ts`）：`runDoctor` 装配体检（能力目录/工具名双射/schema 派生/`requires` 服务/工作流引用/端口冒烟；error 拦 warn 不拦）；`createErrorMonitor` 中间件聚合失败（含 capability_not_found——未注册能力也过完整漏斗）；`explainError` 生成可操作 hint，skill 失败 content 自动带 `hint` 回灌模型自纠。能力可声明 `requires: ['服务键']`，dispatcher 前置校验（`service_missing`）。指南见 `docs/doctor.md`。
- 内核对状态变更只认通用 diff 端口：`StateEngine<TEntity,TDiff>` + `DiffAlgebra<TEntity,TDiff>{merge,invert,apply}`（ADR-0011）。
- **TransactionGroup** 是唯一新增运行时抽象：投影上下文 `stage`（第 N 步 plan 能看见第 N-1 步）+ `algebra.merge` 预合并 + `ReplayDiffCommand` 一次 dispatch → 整条工作流一个撤销单元，引擎不改（ADR-0012）。
- **Workflow 预览契约（阶段三 Gate 0，2026-07-11）**：工作流以能力形式被 `invoke`/SarClient 调用时，`CapabilityContext.dryRun`/`txGroupId` + `run()` 的 `dryRun`/`signal`/`txGroupId` 全量透传——dryRun=预览事务组步进 stage 后终局 abort（引擎零写入）、signal 步间检查透传、嵌套并入外层组保单一撤销单元。**修复"以能力形式 + dryRun 调工作流内部步骤仍真实写入"**（外部复评 P0-1）。规划见 `docs/SAR_CONTRACT_FREEZE_PLAN.md`，契约测试 `packages/kernel/tests/workflow-preview.test.ts`。d.ts 假绿由 `build/strict-dts` 的 `afterDiagnostic` 门拦截（G0-2）。
- **执行身份贯穿（阶段三 Gate 1 · G1-1，2026-07-13）**：每次 invoke 关联 `traceId`（缺省生成 `tr_`）+ 可选 `runId`（`run_`）+ `mode`（`kernel/src/ids.ts` 的 `newTraceId`/`newRunId`）。**一条工作流全程共享一个 traceId，内部步骤（含以能力形式/嵌套调用）继承**；身份随 `InvokeOptions→MiddlewareContext→CapabilityContext→InvokeOutcome` 传播，进 `SarEvent`/`AuditEntry`（可按 traceId/runId 过滤）/`Journal`（写路由 dispatch 事务带，undo/redo 不带——kernel 经 dispatcher 的**同步写路由 ambient** `getCurrentExecution()` 关联）/OTel span/远程 wire（请求体 traceId/runId，**caller 仍只由 token 注入**）。agent 一次 `run()` 全部 invoke 共享 runId；durable runId=工作流执行 runId。契约测试 `packages/kernel/tests/execution-context.test.ts` + server 身份透传用例。G1-4 公开可复现安装定案 **npm 发布**（editor-core 相关包发 npm 后，engine-geo/playground 的 `file:` 换 semver、CI 双仓 checkout 与 GEOVERSE_CLONE_TOKEN 移除）。
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

`docs/` **就是 VitePress 站源**（SAR_DOCS_PLAN D1 已落地）：12 篇指南 + `architecture.md`（架构与技术明细：漏斗精确管线/端口契约/不变量/错误码表）+ typedoc API（`docs/public/api` 生成物勿手改，`docs:build` 重生成；`typedoc.json` readme:none 免相对链接告警）；`docs/README.md` 只服务 GitHub 浏览不进站点（srcExclude，因含跨仓相对链接——vitepress 死链即 build 失败）。**改公共 API 时同步对应指南与包 README**（文档即验收：代码块须与真实 API 一致）；D2 遗留=guide 代码块 CI 冒烟 + playground 内嵌。

## Git 提交规范

沿用 geoverse 的 **Conventional Commits**：`type(scope): 中文简述`；scope 用包简称 `kernel` / `engine-memory` / `capabilities-records` / `skill` / `playground` / `repo`，跨多包逗号分隔。**只在用户明确要求时提交/推送**；changeset 单独成 `chore(changeset)` 提交。
