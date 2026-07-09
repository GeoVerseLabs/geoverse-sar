# @geoverse-sar/engine-memory

SAR 内核通用 diff 端口的**内存参考实现**：`InMemoryStateEngine`（`Map` 存储 + undo/redo 栈）+ `RecordDiffAlgebra`。实体是平面点记录 `{ id, x, y, props }`——刻意做成 `@geoverse/editor-core` `EditableFeature` 的极简同构，便于与真实 geo 引擎对照。

```shell
pnpm add @geoverse-sar/engine-memory @geoverse-sar/kernel
```

## 用途

- 单测/演示的默认引擎（无地图、无 DOM，node 直接跑）。
- 实现自有引擎时的**行为参照**：merge 折叠矩阵、invert 复原律、快照隔离在这里都有可执行定义（含 fast-check 属性测试）。

```ts
import { InMemoryStateEngine, RecordDiffAlgebra } from '@geoverse-sar/engine-memory';

const engine = new InMemoryStateEngine([{ id: 'a', x: 0, y: 0, props: {} }]);
engine.dispatch({
  label: '平移',
  plan: (state) => ({
    added: [],
    removed: [],
    modified: [
      { id: 'a', before: state.get('a')!, after: { ...state.get('a')!, x: 10 } },
    ],
  }),
});
engine.undo();
engine.undoDepth; // 0
```

## merge 折叠语义（宏撤销正确性核心）

| 序列                  | 折叠结果                  |
| --------------------- | ------------------------- |
| add → modify（同 id） | 折进 `added`（after 态）  |
| modify → modify       | 首 `before` / 末 `after`  |
| add → remove          | 相消（零效果）            |
| modify → remove       | `removed` 保留原始 before |
| remove → add          | 折成 `modified`           |

属性保证（fast-check）：`apply(d) ∘ apply(invert(d))` 复原任意状态；`merge(diffs)` ≡ 顺序 `apply`。

引擎实现契约清单见 [接入自有引擎](../../docs/engines.md)。
