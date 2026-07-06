# @geoverse-sar/capabilities-geo

要素域能力包（配 `@geoverse-sar/engine-geo`）：对 GeoJSON 要素（`EditableFeature`）的读写能力 + 视野控制，与 `capabilities-records` **同构**——同一套能力/工作流心智跨引擎成立，是"内核领域中立"的活证明。

```shell
pnpm add @geoverse-sar/capabilities-geo @geoverse-sar/engine-geo @geoverse-sar/kernel
```

## 能力清单（`createGeoPack()`）

| 能力 | kind | 说明 |
|---|---|---|
| `features.query` | read | bbox / propsEquals / ids 过滤，出参带 LLM 友好的几何摘要 |
| `features.add` | write | 新增 GeoJSON 要素（Point/LineString/Polygon…） |
| `features.translate` | write | 按 (dx, dy) 平移（经纬度度数，任意几何递归平移） |
| `features.setProps` | write | properties 浅合并 |
| `features.remove` | write | 批量删除 |
| `history.undo` / `history.redo` | action | 撤销/重做（editor-core 撤销栈） |
| `view.focus` | action | 聚焦要素整体范围中心（`GeoViewService`） |
| `view.zoom` | action | 绝对级别 / 增量缩放（视野服务可选实现 `zoom()`） |

## 视野服务

`GeoViewService` 是端口：`createMemoryGeoViewService()` 供无地图环境；真地图把 `GMap`（或任意地图实例）包成同接口即可——参考 `examples/playground/src/geo/map-adapter.ts`（focus→setCenter、zoom→setZoom、快照→图层同步）。

## 工作流

`createGeoHighlightAndNudgeWorkflow()`：与 records 版同名同构（查询 → 聚焦 → 高亮 → 轻移，宏撤销一个单元），注册为 `workflow.highlightAndNudge`。
