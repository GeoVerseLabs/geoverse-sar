import { describe, expect, it } from 'vitest';
import type { Point } from 'geojson';
import { EditEngine, type EditableFeature } from '@geoverse/editor-core';
import {
  MapEntityStore,
  TransactionGroup,
  type Command,
  type TxEvent,
} from '@geoverse-sar/kernel';
import { ChangeSetAlgebra, createGeoEngine, type ChangeSet } from '../src/index';

const pt = (
  id: string,
  x: number,
  y: number,
  props: Record<string, unknown> = {},
): EditableFeature => ({
  id,
  geometry: { type: 'Point', coordinates: [x, y] } as Point,
  properties: props,
});

const coordsOf = (f: EditableFeature): number[] => (f.geometry as Point).coordinates;

/** SAR 形状命令（不是 editor-core 命令）：证明经端口零阻抗走 EditEngine。 */
const translateCmd = (
  ids: string[],
  dx: number,
  dy: number,
): Command<EditableFeature, ChangeSet> => ({
  label: '平移要素',
  plan: (state) => ({
    txId: `t-${Math.random().toString(36).slice(2)}`,
    label: '平移要素',
    added: [],
    removed: [],
    modified: ids.map((id) => {
      const f = state.get(id);
      if (!f) throw new Error(`要素不存在: ${id}`);
      const [x, y] = coordsOf(f);
      return {
        id,
        before: structuredClone(f.geometry),
        after: { type: 'Point', coordinates: [x + dx, y + dy] } as Point,
      };
    }),
  }),
});

const setPropsCmd = (
  id: string,
  props: Record<string, unknown>,
): Command<EditableFeature, ChangeSet> => ({
  label: '设属性',
  plan: (state) => {
    const f = state.get(id);
    if (!f) throw new Error(`要素不存在: ${id}`);
    return {
      txId: `t-${Math.random().toString(36).slice(2)}`,
      label: '设属性',
      added: [],
      removed: [],
      modified: [],
      propertyChanges: [
        {
          id,
          before: structuredClone(f.properties),
          after: { ...f.properties, ...props },
        },
      ],
    };
  },
});

describe('GeoStateEngine（包 editor-core EditEngine，零阻抗）', () => {
  it('SAR 命令经端口 dispatch：EditEngine 应用、DispatchResult 回填 ChangeSet', () => {
    const engine = createGeoEngine({ features: [pt('a', 0, 0)] });
    const res = engine.dispatch(translateCmd(['a'], 10, 5));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.diff.modified[0].id).toBe('a');
    expect(coordsOf(engine.snapshot().entities.get('a')!)).toEqual([10, 5]);
    expect(engine.undoDepth).toBe(1);
  });

  it('plan 抛异常 → EditEngine 兜住转 ok:false（issues 变 error 文本），零污染', () => {
    const engine = createGeoEngine({ features: [pt('a', 0, 0)] });
    const res = engine.dispatch(translateCmd(['ghost'], 1, 1));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('ghost');
    expect(engine.undoDepth).toBe(0);
  });

  it('undo/redo 委托 editor-core；propertyChanges 双通道一并回退', () => {
    const engine = createGeoEngine({ features: [pt('a', 0, 0, { name: '甲' })] });
    engine.dispatch(setPropsCmd('a', { highlighted: true }));
    expect(engine.snapshot().entities.get('a')!.properties).toEqual({
      name: '甲',
      highlighted: true,
    });
    expect(engine.undo()).toBe(true);
    expect(engine.snapshot().entities.get('a')!.properties).toEqual({ name: '甲' });
    expect(engine.redo()).toBe(true);
    expect(engine.snapshot().entities.get('a')!.properties.highlighted).toBe(true);
  });

  it('客人式：收宿主已建好的 EditEngine，宿主直接 dispatch 也进事务流/记账', () => {
    const hostEngine = new EditEngine({ features: [pt('a', 0, 0)] });
    const engine = createGeoEngine({ editEngine: hostEngine });
    const events: TxEvent<ChangeSet>[] = [];
    engine.onTransaction((e) => events.push(e));

    // 宿主绕过 SAR 直接用 editor-core 命令
    hostEngine.dispatch({
      label: '宿主操作',
      plan: (ctx) => ({
        txId: ctx.nextTxId(),
        label: '宿主操作',
        added: [ctx.newFeature({ type: 'Point', coordinates: [1, 1] })],
        removed: [],
        modified: [],
      }),
    });
    expect(events).toHaveLength(1);
    expect(events[0].origin).toBe('dispatch');
    expect(engine.undoDepth).toBe(1);
  });

  it('onTransaction 桥接：undo 事件回传反向 diff（与 engine-memory 语义一致）', () => {
    const engine = createGeoEngine({ features: [pt('a', 0, 0)] });
    const events: TxEvent<ChangeSet>[] = [];
    engine.onTransaction((e) => events.push(e));
    engine.dispatch(translateCmd(['a'], 10, 0));
    engine.undo();
    const undoEvent = events.find((e) => e.origin === 'undo')!;
    // 反向 diff 的 after 应是原位置 [0,0]
    expect((undoEvent.diff.modified[0].after as Point).coordinates).toEqual([0, 0]);
  });
});

describe('ChangeSetAlgebra + TransactionGroup（geo 宏撤销）', () => {
  it('setProps + translate 两步缓冲 → merge 双通道折叠 → 一个撤销单元', () => {
    const engine = createGeoEngine({ features: [pt('a', 0, 0, { name: '甲' })] });
    const algebra = new ChangeSetAlgebra();
    const group = new TransactionGroup(engine, algebra, '高亮并轻移', 'txg-geo');

    group.stage(setPropsCmd('a', { highlighted: true }));
    group.stage(translateCmd(['a'], 15, 0));
    // 投影上下文：第二步看见第一步的属性变化
    expect(engine.snapshot().entities.get('a')!.properties.highlighted).toBeUndefined();

    const res = group.commit()!;
    expect(res.ok).toBe(true);
    const a = engine.snapshot().entities.get('a')!;
    expect(coordsOf(a)).toEqual([15, 0]);
    expect(a.properties.highlighted).toBe(true);
    expect(engine.undoDepth).toBe(1);

    engine.undo();
    const back = engine.snapshot().entities.get('a')!;
    expect(coordsOf(back)).toEqual([0, 0]);
    expect(back.properties.highlighted).toBeUndefined();
  });

  it('merge 矩阵（geo 版）：add→modify 折进 added、add→remove 相消、modify→remove 保首 before', () => {
    const algebra = new ChangeSetAlgebra();
    const cs = (partial: Partial<ChangeSet>): ChangeSet => ({
      txId: 't',
      label: 'l',
      added: [],
      removed: [],
      modified: [],
      ...partial,
    });

    // add→modify
    let merged = algebra.merge([
      cs({ added: [pt('n', 0, 0)] }),
      cs({
        modified: [
          {
            id: 'n',
            before: { type: 'Point', coordinates: [0, 0] },
            after: { type: 'Point', coordinates: [9, 9] },
          },
        ],
      }),
    ]);
    expect(merged.modified).toEqual([]);
    expect(coordsOf(merged.added[0])).toEqual([9, 9]);

    // add→remove 相消
    merged = algebra.merge([
      cs({ added: [pt('n', 0, 0)] }),
      cs({ removed: [pt('n', 0, 0)] }),
    ]);
    expect(merged.added).toEqual([]);
    expect(merged.removed).toEqual([]);

    // modify→remove：removed 快照回滚到原始几何
    merged = algebra.merge([
      cs({
        modified: [
          {
            id: 'a',
            before: { type: 'Point', coordinates: [1, 1] },
            after: { type: 'Point', coordinates: [2, 2] },
          },
        ],
      }),
      cs({ removed: [pt('a', 2, 2)] }),
    ]);
    expect(merged.modified).toEqual([]);
    expect(coordsOf(merged.removed[0])).toEqual([1, 1]);
  });

  it('apply/invert 与顺序应用等效（含 propertyChanges）', () => {
    const algebra = new ChangeSetAlgebra();
    const base = [pt('a', 0, 0, { n: 1 })];
    const diffs: ChangeSet[] = [
      {
        txId: 't1',
        label: 'l',
        added: [pt('b', 5, 5)],
        removed: [],
        modified: [
          {
            id: 'a',
            before: { type: 'Point', coordinates: [0, 0] },
            after: { type: 'Point', coordinates: [3, 0] },
          },
        ],
        propertyChanges: [{ id: 'a', before: { n: 1 }, after: { n: 2 } }],
      },
      {
        txId: 't2',
        label: 'l',
        added: [],
        removed: [pt('b', 5, 5)],
        modified: [],
      },
    ];

    const seq = new MapEntityStore<EditableFeature>();
    for (const f of base) seq.set(f.id, structuredClone(f));
    for (const d of diffs) algebra.apply(seq, d);

    const merged = new MapEntityStore<EditableFeature>();
    for (const f of base) merged.set(f.id, structuredClone(f));
    algebra.apply(merged, algebra.merge(diffs));

    expect(Object.fromEntries(merged.ids().map((id) => [id, merged.get(id)]))).toEqual(
      Object.fromEntries(seq.ids().map((id) => [id, seq.get(id)])),
    );

    // invert 复原
    const store = new MapEntityStore<EditableFeature>();
    for (const f of base) store.set(f.id, structuredClone(f));
    for (const d of diffs) algebra.apply(store, d);
    for (const d of [...diffs].reverse()) algebra.apply(store, algebra.invert(d));
    expect(store.get('a')).toEqual(base[0]);
    expect(store.has('b')).toBe(false);
  });
});
