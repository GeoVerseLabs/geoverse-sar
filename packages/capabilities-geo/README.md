# @geoverse-sar/capabilities-geo

要素域能力包（配 `@geoverse-sar/engine-geo`）：对 GeoJSON 要素（`EditableFeature`）的读写能力 + 视野控制，与 `capabilities-records` **同构**——同一套能力/工作流心智跨引擎成立，是"内核领域中立"的活证明。

```shell
pnpm add @geoverse-sar/capabilities-geo @geoverse-sar/engine-geo @geoverse-sar/kernel
```

## 能力清单（`createGeoPack()`）

| 能力                            | kind   | 说明                                                                           |
| ------------------------------- | ------ | ------------------------------------------------------------------------------ |
| `features.query`                | read   | bbox / propsEquals / ids 过滤，出参带 LLM 友好的几何摘要                       |
| `features.add`                  | write  | 新增点要素（x/y + props）                                                      |
| `features.draw`                 | write  | 画线/画面：按顶点序列新增 LineString / Polygon（外环自动闭合）                 |
| `features.split`                | write  | 切分：线在指定点打断成两段；面被切割线拆成多块（须贯穿外环，含洞面保持洞语义） |
| `features.merge`                | write  | 合并：线按序首尾相接；面求并集（共享边稳健处理）；结果继承首要素属性           |
| `features.translate`            | write  | 按 (dx, dy) 平移（经纬度度数，任意几何递归平移）                               |
| `features.setProps`             | write  | properties 浅合并                                                              |
| `features.remove`               | write  | 批量删除                                                                       |
| `history.undo` / `history.redo` | action | 撤销/重做（editor-core 撤销栈）                                                |
| `view.focus`                    | action | 聚焦要素整体范围中心（`GeoViewService`）                                       |
| `view.zoom`                     | action | 绝对级别 / 增量缩放（视野服务可选实现 `zoom()`）                               |
| `view.setBase`                  | action | 底图切换（视野服务可选实现 `setBase()`/`listBases()`，如 GMap `switchBase`）   |

> `draw`/`split`/`merge` 是 editor-core 几何算子（`splitLineAt` / `splitPolygonByLine` / `mergeLines` / `unionPolygons`——与其原生 Split/Merge 命令同一实现层）的能力映射，经 `@geoverse-sar/engine-geo` 的几何桥引入；ChangeSet 在 SAR 命令 `plan(state)` 内构造，dryRun 与工作流投影态天然可用。

## 视野服务

`GeoViewService` 是端口：`createMemoryGeoViewService()` 供无地图环境；真地图把 `GMap`（或任意地图实例）包成同接口即可——参考 `examples/playground/src/geo/map-adapter.ts`（focus→setCenter、zoom→setZoom、setBase→switchBase、快照→图层同步）。

## 工作流

`createGeoHighlightAndNudgeWorkflow()`：与 records 版同名同构（查询 → 聚焦 → 高亮 → 轻移，宏撤销一个单元），注册为 `workflow.highlightAndNudge`。
