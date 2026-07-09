# @geoverse-sar/engine-geo

把 GeoVerse 编辑引擎（`@geoverse/editor-core` 的 `EditEngine`）接入 SAR 通用 diff 端口的适配器：`GeoStateEngine implements StateEngine<EditableFeature, ChangeSet>`。**editor-core 零改动**——SAR 命令经 `EditContext` 桥接流入，撤销/校验/事件仍由原引擎负责。

```shell
pnpm add @geoverse-sar/engine-geo @geoverse-sar/kernel
# 依赖 @geoverse/editor-core（当前经 workspace file: 链接本地 geoverse 仓）
```

## 用法

```ts
import { createGeoEngine, ChangeSetAlgebra } from '@geoverse-sar/engine-geo';
import { createKernel } from '@geoverse-sar/kernel';
import {
  createGeoPack,
  createMemoryGeoViewService,
  VIEW_SERVICE_KEY,
} from '@geoverse-sar/capabilities-geo';

const engine = createGeoEngine({ features: seedGeoJsonFeatures });
const kernel = createKernel({
  engine,
  algebra: new ChangeSetAlgebra(),
  packs: [createGeoPack()],
  services: { [VIEW_SERVICE_KEY]: createMemoryGeoViewService() },
});
```

## 适配要点

- `EditEngine.dispatch` 返回值不含 ChangeSet → 适配器**常驻订阅事务事件**，同步捕获 apply 事务回填 `DispatchResult.diff`。
- `ChangeSetAlgebra` 是**双通道** merge/invert/apply：几何 `modified` 与 `propertyChanges` 各自折叠；modify→remove 时 removed 快照回滚到组前原始态（宏撤销正确性）。
- 撤销栈深经事务事件记账——宿主直接操作 `EditEngine` 也能对上账。
- 客人式生命周期：也可 `createGeoEngine({ editEngine: 已有实例 })` 复用宿主 `EditEngine`。
- **几何桥**：转发 editor-core 纯几何算子（`splitLineAt` / `splitPolygonByLine` / `mergeLines` / `unionPolygons`）供能力包映射 draw/split/merge——ChangeSet 仍在 SAR 命令 `plan(state)` 内构造（dryRun / 工作流投影态可用），且能力包无需第二个 `file:` 链接。

配套能力包：[`@geoverse-sar/capabilities-geo`](../capabilities-geo/README.md)。真地图接入示例见 `examples/playground` 的 `/geo.html`。
