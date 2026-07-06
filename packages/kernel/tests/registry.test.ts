import { describe, expect, it } from 'vitest';
import { CapabilityRegistry, SarError } from '../src/index';
import { allItemCapabilities, itemAdd, itemGet, itemSecret } from './helpers';
import type { Item, ItemDiff } from './helpers';

function makeRegistry(): CapabilityRegistry<Item, ItemDiff> {
  const r = new CapabilityRegistry<Item, ItemDiff>();
  r.registerPack({ id: 'item', capabilities: allItemCapabilities() });
  return r;
}

describe('CapabilityRegistry', () => {
  it('注册与读取', () => {
    const r = makeRegistry();
    expect(r.get('item.get')).toBe(itemGet);
    expect(r.has('item.nope')).toBe(false);
    expect(r.list().length).toBe(7);
  });

  it('重复 id 注册抛 capability_conflict', () => {
    const r = makeRegistry();
    expect(() => r.register(itemGet)).toThrowError(SarError);
    try {
      r.register(itemGet);
    } catch (e) {
      expect((e as SarError).code).toBe('capability_conflict');
    }
  });

  it('describe 生成完整描述符（含 JSON Schema，write 默认 undoable）', () => {
    const r = makeRegistry();
    const d = r.describe('item.add');
    expect(d.id).toBe('item.add');
    expect(d.kind).toBe('write');
    expect(d.undoable).toBe(true);
    expect(d.inputJsonSchema).toMatchObject({
      type: 'object',
      required: ['items'],
    });
    expect(d.outputJsonSchema).toMatchObject({ type: 'object' });
    // 缓存：同一能力重复 describe 返回同一份对象
    expect(r.describe('item.add')).toBe(d);
  });

  it('describe 未注册能力抛 capability_not_found', () => {
    const r = makeRegistry();
    expect(() => r.describe('nope')).toThrowError(/能力不存在/);
  });

  it('describeAll 按 caller 权限裁剪目录（模型看不见即调不到）', () => {
    const r = makeRegistry();
    const all = r.describeAll();
    expect(all.map((d) => d.id)).toContain('item.secret');

    const restricted = r.describeAll({ caller: { entry: 'ai', grantedPermissions: [] } });
    expect(restricted.map((d) => d.id)).not.toContain('item.secret');

    const admin = r.describeAll({
      caller: { entry: 'ai', grantedPermissions: ['admin'] },
    });
    expect(admin.map((d) => d.id)).toContain('item.secret');
  });

  it('describeAll 支持 kind / category 过滤', () => {
    const r = makeRegistry();
    const writes = r.describeAll({ kind: 'write' });
    expect(writes.every((d) => d.kind === 'write')).toBe(true);
    expect(writes.map((d) => d.id)).toContain('item.set');
  });

  it('discover 命中 id/title/description', () => {
    const r = makeRegistry();
    expect(r.discover('批量新增').map((d) => d.id)).toEqual([itemAdd.id]);
    expect(r.discover('item.secret').map((d) => d.id)).toEqual([itemSecret.id]);
    expect(r.discover('不存在的词')).toEqual([]);
  });
});
