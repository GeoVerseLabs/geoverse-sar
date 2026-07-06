import { describe, expect, it } from 'vitest';
import { TransactionGroup } from '../src/index';
import {
  AddItemCommand,
  ItemAlgebra,
  ItemEngine,
  RemoveItemCommand,
  SetValueCommand,
} from './helpers';

function setup(seed = [{ id: 'a', value: 1 }]) {
  const engine = new ItemEngine(seed);
  const algebra = new ItemAlgebra();
  const group = new TransactionGroup(engine, algebra, '测试组', 'txg-t');
  return { engine, algebra, group };
}

describe('TransactionGroup（ADR-0012 测试矩阵）', () => {
  it('投影上下文：第 N 步 plan 能看见第 N-1 步的效果（缓冲临时 id 可引用）', () => {
    const { engine, group } = setup([]);
    group.stage(new AddItemCommand([{ id: 'tmp1', value: 10 }]));
    // 引擎真实状态未变
    expect(engine.snapshot().entities.size).toBe(0);
    // 第二步能对第一步新增的 tmp1 做修改（plan 不抛）
    const diff2 = group.stage(new SetValueCommand('tmp1', 99));
    expect(diff2.modified[0]).toMatchObject({ id: 'tmp1', after: { value: 99 } });
  });

  it('add-then-modify 折叠进 added（合并后无 modified 残留）', () => {
    const { group } = setup([]);
    group.stage(new AddItemCommand([{ id: 'tmp1', value: 10 }]));
    group.stage(new SetValueCommand('tmp1', 99));
    const merged = group.mergedDiff()!;
    expect(merged.added).toEqual([{ id: 'tmp1', value: 99 }]);
    expect(merged.modified).toEqual([]);
  });

  it('同一 id 多次 modified 折叠取首 before / 末 after', () => {
    const { group } = setup([{ id: 'a', value: 1 }]);
    group.stage(new SetValueCommand('a', 2));
    group.stage(new SetValueCommand('a', 3));
    group.stage(new SetValueCommand('a', 4));
    const merged = group.mergedDiff()!;
    expect(merged.modified).toEqual([
      { id: 'a', before: { id: 'a', value: 1 }, after: { id: 'a', value: 4 } },
    ]);
  });

  it('add-then-remove 相消（合并后为空效果）', () => {
    const { group } = setup([]);
    group.stage(new AddItemCommand([{ id: 'tmp1', value: 10 }]));
    group.stage(new RemoveItemCommand('tmp1'));
    const merged = group.mergedDiff()!;
    expect(merged.added).toEqual([]);
    expect(merged.removed).toEqual([]);
    expect(merged.modified).toEqual([]);
  });

  it('modify-then-remove：removed 保留原始 before', () => {
    const { group } = setup([{ id: 'a', value: 1 }]);
    group.stage(new SetValueCommand('a', 2));
    group.stage(new RemoveItemCommand('a'));
    const merged = group.mergedDiff()!;
    expect(merged.modified).toEqual([]);
    expect(merged.removed).toEqual([{ id: 'a', value: 1 }]);
  });

  it('commit 只 dispatch 一次 → 整组一个撤销单元，undo 一次全回退', () => {
    const { engine, group } = setup([{ id: 'a', value: 1 }]);
    group.stage(new AddItemCommand([{ id: 'b', value: 2 }]));
    group.stage(new SetValueCommand('a', 100));
    group.stage(new SetValueCommand('b', 200));
    const res = group.commit()!;
    expect(res.ok).toBe(true);
    expect(engine.undoDepth).toBe(1);
    expect(engine.snapshot().entities.get('a')!.value).toBe(100);
    expect(engine.snapshot().entities.get('b')!.value).toBe(200);

    engine.undo();
    const snap = engine.snapshot();
    expect(snap.entities.get('a')!.value).toBe(1);
    expect(snap.entities.has('b')).toBe(false);
  });

  it('缓冲步 plan 抛异常 → abort 全组，引擎状态零污染', () => {
    const { engine, group } = setup([{ id: 'a', value: 1 }]);
    group.stage(new SetValueCommand('a', 2));
    expect(() => group.stage(new SetValueCommand('ghost', 1))).toThrowError(/不存在/);
    group.abort();
    expect(group.isClosed).toBe(true);
    expect(engine.undoDepth).toBe(0);
    expect(engine.snapshot().entities.get('a')!.value).toBe(1);
  });

  it('空缓冲 commit 返回 undefined，不产生撤销单元', () => {
    const { engine, group } = setup();
    expect(group.commit()).toBeUndefined();
    expect(engine.undoDepth).toBe(0);
  });

  it('关闭后 stage/commit 抛错', () => {
    const { group } = setup();
    group.abort();
    expect(() => group.stage(new AddItemCommand([{ id: 'x', value: 0 }]))).toThrowError(
      /已关闭/,
    );
  });
});
