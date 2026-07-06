import { describe, expect, it } from 'vitest';
import {
  createErrorMonitor,
  createKernel,
  explainError,
  suggestCapabilityIds,
  type SarKernel,
} from '../src/index';
import {
  allItemCapabilities,
  ItemAlgebra,
  ItemEngine,
  itemGet,
  type Item,
  type ItemDiff,
} from './helpers';

function setup(monitor = createErrorMonitor()): {
  kernel: SarKernel<Item, ItemDiff>;
  monitor: ReturnType<typeof createErrorMonitor>;
} {
  const kernel = createKernel<Item, ItemDiff>({
    engine: new ItemEngine([{ id: 'a', value: 1 }]),
    algebra: new ItemAlgebra(),
    packs: [{ id: 'item', capabilities: allItemCapabilities() }],
    middleware: [monitor.middleware],
  });
  return { kernel, monitor };
}

describe('createErrorMonitor（失败聚合）', () => {
  it('统计总数/失败率/按能力/按错误码/参数路径 Top', async () => {
    const { kernel, monitor } = setup();
    await kernel.invoke('item.get', { id: 'a' }); // ok
    await kernel.invoke('item.set', { id: 'a', value: '坏' }); // validation
    await kernel.invoke('item.set', { id: 'a', value: '也坏' }); // validation
    await kernel.invoke('item.boom', {}); // handler_error

    const r = monitor.report();
    expect(r.total).toBe(4);
    expect(r.failed).toBe(3);
    expect(r.failureRate).toBeCloseTo(0.75);
    expect(r.byCode.validation_failed).toBe(2);
    expect(r.byCode.handler_error).toBe(1);
    expect(r.byCapability[0]).toMatchObject({ capabilityId: 'item.set', failed: 2 });
    expect(r.topIssuePaths[0]).toMatchObject({ path: 'item.set#value', count: 2 });
    expect(r.recent[0].capabilityId).toBe('item.boom');
    expect(r.recent[0].entry).toBe('program');
  });

  it('reset 清零；maxRecent 截断', async () => {
    const monitor = createErrorMonitor({ maxRecent: 1 });
    const { kernel } = setup(monitor);
    await kernel.invoke('item.boom', {});
    await kernel.invoke('item.set', { id: 'a', value: '坏' });
    expect(monitor.report().recent).toHaveLength(1);
    expect(monitor.report().recent[0].capabilityId).toBe('item.set');
    monitor.reset();
    expect(monitor.report().total).toBe(0);
  });
});

describe('suggestCapabilityIds / explainError', () => {
  it('拼错的 id 给出相似建议（含 __ 归一）', () => {
    const { kernel } = setup();
    expect(suggestCapabilityIds(kernel.registry, 'item.gte')).toContain('item.get');
    expect(suggestCapabilityIds(kernel.registry, 'item__set')).toContain('item.set');
  });

  it('validation_failed → 逐条参数问题 + 修复指引', async () => {
    const { kernel } = setup();
    const outcome = await kernel.invoke('item.set', { id: 'a', value: '坏' });
    const hint = explainError(outcome)!;
    expect(hint).toContain('参数 value');
    expect(hint).toContain('input_schema');
  });

  it('capability_not_found → 附相似能力建议', async () => {
    const { kernel } = setup();
    const outcome = await kernel.invoke('item.gte', {});
    const hint = explainError(outcome, { registry: kernel.registry })!;
    expect(hint).toContain('item.get');
  });

  it('service_missing → 指向装配问题与 doctor', async () => {
    const { kernel } = setup();
    kernel.registry.register({
      ...itemGet,
      id: 'item.needsSvc',
      description: '依赖未注册服务，用于错误解释测试。',
      requires: ['ghostService'],
    });
    const outcome = await kernel.invoke('item.needsSvc', { id: 'a' });
    expect(outcome.error?.code).toBe('service_missing');
    const hint = explainError(outcome)!;
    expect(hint).toContain('doctor');
  });

  it('成功 outcome → undefined', async () => {
    const { kernel } = setup();
    const outcome = await kernel.invoke('item.get', { id: 'a' });
    expect(explainError(outcome)).toBeUndefined();
  });
});
