import { describe, expect, it } from 'vitest';
import { createKernel, createServices, isGranted, SarError } from '../src/index';
import type { SarEvent } from '../src/index';
import {
  allItemCapabilities,
  ItemAlgebra,
  ItemEngine,
  type ItemDiff,
} from './helpers';

describe('createKernel（客人式生命周期，ADR-0013）', () => {
  it('收已建好的引擎；dispose 默认不销毁宿主 engine', () => {
    const engine = new ItemEngine();
    const kernel = createKernel({ engine, algebra: new ItemAlgebra() });
    kernel.dispose();
    expect(engine.disposedCalls).toBe(0);
  });

  it('ownsEngine: true 时 dispose 代管销毁；幂等', () => {
    const engine = new ItemEngine();
    const kernel = createKernel({ engine, algebra: new ItemAlgebra(), ownsEngine: true });
    kernel.dispose();
    kernel.dispose();
    expect(engine.disposedCalls).toBe(1);
  });

  it('dispose 解绑引擎事务桥接（不再向 EventBus 转发）', async () => {
    const engine = new ItemEngine([{ id: 'a', value: 1 }]);
    const kernel = createKernel({
      engine,
      algebra: new ItemAlgebra(),
      packs: [{ id: 'item', capabilities: allItemCapabilities() }],
    });
    const seen: SarEvent<ItemDiff>[] = [];
    const off = kernel.events.on((e) => seen.push(e));
    await kernel.invoke('item.set', { id: 'a', value: 2 });
    const countBefore = seen.filter((e) => e.type === 'engine:transaction').length;
    expect(countBefore).toBe(1);

    off();
    kernel.dispose();
    engine.dispatch({
      label: 'direct',
      plan: () => ({ added: [], removed: [], modified: [] }),
    });
    expect(seen.filter((e) => e.type === 'engine:transaction').length).toBe(countBefore);
  });

  it('toPaletteItems 与 describeAll 同源（palette 是描述符投影）', () => {
    const kernel = createKernel({
      engine: new ItemEngine(),
      algebra: new ItemAlgebra(),
      packs: [{ id: 'item', capabilities: allItemCapabilities() }],
    });
    const items = kernel.toPaletteItems();
    const all = kernel.describeAll();
    expect(items.length).toBe(all.length);
    const palette = items.find((i) => i.id === 'item.add')!;
    const desc = all.find((d) => d.id === 'item.add')!;
    expect(palette.inputJsonSchema).toEqual(desc.inputJsonSchema);
    expect(palette.undoable).toBe(true);
  });
});

describe('permissions / services 辅助', () => {
  it('isGranted：无声明=放行；未配授权=全授；否则白名单', () => {
    expect(isGranted(undefined, { entry: 'ai' })).toBe(true);
    expect(isGranted([], { entry: 'ai', grantedPermissions: [] })).toBe(true);
    expect(isGranted(['w'], { entry: 'ai' })).toBe(true);
    expect(isGranted(['w'], { entry: 'ai', grantedPermissions: [] })).toBe(false);
    expect(isGranted(['w'], { entry: 'ai', grantedPermissions: ['w'] })).toBe(true);
  });

  it('services.require 未注册服务抛 SarError', () => {
    const services = createServices({ view: { focus: () => {} } });
    expect(services.get('view')).toBeDefined();
    expect(services.get('nope')).toBeUndefined();
    expect(() => services.require('nope')).toThrowError(SarError);
  });
});
