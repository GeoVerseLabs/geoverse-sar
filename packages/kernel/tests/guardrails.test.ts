/**
 * T11 guardrails（F3）：写预算 / 坐标围栏 / 受保护字段——输入级防线，
 * read 不拦、拒绝走 permission_denied（同栈可审计）。
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createGuardrails,
  createKernel,
  type Capability,
  type SarKernel,
} from '../src/index';
import {
  allItemCapabilities,
  ItemAlgebra,
  ItemEngine,
  type Item,
  type ItemDiff,
} from './helpers';

/** 测试替身：带坐标与属性入参的写能力（guardrails 扫的是入参，不需要真落地几何）。 */
const itemPlace: Capability<
  { x: number; y: number; props?: Record<string, unknown> },
  { ok: boolean },
  Item,
  ItemDiff
> = {
  id: 'item.place',
  title: '放置',
  description: '测试替身：带坐标/属性入参的写能力。',
  category: 'item',
  kind: 'write',
  inputSchema: z.object({
    x: z.number(),
    y: z.number(),
    props: z.record(z.string(), z.unknown()).optional(),
  }),
  outputSchema: z.object({ ok: z.boolean() }),
  handler: async () => ({ output: { ok: true } }),
};

function setup(guard: ReturnType<typeof createGuardrails>): {
  kernel: SarKernel<Item, ItemDiff>;
  engine: ItemEngine;
} {
  const engine = new ItemEngine([{ id: 'a', value: 1 }]);
  const kernel = createKernel<Item, ItemDiff>({
    engine,
    algebra: new ItemAlgebra(),
    packs: [{ id: 'item', capabilities: [...allItemCapabilities(), itemPlace] as never }],
    middleware: [guard.middleware],
  });
  return { kernel, engine };
}

describe('createGuardrails', () => {
  it('maxWritesPerRun：预算用尽拒绝，read 不计，reset 开新窗口', async () => {
    const guard = createGuardrails({ maxWritesPerRun: 2 });
    const { kernel } = setup(guard);

    expect((await kernel.invoke('item.set', { id: 'a', value: 2 })).ok).toBe(true);
    expect((await kernel.invoke('item.get', { id: 'a' })).ok).toBe(true); // read 不计
    expect((await kernel.invoke('item.set', { id: 'a', value: 3 })).ok).toBe(true);
    expect(guard.writesUsed).toBe(2);

    const denied = await kernel.invoke('item.set', { id: 'a', value: 4 });
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe('permission_denied');
    expect(denied.error?.message).toContain('写预算');

    guard.reset();
    expect((await kernel.invoke('item.set', { id: 'a', value: 5 })).ok).toBe(true);
  });

  it('bboxFence：{x,y} 与 [x,y] 两种形态的越界坐标都拦', async () => {
    const guard = createGuardrails({ bboxFence: [0, 0, 100, 100] });
    const { kernel } = setup(guard);

    expect((await kernel.invoke('item.place', { x: 50, y: 50 })).ok).toBe(true);
    const outObj = await kernel.invoke('item.place', { x: 200, y: 50 });
    expect(outObj.ok).toBe(false);
    expect(outObj.error?.message).toContain('围栏');

    const outArr = await kernel.invoke('item.place', {
      x: 10,
      y: 10,
      props: {
        path: [
          [10, 10],
          [999, 10],
        ],
      },
    });
    expect(outArr.ok).toBe(false);
  });

  it('propertyPolicy：入参深层出现受保护字段即拒；干净入参放行', async () => {
    const guard = createGuardrails({ propertyPolicy: { protectedFields: ['locked'] } });
    const { kernel } = setup(guard);

    const denied = await kernel.invoke('item.place', {
      x: 1,
      y: 1,
      props: { nested: { locked: true } },
    });
    expect(denied.ok).toBe(false);
    expect(denied.error?.message).toContain('locked');

    expect(
      (await kernel.invoke('item.place', { x: 1, y: 1, props: { name: 'ok' } })).ok,
    ).toBe(true);
  });
});
