# @geoverse-sar/workspace

SAR 工作区生命周期——`openWorkspace` 把「一次持续工作现场」组装成聚合根：**kernel + SarStore + 录制 + 恢复 + checkpoint + 单写者锁 + close**。刷新/重启后工作现场（实体、撤销栈、审计、对话）还在。

```shell
pnpm add @geoverse-sar/workspace @geoverse-sar/kernel zod
```

## 快速开始

```ts
import { openWorkspace } from '@geoverse-sar/workspace';
import { idbStore } from '@geoverse-sar/kernel/store-idb';

const ws = await openWorkspace({
  store: idbStore('proj-1'),
  // 引擎给**工厂**：恢复时用快照 seed 重建（给实例则禁用恢复，退化纯录制）
  engine: (seed) => createGeoEngine({ features: seed ?? SEED }),
  algebra: new ChangeSetAlgebra(),
  packs: [createGeoPack()],
  engineKind: 'geo',
  lock: 'proj-1', // 浏览器双开：后来者进只读模式（Web Locks）
});

ws.kernel.invoke('features.add', …);      // 正常用 kernel，全程自动录制
await ws.checkpoint();                     // 手动保存进度（也可 invoke 'runtime.checkpoint'）
await ws.saveConversation('chat', msgs);   // 对话历史快照
await ws.close();                          // flush + checkpoint + 释放锁 + 关 store
```

## 恢复算法

`open = meta 快照 → 实体快照 seed 重建引擎 → journal tail（checkpointSeq 之后）逐条校验 seq 连续并重放 → 继续录制`。恢复后终态与撤销粒度精确复现（回放等价，M4 性质）；断档/格式版本/引擎类型不匹配直接报错并指路快照兜底。

## checkpoint 与撤销地平线

`checkpoint()` = 实体快照 + meta（checkpointSeq）落盘成功后才截断 journal（崩溃最多留冗余日志不丢数据）。**撤销地平线 = checkpoint**：恢复后可撤销的只有 checkpoint 之后重放的事务，更早历史已归档（UI 应明示）。自动 checkpoint 默认每 200 事务（`persist.checkpoint.everyTx`）；`checkpointOnClose` 默认开。

## 主要选项

| 选项          | 说明                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------- |
| `engine`      | 工厂 `(seed?) => StateEngine`（推荐，支持恢复）或实例（纯录制）                                    |
| `seed`        | 首次创建（store 无快照）时的种子实体                                                               |
| `engineKind`  | 写进 meta，重开不匹配即拒绝                                                                        |
| `persist`     | `journal`/`audit`（默认 true）· `checkpoint.everyTx`（默认 200）· `keepTail` · `checkpointOnClose` |
| `runtimePack` | 注册内建 `runtime.stats` / `runtime.checkpoint`（默认 true，checkpoint 服务自动接线）              |
| `lock`        | Web Locks 锁名；拿不到锁 → `ws.readOnly`，写/action 被 `permission_denied` 拒绝                    |
| `closeStore`  | close 时连带关 store（默认 true）                                                                  |

## durable workflow run（F1）

```ts
import { createDurableRunner } from '@geoverse-sar/workspace';

const runner = createDurableRunner(ws.kernel, ws.store);
await runner.run('workflow.batchImport', input); // 进度逐步落 store
// 崩溃重启后：
for (const runId of await runner.pendingRuns()) {
  await runner.resume(runId); // per-step：跳已完成步；macro：原子整体重跑
}
```

`undo:'per-step'|'none'` 的工作流每步完成即持久化（已完成步的 diff 由 journal 恢复负责，续跑只补执行剩余步）；`undo:'macro'` 是原子单元——缓冲 diff 未落地即崩溃＝干净回滚，resume 即整体重跑（kernel 层对 macro+resume 直接拒绝）。

## 审批持久化（F2）

```ts
import { createApprovalGate } from '@geoverse-sar/workspace';

const gate = createApprovalGate(ws.store);
const agent = createAgent(ws.kernel, { policy, approve: gate.approve }); // 直接可挂
gate.onRequest((p) => ui.showApproval(p)); // 弹审批卡片
await gate.decide(p.id, true); // 进程内：放行等待中的动作
// 重启后：遗留 pending 仍在——
for (const p of await gate.pending()) {
  const record = await gate.decide(p.id, confirm(p)); // 批准则宿主凭记录重新 invoke
  if (record) await ws.kernel.invoke(record.capabilityId, record.input);
}
```

指南：[持久化](../../docs/persistence.md)（端口/适配器/流化/裸恢复/工作区）
