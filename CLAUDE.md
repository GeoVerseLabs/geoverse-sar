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
pnpm playground:dev      # MVP playground（命令面板 + Copilot 面板并排，无地图）

pnpm --filter @geoverse-sar/kernel test          # 单包测试
pnpm --filter @geoverse-sar/kernel exec vitest run tests/txgroup.test.ts   # 单文件
```

## 包结构与依赖方向（ESLint 强制，违则 lint 红）

```
入口层：skill（AI）· mcp（MCP，复用 skill）· examples/playground（UI+程序化）· examples/copilot-deepseek（真实 LLM）
            ↓
能力层：capabilities-records → engine-memory（MVP 内存引擎，零 geoverse）
        capabilities-geo     → engine-geo（geoverse 适配器：包 @geoverse/editor-core EditEngine）
            ↓
              @geoverse-sar/kernel（纯机制内核，只依赖 zod）
```

- **`@geoverse-sar/kernel` 禁止 import 任何 geoverse 包 / 地图库 / 同仓其它包**——这是"内核是运行时而非 SDK 封装"的可证伪判据（RFC-0008）。`engine-geo`/`capabilities-geo` 是唯二可碰 geoverse 的适配层。
- **`@geoverse/editor-core` 经 pnpm `file:` 链接本地 geoverse 仓**（npm 上无此包——历史已删、待发版未发布）；本地 geoverse 构建产物变化后需重装。
- `examples/copilot-deepseek`：密钥读仓根 `.env`（gitignored，模板 `.env.example`）；`pnpm --filter @geoverse-sar/copilot-deepseek demo|chat`。
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

## Git 提交规范

沿用 geoverse 的 **Conventional Commits**：`type(scope): 中文简述`；scope 用包简称 `kernel` / `engine-memory` / `capabilities-records` / `skill` / `playground` / `repo`，跨多包逗号分隔。**只在用户明确要求时提交/推送**；changeset 单独成 `chore(changeset)` 提交。
