/**
 * 测试替身：极简 Item 域引擎。
 * 刻意不用 engine-memory——kernel 测试只依赖端口本身，反向证明内核领域中立。
 */
import { z } from 'zod';
import {
  MapEntityStore,
  type Capability,
  type Command,
  type DiffAlgebra,
  type DispatchResult,
  type EntityStore,
  type ReadonlyEntityState,
  type Snapshot,
  type StateEngine,
  type TxEvent,
} from '../src/index';

export interface Item {
  id: string;
  value: number;
}

export interface ItemMod {
  id: string;
  before: Item;
  after: Item;
}

export interface ItemDiff {
  label?: string;
  added: Item[];
  removed: Item[];
  modified: ItemMod[];
}

const clone = (i: Item): Item => ({ ...i });

export class ItemAlgebra implements DiffAlgebra<Item, ItemDiff> {
  merge(diffs: ItemDiff[], label?: string): ItemDiff {
    const added = new Map<string, Item>();
    const removed = new Map<string, Item>();
    const modified = new Map<string, ItemMod>();
    for (const d of diffs) {
      for (const a of d.added) {
        const r = removed.get(a.id);
        if (r) {
          removed.delete(a.id);
          modified.set(a.id, { id: a.id, before: r, after: clone(a) });
        } else {
          added.set(a.id, clone(a));
        }
      }
      for (const m of d.modified) {
        if (added.has(m.id)) {
          added.set(m.id, clone(m.after));
        } else {
          const prev = modified.get(m.id);
          modified.set(m.id, {
            id: m.id,
            before: prev ? prev.before : clone(m.before),
            after: clone(m.after),
          });
        }
      }
      for (const r of d.removed) {
        if (added.has(r.id)) {
          added.delete(r.id);
        } else {
          const prev = modified.get(r.id);
          modified.delete(r.id);
          removed.set(r.id, prev ? prev.before : clone(r));
        }
      }
    }
    return {
      label,
      added: [...added.values()],
      removed: [...removed.values()],
      modified: [...modified.values()],
    };
  }

  invert(d: ItemDiff): ItemDiff {
    return {
      label: d.label,
      added: d.removed.map(clone),
      removed: d.added.map(clone),
      modified: d.modified.map((m) => ({ id: m.id, before: m.after, after: m.before })),
    };
  }

  apply(base: EntityStore<Item>, d: ItemDiff): void {
    for (const r of d.removed) base.delete(r.id);
    for (const a of d.added) base.set(a.id, clone(a));
    for (const m of d.modified) base.set(m.id, clone(m.after));
  }
}

export class ItemEngine implements StateEngine<Item, ItemDiff> {
  private store = new MapEntityStore<Item>();
  private algebra = new ItemAlgebra();
  private undoStack: ItemDiff[] = [];
  private redoStack: ItemDiff[] = [];
  private listeners = new Set<(e: TxEvent<ItemDiff>) => void>();
  disposedCalls = 0;

  constructor(seed: Item[] = []) {
    for (const i of seed) this.store.set(i.id, clone(i));
  }

  get undoDepth(): number {
    return this.undoStack.length;
  }
  get redoDepth(): number {
    return this.redoStack.length;
  }

  dispatch(cmd: Command<Item, ItemDiff>): DispatchResult<ItemDiff> {
    let diff: ItemDiff;
    try {
      diff = cmd.plan(this.store);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    for (const a of diff.added) {
      if (this.store.has(a.id)) return { ok: false, error: `id 冲突: ${a.id}` };
    }
    for (const m of [...diff.modified, ...diff.removed]) {
      if (!this.store.has(m.id)) return { ok: false, error: `实体不存在: ${m.id}` };
    }
    this.algebra.apply(this.store, diff);
    this.undoStack.push(diff);
    this.redoStack = [];
    this.emit({ origin: 'dispatch', diff, label: cmd.label ?? diff.label });
    return { ok: true, diff, label: cmd.label ?? diff.label };
  }

  undo(): boolean {
    const d = this.undoStack.pop();
    if (!d) return false;
    const inv = this.algebra.invert(d);
    this.algebra.apply(this.store, inv);
    this.redoStack.push(d);
    this.emit({ origin: 'undo', diff: inv, label: d.label });
    return true;
  }

  redo(): boolean {
    const d = this.redoStack.pop();
    if (!d) return false;
    this.algebra.apply(this.store, d);
    this.undoStack.push(d);
    this.emit({ origin: 'redo', diff: d, label: d.label });
    return true;
  }

  snapshot(): Snapshot<Item> {
    return {
      entities: new Map(this.store.ids().map((id) => [id, clone(this.store.get(id)!)])),
    };
  }

  onTransaction(fn: (e: TxEvent<ItemDiff>) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  dispose(): void {
    this.disposedCalls += 1;
  }

  private emit(e: TxEvent<ItemDiff>): void {
    for (const fn of this.listeners) fn(e);
  }
}

// ---- 命令 ----

export class AddItemCommand implements Command<Item, ItemDiff> {
  constructor(
    private items: Item[],
    readonly label = 'add items',
  ) {}
  plan(state: ReadonlyEntityState<Item>): ItemDiff {
    for (const i of this.items) {
      if (state.has(i.id)) throw new Error(`id 已存在: ${i.id}`);
    }
    return { label: this.label, added: this.items.map(clone), removed: [], modified: [] };
  }
}

export class SetValueCommand implements Command<Item, ItemDiff> {
  constructor(
    private id: string,
    private value: number,
    readonly label = 'set value',
  ) {}
  plan(state: ReadonlyEntityState<Item>): ItemDiff {
    const before = state.get(this.id);
    if (!before) throw new Error(`实体不存在: ${this.id}`);
    return {
      label: this.label,
      added: [],
      removed: [],
      modified: [
        { id: this.id, before: clone(before), after: { ...before, value: this.value } },
      ],
    };
  }
}

export class RemoveItemCommand implements Command<Item, ItemDiff> {
  constructor(
    private id: string,
    readonly label = 'remove item',
  ) {}
  plan(state: ReadonlyEntityState<Item>): ItemDiff {
    const before = state.get(this.id);
    if (!before) throw new Error(`实体不存在: ${this.id}`);
    return { label: this.label, added: [], removed: [clone(before)], modified: [] };
  }
}

// ---- 能力 fixtures ----

type ItemCapability = Capability<never, never, Item, ItemDiff>;

export const itemGet: Capability<
  { id: string },
  { value: number | null },
  Item,
  ItemDiff
> = {
  id: 'item.get',
  title: '读取条目',
  description: '按 id 读取条目当前值；只读。',
  category: 'item',
  kind: 'read',
  inputSchema: z.object({ id: z.string() }),
  outputSchema: z.object({ value: z.number().nullable() }),
  handler: async (ctx, input) => ({
    output: { value: ctx.state.get(input.id)?.value ?? null },
  }),
};

export const itemAdd: Capability<
  { items: { id: string; value: number }[] },
  { ids: string[] },
  Item,
  ItemDiff
> = {
  id: 'item.add',
  title: '新增条目',
  description: '批量新增条目（id 不可与既有条目重复）；写操作、可撤销。',
  category: 'item',
  kind: 'write',
  inputSchema: z.object({
    items: z.array(z.object({ id: z.string(), value: z.number() })).min(1),
  }),
  outputSchema: z.object({ ids: z.array(z.string()) }),
  handler: async (_ctx, input) => ({
    output: { ids: input.items.map((i) => i.id) },
    commands: [new AddItemCommand(input.items)],
  }),
};

export const itemSet: Capability<
  { id: string; value: number },
  { previous: number },
  Item,
  ItemDiff
> = {
  id: 'item.set',
  title: '设值',
  description: '把指定条目的 value 设为给定数值；写操作、可撤销。',
  category: 'item',
  kind: 'write',
  inputSchema: z.object({ id: z.string(), value: z.number() }),
  outputSchema: z.object({ previous: z.number() }),
  handler: async (ctx, input) => {
    const before = ctx.state.get(input.id);
    if (!before) throw new Error(`条目不存在: ${input.id}`);
    return {
      output: { previous: before.value },
      commands: [new SetValueCommand(input.id, input.value)],
    };
  },
};

/** 一次返回两条命令：验证隐式组折叠为一个撤销单元。 */
export const itemAddTwice: Capability<
  { a: string; b: string },
  Record<string, never>,
  Item,
  ItemDiff
> = {
  id: 'item.addTwice',
  title: '双命令写',
  description: '同一 invoke 产出两条命令。',
  category: 'item',
  kind: 'write',
  inputSchema: z.object({ a: z.string(), b: z.string() }),
  outputSchema: z.object({}),
  handler: async (_ctx, input) => ({
    output: {},
    commands: [
      new AddItemCommand([{ id: input.a, value: 1 }]),
      new AddItemCommand([{ id: input.b, value: 2 }]),
    ],
  }),
};

export const itemSecret: Capability<
  Record<string, never>,
  { secret: string },
  Item,
  ItemDiff
> = {
  id: 'item.secret',
  title: '受限能力',
  description: '返回受保护数据；仅授予 admin 权限的调用方可见可调。',
  category: 'item',
  kind: 'read',
  permissions: ['admin'],
  inputSchema: z.object({}),
  outputSchema: z.object({ secret: z.string() }),
  handler: async () => ({ output: { secret: '42' } }),
};

export const itemBoom: Capability<
  Record<string, never>,
  Record<string, never>,
  Item,
  ItemDiff
> = {
  id: 'item.boom',
  title: '异常能力',
  description: '测试替身：handler 必定抛异常，用于验证错误路径。',
  category: 'item',
  kind: 'read',
  inputSchema: z.object({}),
  outputSchema: z.object({}),
  handler: async () => {
    throw new Error('boom');
  },
};

export const itemBadOutput: Capability<
  Record<string, never>,
  { n: number },
  Item,
  ItemDiff
> = {
  id: 'item.badOutput',
  title: '违约输出',
  description: '输出不符合 outputSchema。',
  category: 'item',
  kind: 'read',
  inputSchema: z.object({}),
  outputSchema: z.object({ n: z.number() }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: async () => ({ output: { n: 'not-a-number' } as any }),
};

export function allItemCapabilities(): ItemCapability[] {
  return [
    itemGet,
    itemAdd,
    itemSet,
    itemAddTwice,
    itemSecret,
    itemBoom,
    itemBadOutput,
  ] as unknown as ItemCapability[];
}
