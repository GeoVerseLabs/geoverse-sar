# @geoverse-sar/capabilities-records

记录域能力包（配 `@geoverse-sar/engine-memory`）：SAR 三态能力的**参考实现**，也是零依赖跑通整个 runtime 的最短路径。

```shell
pnpm add @geoverse-sar/capabilities-records @geoverse-sar/engine-memory @geoverse-sar/kernel
```

## 能力清单（`createRecordsPack()`）

| 能力 | kind | 说明 |
|---|---|---|
| `records.query` | read | ids / propsEquals / bbox 过滤求交 |
| `records.add` | write | 批量新增（id 缺省自动生成） |
| `records.translate` | write | 按 (dx, dy) 平移一批记录 |
| `records.setProps` | write | 属性浅合并（如打高亮标记） |
| `records.remove` | write | 批量删除（可 undo 恢复） |
| `history.undo` / `history.redo` | action | 撤销/重做作为能力——AI 的写操作可回退 |
| `view.focus` | action | 聚焦质心/指定中心（经 `VIEW_SERVICE_KEY` 服务） |

## 工作流

`createHighlightAndNudgeWorkflow()`：查询 → 聚焦 → 高亮 → 轻移，`undo:'macro'`——两个写步折叠为**一个撤销单元**，同时注册为能力 `workflow.highlightAndNudge`（"工作流即工具"，AI/UI 一次调用完成多步）。

```ts
const kernel = createKernel({
  engine: new InMemoryStateEngine(seed),
  algebra: new RecordDiffAlgebra(),
  packs: [createRecordsPack()],
  workflows: [createHighlightAndNudgeWorkflow()],
  services: { [VIEW_SERVICE_KEY]: createMemoryViewService() },
});
await kernel.invoke('workflow.highlightAndNudge', { propsEquals: { type: 'poi' }, dx: 15 });
kernel.engine; // undoDepth === 1，一次 undo 全回退
```

写自己的能力包照抄本包结构即可：[写能力包指南](../../docs/capabilities.md)。
