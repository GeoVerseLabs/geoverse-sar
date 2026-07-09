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
import {
  createRecordsPack,
  createMemoryViewService,
  VIEW_SERVICE_KEY,
} from '@geoverse-sar/capabilities-records';

const kernel = createKernel({
  engine: new InMemoryStateEngine(),
  algebra: new RecordDiffAlgebra(),
  packs: [createRecordsPack()],
  services: { [VIEW_SERVICE_KEY]: createMemoryViewService() },
});

console.log(formatDoctorReport(runDoctor(kernel))); // 启动期装配体检

const out = await kernel.invoke('records.add', { records: [{ x: 1, y: 2 }] });
await kernel.invoke('history.undo');
```

## 主要导出

| 导出                                                           | 说明                                                                                    |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `createKernel(options)`                                        | 装配入口：engine/algebra/packs/workflows/services/middleware                            |
| `StateEngine` / `DiffAlgebra` / `Command`                      | 通用 diff 端口（实现它即可接入任意引擎）                                                |
| `CapabilityRegistry` / `describeAll` / `discover`              | 能力目录（含权限裁剪）                                                                  |
| `Dispatcher.invoke` / `InvokeOutcome`                          | 单一漏斗与归一出参（`dryRun` / `txGroupId`）                                            |
| `WorkflowRegistry` / `TransactionGroup`                        | 工作流、宏撤销                                                                          |
| `runDoctor` / `formatDoctorReport`                             | **自检**：装配完整性体检（目录/工作流/服务/schema/工具名双射/端口冒烟）                 |
| `createErrorMonitor` / `explainError` / `suggestCapabilityIds` | **错误分析**：失败聚合中间件 + 错误→可操作提示                                          |
| `toPaletteItems`                                               | UI 命令面板投影（与 AI 工具规格同源）                                                   |
| `SarStore` / `memoryStore`                                     | **存储端口**：追加流（journal/audit/对话）+ 快照（实体/元数据），runtime 唯一持久化抽象 |

## 存储端口 SarStore

runtime 的持久数据只有两种形状——**追加流**（`append`/`read`/`truncate`，seq 由 store 按流单调分配、截断后不回退）与**快照**（`putSnapshot`/`getSnapshot`，整体替换）。记录须 JSON 可序列化。

三个适配器同一契约（同一测试套件钉死，换适配器行为不变）：

```ts
import { memoryStore } from '@geoverse-sar/kernel'; // 测试/临时会话
import { idbStore } from '@geoverse-sar/kernel/store-idb'; // 浏览器（IndexedDB）
import { fileStore } from '@geoverse-sar/kernel/store-file'; // Node（JSONL，fsync 可配）

const store = fileStore('./data/proj-1');
await store.append('journal', [{ op: 'dispatch', diff }]);
const tail = await store.read('journal', { fromSeq: 42 });
await store.putSnapshot('entities', snapshotData);
await store.close();
```

`fileStore` 启动装载时自动丢弃末尾无换行残行（崩溃安全）并告警；快照/截断走 tmp+rename 原子替换。`idbStore`/`fileStore` 是环境特定子导出，不进浏览器主入口。

journal/audit 可流化落 store（双写，写失败不阻断主流程）：`createJournal(kernel, { sink: { store } })` / `createAuditLog({ sink: { store } })`，退出前 `flush()`。启动时 `store.read('journal')` + `replayJournal` 即得"刷新不丢"（裸恢复）。详见[持久化指南](../../docs/persistence.md)。

指南：[概念全景](../../docs/concepts.md) · [写能力包](../../docs/capabilities.md) · [接入自有引擎](../../docs/engines.md) · [自检与错误分析](../../docs/doctor.md)
