# 概念全景：为什么内核不知道"地图"是什么

SAR（Spatial Application Runtime）把"散落在 SDK 方法里的能力"收敛成一个运行时。它解决三个结构性缺口：

1. **能力不可发现**——没有目录，外部（尤其 AI）无从知道"有哪些能力、参数是什么"。
2. **操作没有统一漏斗**——用户点按钮、AI 调工具、外部系统调 MCP 各走各的代码路径，无法统一鉴权、日志、撤销、事件。
3. **不能组合**——多步操作要么手写编排，要么产生一串撤销单元。

## 端口-适配器（六边形）

内核对状态变更只认一个抽象端口，**不 import 任何地图库/geoverse 包**（ESLint 依赖方向门强制）：

```
skill(AI) / mcp / examples(UI+程序化)     ← 入口层：只做描述符投影 + 回灌路由
        ↓
capabilities-*（能力包） → engine-*（引擎适配器）
        ↓                      ↓
        @geoverse-sar/kernel（纯机制，只依赖 zod）
             ↑ 通用 diff 端口：StateEngine<TEntity,TDiff> + DiffAlgebra
```

判据（可证伪）：**如果内核必须依赖 geoverse 才能跑，它就不是运行时**。所以内存引擎（engine-memory）与 geoverse 引擎（engine-geo 包 editor-core）是同一端口的两个适配器，能力包对二者同构。

## 三原语

- **Capability**：`{ id, title, description, kind, inputSchema, outputSchema, handler, requires? }`。
  - `kind: 'read'`（不改状态）/ `'write'`（返回命令→引擎→可撤销）/ `'action'`（有副作用但非 diff，如视野聚焦）。
  - 读写分层让 AI 可"先看后改"、让权限可授只读主体。
- **Command**：纯 planner——`plan(state): TDiff`，只算 diff 不改状态；应用/校验/入撤销栈由引擎统一负责。
- **Workflow**：能力组合 + 步间数据流 + `undo:'macro'` 宏撤销；注册后自动成为能力（"工作流即工具"）。

## 单一漏斗

一切操作走 `dispatcher.invoke(id, input, opts)`：

```
解析 → 中间件洋葱（权限/日志/ErrorMonitor…） → requires 服务校验 → Zod 入参校验
    → handler → 出参校验 → 写路由（engine.dispatch / TransactionGroup 缓冲）
    → 事件 → 归一 InvokeOutcome{ ok, output, diff?, issues?, error?, durationMs }
```

UI 点击、AI 工具调用、MCP 调用只是 `caller.entry: 'ui' | 'ai' | 'mcp' | 'program' | 'agent'` 不同——**跨入口平价**（同参数同 diff 同终态）是核心验收，有测试钉死。

## 宏撤销（TransactionGroup）

底层引擎遵循"一个 diff = 一个原子撤销单元"。工作流多个写步若各自 dispatch，用户一次 undo 只能回退最后一步。TransactionGroup 在**应用前**把 N 步 diff 经 `DiffAlgebra.merge` 预合并成一个，再 dispatch 一次——整条工作流一个撤销单元，**引擎零改动**。第 N 步 plan 时经"投影上下文"能看见第 N-1 步的效果（含引用前一步新增实体的临时 id）。任一步失败 → 整组 abort，零半成品。

## 客人式生命周期

宿主先建引擎（和地图），`createKernel({ engine, algebra })` 只接管自己挂上去的订阅；`dispose()` 默认不销毁宿主资源（显式 `ownsEngine: true` 才代管）。SAR 因此可以嵌进已有 GIS 应用而不抢资源。

## AI-native 特性一览

权限化目录裁剪（模型看不见即调不到）· Zod 校验失败回结构化 issues + `explainError` hint（自纠回灌）· `history.undo` 本身是能力（写操作可回退）· `dryRun` 预览/人审门 · 工作流即工具（一次调用多步+一键回滚）· EventBus 人机同栈观测 · 内核 NL-free（自然语言→工具映射留模型侧）· [doctor 启动期体检](./doctor.md)。
