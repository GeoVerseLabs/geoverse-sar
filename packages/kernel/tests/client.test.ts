/**
 * SarClient 切面（T12/R5）：clientOf 本地实现——
 * caller 构造绑定（目录裁剪与 invoke 强制同一身份、方法参数无处伪造）、
 * catalog 异步化、dryRun/signal 透传、事件桥接。
 */
import { describe, expect, it } from 'vitest';
import { clientOf, createKernel, type SarEvent } from '../src/index';
import {
  allItemCapabilities,
  ItemAlgebra,
  ItemEngine,
  type Item,
  type ItemDiff,
} from './helpers';

function makeKernel() {
  const engine = new ItemEngine([{ id: 'a', value: 1 }]);
  const kernel = createKernel<Item, ItemDiff>({
    engine,
    algebra: new ItemAlgebra(),
    packs: [{ id: 'item', capabilities: allItemCapabilities() }],
  });
  return { kernel, engine };
}

describe('clientOf（SarClient 本地实现）', () => {
  it('caller 构造绑定：目录裁剪与 invoke 强制同一判定，方法参数无处伪造', async () => {
    const { kernel } = makeKernel();
    const restricted = clientOf(kernel, { entry: 'ai', grantedPermissions: [] });
    const admin = clientOf(kernel, { entry: 'ui', grantedPermissions: ['admin'] });

    // 看不见：受限 client 目录里没有 item.secret
    const catalog = await restricted.catalog();
    expect(catalog.some((d) => d.id === 'item.secret')).toBe(false);
    // 调不到：硬调同一能力被拒（permission_denied）
    const denied = await restricted.invoke('item.secret');
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe('permission_denied');

    // admin client 看得见也调得到——同一 kernel，身份差异全在切面绑定
    const adminCatalog = await admin.catalog();
    expect(adminCatalog.some((d) => d.id === 'item.secret')).toBe(true);
    const granted = await admin.invoke<{ secret: string }>('item.secret');
    expect(granted.ok).toBe(true);
    expect(granted.output?.secret).toBe('42');
  });

  it('catalog 支持 kind/category 过滤（caller 之外的过滤维度保留）', async () => {
    const { kernel } = makeKernel();
    const client = clientOf(kernel, { entry: 'ui' });
    const reads = await client.catalog({ kind: 'read' });
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((d) => d.kind === 'read')).toBe(true);
  });

  it('dryRun 透传：返回 diff 但状态不变', async () => {
    const { kernel, engine } = makeKernel();
    const client = clientOf(kernel, { entry: 'ui' });
    const res = await client.invoke('item.set', { id: 'a', value: 9 }, { dryRun: true });
    expect(res.ok).toBe(true);
    expect(res.diff).toBeDefined();
    expect(engine.snapshot().entities.get('a')!.value).toBe(1);
  });

  it('signal 透传：已取消的调用报 aborted、状态不变', async () => {
    const { kernel, engine } = makeKernel();
    const client = clientOf(kernel, { entry: 'ui' });
    const ac = new AbortController();
    ac.abort();
    const res = await client.invoke(
      'item.set',
      { id: 'a', value: 9 },
      { signal: ac.signal },
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('aborted');
    expect(engine.snapshot().entities.get('a')!.value).toBe(1);
  });

  it('onEvent 桥接统一事件流：invoke 经 client 发出的事件携带绑定 caller，解绑生效', async () => {
    const { kernel } = makeKernel();
    const client = clientOf(kernel, { entry: 'agent', grantedPermissions: undefined });
    const events: SarEvent<ItemDiff>[] = [];
    const off = client.onEvent((e) => events.push(e));

    await client.invoke('item.get', { id: 'a' });
    const start = events.find((e) => e.type === 'invoke:start');
    expect(start && 'caller' in start ? start.caller.entry : undefined).toBe('agent');

    off();
    const before = events.length;
    await client.invoke('item.get', { id: 'a' });
    expect(events.length).toBe(before);
  });
});
