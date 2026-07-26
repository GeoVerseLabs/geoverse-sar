/**
 * U0-5 ctx.state 惰性只读视图契约：
 * ① 结构性 O(1)：引擎有精读端口时，单实体读不触发 engine.snapshot()（计数=0）——
 *    read 能力延迟不随实体数线性增长的确定性证明（比计时基准可靠）。
 * ② 惰性且仅一次：无精读端口时，首次触达才物化快照，且整个 invoke 只物化一次。
 * ③ 变异防护：handler 原地改 ctx.state 交出的实体 → 冻结抛 TypeError → handler_error，
 *    引擎状态零污染。
 * ④ runtime.stats 走 entityCount 快路径，零快照。
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createKernel,
  createRuntimePack,
  type Capability,
  type Command,
  type DiffAlgebra,
  type DispatchResult,
  type Snapshot,
  type StateEngine,
  type TxEvent,
} from '../src/index';

interface Cell {
  id: string;
  value: number;
}
type CellDiff = { set: Cell[] };

class CountingEngine implements StateEngine<Cell, CellDiff> {
  snapshotCalls = 0;
  getEntityCalls = 0;
  private map = new Map<string, Cell>();
  getEntity?: (id: string) => Cell | undefined;
  entityCount?: () => number;

  constructor(seed: Cell[], precise: boolean) {
    for (const c of seed) this.map.set(c.id, { ...c });
    if (precise) {
      this.getEntity = (id) => {
        this.getEntityCalls += 1;
        const c = this.map.get(id);
        return c ? { ...c } : undefined;
      };
      this.entityCount = () => this.map.size;
    }
  }

  valueOf_(id: string): number | undefined {
    return this.map.get(id)?.value;
  }

  dispatch(cmd: Command<Cell, CellDiff>): DispatchResult<CellDiff> {
    const diff = cmd.plan({
      get: (id) => this.map.get(id),
      has: (id) => this.map.has(id),
      ids: () => [...this.map.keys()],
      list: () => [...this.map.values()],
    });
    for (const c of diff.set) this.map.set(c.id, { ...c });
    return { ok: true, diff };
  }

  undo(): boolean {
    return false;
  }
  redo(): boolean {
    return false;
  }

  snapshot(): Snapshot<Cell> {
    this.snapshotCalls += 1;
    return { entities: new Map([...this.map].map(([k, v]) => [k, { ...v }])) };
  }

  onTransaction(_fn: (e: TxEvent<CellDiff>) => void): () => void {
    return () => {};
  }
}

const algebra: DiffAlgebra<Cell, CellDiff> = {
  merge: (diffs) => ({ set: diffs.flatMap((d) => d.set) }),
  invert: (d) => d,
  apply: (base, d) => {
    for (const c of d.set) base.set(c.id, { ...c });
  },
};

const peek: Capability<{ id: string }, { value: number | null }, Cell, CellDiff> = {
  id: 'cell.peek',
  title: '读单元格',
  description: '按 id 读取单个单元格的值，只读、无副作用，用于惰性视图契约测试。',
  category: 'cell',
  kind: 'read',
  inputSchema: z.object({ id: z.string() }),
  outputSchema: z.object({ value: z.number().nullable() }),
  handler: async (ctx, input) => {
    ctx.state.has(input.id);
    return { output: { value: ctx.state.get(input.id)?.value ?? null } };
  },
};

const mutate: Capability<Record<string, never>, { ok: boolean }, Cell, CellDiff> = {
  id: 'cell.mutateInPlace',
  title: '违规原地变异',
  description: '故意原地修改 ctx.state 交出的实体，用于验证冻结防护会抛错。',
  category: 'cell',
  kind: 'read',
  inputSchema: z.object({}),
  outputSchema: z.object({ ok: z.boolean() }),
  handler: async (ctx) => {
    const cell = ctx.state.get('a')!;
    (cell as { value: number }).value = 999;
    return { output: { ok: true } };
  },
};

const noTouch: Capability<Record<string, never>, { ok: boolean }, Cell, CellDiff> = {
  id: 'cell.noTouch',
  title: '不读状态',
  description: '完全不触碰 ctx.state 的能力——任何引擎下都不该付快照成本。',
  category: 'cell',
  kind: 'read',
  inputSchema: z.object({}),
  outputSchema: z.object({ ok: z.boolean() }),
  handler: async () => ({ output: { ok: true } }),
};

function setup(precise: boolean) {
  const engine = new CountingEngine(
    [
      { id: 'a', value: 1 },
      { id: 'b', value: 2 },
    ],
    precise,
  );
  const kernel = createKernel<Cell, CellDiff>({
    engine,
    algebra,
    packs: [
      { id: 'cell', capabilities: [peek, mutate, noTouch] },
      createRuntimePack({ checkpoint: false }),
    ],
  });
  return { engine, kernel };
}

describe('U0-5 ctx.state 惰性只读视图', () => {
  it('精读引擎：单实体读零快照（O(1) 的结构性证明）', async () => {
    const { engine, kernel } = setup(true);
    const out = await kernel.invoke<{ value: number | null }>('cell.peek', { id: 'a' });
    expect(out.ok).toBe(true);
    expect(out.output!.value).toBe(1);
    expect(engine.snapshotCalls).toBe(0);
    expect(engine.getEntityCalls).toBeGreaterThan(0);
  });

  it('无精读端口：首次触达才物化快照，整个 invoke 仅一次', async () => {
    const { engine, kernel } = setup(false);
    const out = await kernel.invoke<{ value: number | null }>('cell.peek', { id: 'a' });
    expect(out.ok).toBe(true);
    expect(engine.snapshotCalls).toBe(1);
  });

  it('不触碰 ctx.state 的能力零快照（两种引擎皆然）', async () => {
    for (const precise of [true, false]) {
      const { engine, kernel } = setup(precise);
      const out = await kernel.invoke('cell.noTouch', {});
      expect(out.ok).toBe(true);
      expect(engine.snapshotCalls).toBe(0);
    }
  });

  it('变异防护：原地改交出的实体 → 冻结抛错 → handler_error，引擎零污染', async () => {
    const { engine, kernel } = setup(true);
    const out = await kernel.invoke('cell.mutateInPlace', {});
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('handler_error');
    expect(out.error?.message).toMatch(/read only|不可扩展|Cannot assign/i);
    expect(engine.valueOf_('a')).toBe(1);
  });

  it('runtime.stats 走 entityCount 快路径：零快照且计数正确', async () => {
    const { engine, kernel } = setup(true);
    const out = await kernel.invoke<{ entityCount: number }>('runtime.stats', {});
    expect(out.ok).toBe(true);
    expect(out.output!.entityCount).toBe(2);
    expect(engine.snapshotCalls).toBe(0);
  });
});
