import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { MapEntityStore } from '@geoverse-sar/kernel';
import {
  RecordDiffAlgebra,
  type RecordDiff,
  type RecordEntity,
} from '../src/index';

const algebra = new RecordDiffAlgebra();

const rec = (id: string, x = 0, y = 0, props: Record<string, unknown> = {}): RecordEntity => ({
  id,
  x,
  y,
  props,
});

const diff = (partial: Partial<RecordDiff>): RecordDiff => ({
  added: [],
  removed: [],
  modified: [],
  ...partial,
});

function storeOf(...records: RecordEntity[]): MapEntityStore<RecordEntity> {
  const s = new MapEntityStore<RecordEntity>();
  for (const r of records) s.set(r.id, { ...r, props: { ...r.props } });
  return s;
}

function dump(s: MapEntityStore<RecordEntity>): Record<string, RecordEntity> {
  return Object.fromEntries(s.ids().map((id) => [id, s.get(id)!]));
}

describe('RecordDiffAlgebra.merge 折叠矩阵（ADR-0012）', () => {
  it('remove-then-add 同 id 折叠为 modified', () => {
    const merged = algebra.merge([
      diff({ removed: [rec('a', 1, 1)] }),
      diff({ added: [rec('a', 9, 9)] }),
    ]);
    expect(merged.removed).toEqual([]);
    expect(merged.added).toEqual([]);
    expect(merged.modified).toEqual([
      { id: 'a', before: rec('a', 1, 1), after: rec('a', 9, 9) },
    ]);
  });

  it('merge 结果与逐个 apply 等效（组合律，含 props 变更）', () => {
    const base = [rec('a', 0, 0, { n: 1 }), rec('b', 5, 5)];
    const diffs = [
      diff({ added: [rec('c', 1, 1)] }),
      diff({
        modified: [{ id: 'a', before: rec('a', 0, 0, { n: 1 }), after: rec('a', 2, 0, { n: 2 }) }],
      }),
      diff({ removed: [rec('b', 5, 5)] }),
      diff({
        modified: [{ id: 'c', before: rec('c', 1, 1), after: rec('c', 1, 8) }],
      }),
    ];

    const sequential = storeOf(...base);
    for (const d of diffs) algebra.apply(sequential, d);

    const mergedStore = storeOf(...base);
    algebra.apply(mergedStore, algebra.merge(diffs, '合并'));

    expect(dump(mergedStore)).toEqual(dump(sequential));
  });

  it('invert：added↔removed、modified 交换 before/after', () => {
    const d = diff({
      label: 'x',
      added: [rec('a')],
      removed: [rec('b', 3, 3)],
      modified: [{ id: 'c', before: rec('c', 0, 0), after: rec('c', 1, 1) }],
    });
    const inv = algebra.invert(d);
    expect(inv.added).toEqual([rec('b', 3, 3)]);
    expect(inv.removed).toEqual([rec('a')]);
    expect(inv.modified).toEqual([{ id: 'c', before: rec('c', 1, 1), after: rec('c', 0, 0) }]);
  });
});

// ---- fast-check 属性测试 ----

const arbRecord = (id: string) =>
  fc
    .tuple(fc.integer({ min: -100, max: 100 }), fc.integer({ min: -100, max: 100 }))
    .map(([x, y]) => rec(id, x, y));

/** 生成基态与在其上有效的随机 diff 序列（保持引用一致性）。 */
const arbScenario = fc
  .uniqueArray(fc.integer({ min: 0, max: 9 }), { minLength: 1, maxLength: 6 })
  .chain((ids) =>
    fc.tuple(
      fc.tuple(...ids.map((i) => arbRecord(`r${i}`))),
      fc.array(fc.integer({ min: -50, max: 50 }), { minLength: 1, maxLength: 8 }),
    ),
  )
  .map(([base, deltas]) => {
    // 由 deltas 构造合法 diff 序列：轮流 move / remove-add
    const state = new Map(base.map((r) => [r.id, { ...r, props: { ...r.props } }]));
    const diffs: RecordDiff[] = [];
    let n = 0;
    for (const delta of deltas) {
      const ids = [...state.keys()];
      if (ids.length === 0) break;
      const id = ids[Math.abs(delta) % ids.length];
      const before = state.get(id)!;
      if (delta % 3 === 0) {
        // remove 再 add 新记录
        state.delete(id);
        const fresh = rec(`n${n++}`, delta, -delta);
        state.set(fresh.id, fresh);
        diffs.push(diff({ removed: [before], added: [fresh] }));
      } else {
        const after = { ...before, x: before.x + delta, y: before.y - delta };
        state.set(id, after);
        diffs.push(diff({ modified: [{ id, before, after }] }));
      }
    }
    return { base, diffs };
  });

describe('RecordDiffAlgebra 属性测试（fast-check）', () => {
  it('apply(d) ∘ apply(invert(d)) 复原任意状态', () => {
    fc.assert(
      fc.property(arbScenario, ({ base, diffs }) => {
        const store = storeOf(...base);
        const original = dump(storeOf(...base));
        for (const d of diffs) algebra.apply(store, d);
        for (const d of [...diffs].reverse()) algebra.apply(store, algebra.invert(d));
        // 深比较（键序无关）：remove/add 循环会改变 Map 插入顺序，但内容必须复原
        expect(dump(store)).toEqual(original);
      }),
    );
  });

  it('merge(diffs) 与顺序 apply 等效（宏撤销正确性的根基）', () => {
    fc.assert(
      fc.property(arbScenario, ({ base, diffs }) => {
        const sequential = storeOf(...base);
        for (const d of diffs) algebra.apply(sequential, d);

        const merged = storeOf(...base);
        algebra.apply(merged, algebra.merge(diffs));

        expect(dump(merged)).toEqual(dump(sequential));
      }),
    );
  });
});
