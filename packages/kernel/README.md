# @geoverse-sar/kernel

SAR（Spatial Application Runtime）的纯机制内核：把"能力"收敛成可发现、可调用、可组合的运行时。**零领域、零地图库依赖，只依赖 `zod`**——内核经通用 diff 端口与任何状态引擎对接，GIS 只是其中一种宿主。

```shell
pnpm add @geoverse-sar/kernel zod
```

## 心智模型

- **Capability**：自描述能力单元（Zod schema + `kind: read|write|action` + handler）。
- **单一漏斗**：一切调用走 `dispatcher.invoke`——权限 → 中间件 → 校验 → handler → 写路由 → 事件；UI 点击、AI 工具调用、MCP 调用只是 `caller.entry` 不同。
- **Workflow + 宏撤销**：多步组合经 `TransactionGroup` 预合并 diff，一次 dispatch = 一个撤销单元。
- **客人式生命周期**：宿主先建引擎，`createKernel({ engine, algebra })` 接管订阅但不接管所有权。

## 快速开始

```ts
import { createKernel, runDoctor, formatDoctorReport } from '@geoverse-sar/kernel';
import { InMemoryStateEngine, RecordDiffAlgebra } from '@geoverse-sar/engine-memory';
import { createRecordsPack, createMemoryViewService, VIEW_SERVICE_KEY } from '@geoverse-sar/capabilities-records';

const kernel = createKernel({
  engine: new InMemoryStateEngine(),
  algebra: new RecordDiffAlgebra(),
  packs: [createRecordsPack()],
  services: { [VIEW_SERVICE_KEY]: createMemoryViewService() },
});

console.log(formatDoctorReport(runDoctor(kernel)));   // 启动期装配体检

const out = await kernel.invoke('records.add', { records: [{ x: 1, y: 2 }] });
await kernel.invoke('history.undo');
```

## 主要导出

| 导出 | 说明 |
|---|---|
| `createKernel(options)` | 装配入口：engine/algebra/packs/workflows/services/middleware |
| `StateEngine` / `DiffAlgebra` / `Command` | 通用 diff 端口（实现它即可接入任意引擎） |
| `CapabilityRegistry` / `describeAll` / `discover` | 能力目录（含权限裁剪） |
| `Dispatcher.invoke` / `InvokeOutcome` | 单一漏斗与归一出参（`dryRun` / `txGroupId`） |
| `WorkflowRegistry` / `TransactionGroup` | 工作流、宏撤销 |
| `runDoctor` / `formatDoctorReport` | **自检**：装配完整性体检（目录/工作流/服务/schema/工具名双射/端口冒烟） |
| `createErrorMonitor` / `explainError` / `suggestCapabilityIds` | **错误分析**：失败聚合中间件 + 错误→可操作提示 |
| `toPaletteItems` | UI 命令面板投影（与 AI 工具规格同源） |

指南：[概念全景](../../docs/concepts.md) · [写能力包](../../docs/capabilities.md) · [接入自有引擎](../../docs/engines.md) · [自检与错误分析](../../docs/doctor.md)
