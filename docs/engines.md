# 接入自有引擎：StateEngine + DiffAlgebra 契约清单

内核对状态变更只认两个接口。实现它们，你的领域（不限于 GIS）就获得整套 runtime：能力目录、单一漏斗、宏撤销、四入口、doctor。

```ts
interface StateEngine<TEntity, TDiff> {
  dispatch(cmd: Command<TEntity, TDiff>): DispatchResult<TDiff>; // 同步：plan→校验→apply→入撤销栈→emit
  undo(): boolean;
  redo(): boolean;
  snapshot(): Snapshot<TEntity>; // { entities: ReadonlyMap<string, TEntity> }
  onTransaction(fn: (e: TxEvent<TDiff>) => void): () => void; // 返回解绑函数
}
interface DiffAlgebra<TEntity, TDiff> {
  merge(diffs: TDiff[], label?: string): TDiff; // 宏撤销预合并
  invert(diff: TDiff): TDiff; // undo
  apply(base: EntityStore<TEntity>, diff: TDiff): void; // 前滚（也用于投影上下文）
}
```

## 契约清单（逐条可测）

**StateEngine**

1. `dispatch` **同步**完成应用（async 边界在能力 handler，不在 diff 应用——原子性由此保住）；`plan` 抛异常 → `{ ok:false, error }` 且状态零污染。
2. 应用前校验（id 冲突、目标存在性），拒绝 → `{ ok:false }`、不入栈。
3. 成功 → 入撤销栈、清空 redo 栈、`emit({ origin:'dispatch', diff, label })`、返回 `{ ok:true, diff }`。
4. `undo/redo` 空栈返回 `false`；成功时 emit `origin:'undo'|'redo'`（undo 事件带**反向** diff）。
5. `snapshot()` 深隔离：调用方改快照不影响引擎，引擎后续变更不影响已取快照。
6. `onTransaction` 返回的解绑函数必须真解绑（kernel dispose 依赖它）。

**DiffAlgebra** 7. `merge([])` 返回空 diff 不抛（空工作流 commit 走这条路径）。8. merge 折叠矩阵：add→modify 折进 added；modify 链首 before 末 after；add→remove 相消；modify→remove 保原始 before；remove→add 折成 modified。9. 两条属性律（建议 fast-check 钉死）：

- **invert 复原律**：`apply(invert(d))` 撤销 `apply(d)` 的全部效果；
- **merge 等价律**：`apply(merge(diffs))` ≡ 逐个 `apply(diffs)`。

```ts
// fast-check 模板（照抄 engine-memory/tests/algebra.test.ts）
fc.assert(
  fc.property(arbScenario, ({ base, diffs }) => {
    const seq = storeOf(...base);
    for (const d of diffs) algebra.apply(seq, d);
    const merged = storeOf(...base);
    algebra.apply(merged, algebra.merge(diffs));
    expect(dump(merged)).toEqual(dump(seq)); // 深比较须键序无关（Map 插入序会变）
  }),
);
```

## 两个现成范本

- **`engine-memory`**：从零实现的最小参照（~120 行引擎 + ~90 行代数）。
- **`engine-geo`**：**包装既有引擎**的范本——editor-core `EditEngine` 零改动接入。三个适配技巧：
  1. 底层 dispatch 不返回 diff → 常驻订阅自身事务事件，同步捕获回填；
  2. 撤销栈深经事务事件记账（宿主直接操作底层引擎也对得上）；
  3. diff 是复合结构（几何+属性双通道）→ merge/invert/apply 每通道分别折叠。

## 验收

跑 doctor（端口冒烟：snapshot 形状、事务钩子解绑、merge([]) 不抛）+ 把 `engine-memory` 的引擎/代数测试改造成你的类型重跑一遍。能力包无需改动——这正是端口的意义。
