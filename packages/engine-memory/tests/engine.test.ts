import { describe, expect, it } from 'vitest';
import type { Command, TxEvent } from '@geoverse-sar/kernel';
import {
  InMemoryStateEngine,
  type RecordDiff,
  type RecordEntity,
} from '../src/index';

const rec = (id: string, x = 0, y = 0, props: Record<string, unknown> = {}): RecordEntity => ({
  id,
  x,
  y,
  props,
});

const addCmd = (...records: RecordEntity[]): Command<RecordEntity, RecordDiff> => ({
  label: 'add',
  plan: () => ({ added: records, removed: [], modified: [] }),
});

const moveCmd = (id: string, dx: number, dy: number): Command<RecordEntity, RecordDiff> => ({
  label: 'move',
  plan: (state) => {
    const before = state.get(id);
    if (!before) throw new Error(`记录不存在: ${id}`);
    return {
      added: [],
      removed: [],
      modified: [{ id, before, after: { ...before, x: before.x + dx, y: before.y + dy } }],
    };
  },
});

describe('InMemoryStateEngine', () => {
  it('dispatch → apply → 入撤销栈 → emit', () => {
    const engine = new InMemoryStateEngine();
    const events: TxEvent<RecordDiff>[] = [];
    engine.onTransaction((e) => events.push(e));

    const res = engine.dispatch(addCmd(rec('a', 1, 2)));
    expect(res.ok).toBe(true);
    expect(engine.undoDepth).toBe(1);
    expect(engine.snapshot().entities.get('a')).toMatchObject({ x: 1, y: 2 });
    expect(events).toHaveLength(1);
    expect(events[0].origin).toBe('dispatch');
  });

  it('plan 抛异常 → dispatch 失败，状态零污染', () => {
    const engine = new InMemoryStateEngine();
    const res = engine.dispatch(moveCmd('ghost', 1, 1));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('不存在');
    expect(engine.undoDepth).toBe(0);
  });

  it('校验：新增 id 冲突 / 修改删除不存在的记录均拒绝', () => {
    const engine = new InMemoryStateEngine([rec('a')]);
    expect(engine.dispatch(addCmd(rec('a'))).ok).toBe(false);
    expect(
      engine.dispatch({
        plan: () => ({
          added: [],
          removed: [rec('ghost')],
          modified: [],
        }),
      }).ok,
    ).toBe(false);
    expect(engine.undoDepth).toBe(0);
  });

  it('undo / redo 回放；新 dispatch 清空 redo 栈', () => {
    const engine = new InMemoryStateEngine([rec('a', 0, 0)]);
    engine.dispatch(moveCmd('a', 10, 0));
    engine.dispatch(moveCmd('a', 0, 5));
    expect(engine.snapshot().entities.get('a')).toMatchObject({ x: 10, y: 5 });

    expect(engine.undo()).toBe(true);
    expect(engine.snapshot().entities.get('a')).toMatchObject({ x: 10, y: 0 });
    expect(engine.redoDepth).toBe(1);

    expect(engine.redo()).toBe(true);
    expect(engine.snapshot().entities.get('a')).toMatchObject({ x: 10, y: 5 });

    engine.undo();
    engine.dispatch(moveCmd('a', -1, 0));
    expect(engine.redoDepth).toBe(0);

    // 空栈时返回 false
    engine.undo();
    engine.undo();
    expect(engine.undo()).toBe(false);
  });

  it('快照深拷贝：改快照不影响引擎，改引擎不影响已取快照', () => {
    const engine = new InMemoryStateEngine([rec('a', 1, 1, { tag: 'x' })]);
    const snap = engine.snapshot();
    const held = snap.entities.get('a')!;
    held.x = 999;
    held.props.tag = 'hacked';
    expect(engine.snapshot().entities.get('a')).toMatchObject({ x: 1, props: { tag: 'x' } });

    engine.dispatch(moveCmd('a', 5, 5));
    // 已取快照不随引擎变化（但注意上面对 held 的手改仍在快照里，这里看 y 未被引擎写动）
    expect(snap.entities.get('a')!.y).toBe(1);
  });

  it('构造种子与入参隔离（外部改种子数组元素不影响引擎）', () => {
    const seed = [rec('a', 1, 1)];
    const engine = new InMemoryStateEngine(seed);
    seed[0].x = 100;
    expect(engine.snapshot().entities.get('a')!.x).toBe(1);
  });
});
