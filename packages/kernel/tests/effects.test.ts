/**
 * G1-2 契约测试（阶段三 EffectDescriptor）：kind 缺省效应 + 显式覆盖 +
 * 描述符恒携带解析后的完整 effects（"每个能力都有效应元数据"）。
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createKernel,
  defineCapability,
  resolveEffects,
  type SarKernel,
} from '../src/index';
import { ItemAlgebra, ItemEngine, type Item, type ItemDiff } from './helpers';

describe('resolveEffects：kind 缺省 + Partial 覆盖（G1-2）', () => {
  it('三态各有合理缺省', () => {
    expect(resolveEffects('read')).toEqual({
      state: 'none',
      external: 'none',
      approval: 'never',
      idempotency: 'keyed',
    });
    expect(resolveEffects('write')).toEqual({
      state: 'reversible',
      external: 'none',
      approval: 'policy',
      idempotency: 'none',
    });
    expect(resolveEffects('action')).toEqual({
      state: 'none',
      external: 'none',
      approval: 'never',
      idempotency: 'none',
    });
  });

  it('Partial 覆盖在 kind 缺省之上——危险 action 声明外部写+强制审批', () => {
    const eff = resolveEffects('action', {
      external: 'write',
      approval: 'always',
      state: 'irreversible',
    });
    expect(eff).toEqual({
      state: 'irreversible',
      external: 'write',
      approval: 'always',
      idempotency: 'none', // 未覆盖项保留 action 缺省
    });
  });
});

describe('描述符携带 effects（G1-2）', () => {
  function setup(): SarKernel<Item, ItemDiff> {
    return createKernel<Item, ItemDiff>({
      engine: new ItemEngine([{ id: 'a', value: 1 }]),
      algebra: new ItemAlgebra(),
      packs: [
        {
          id: 'g1-2',
          capabilities: [
            defineCapability<Record<string, never>, { ok: boolean }, Item, ItemDiff>({
              id: 'ext.publish',
              title: '发布',
              description: '把当前工作集发布到外部系统（不可逆、需强制审批）。',
              category: 'ext',
              kind: 'action',
              effects: { external: 'write', state: 'irreversible', approval: 'always' },
              inputSchema: z.object({}),
              outputSchema: z.object({ ok: z.boolean() }),
              handler: async () => ({ output: { ok: true } }),
            }),
          ],
        },
      ],
    });
  }

  it('每个能力的描述符都有解析后的完整 effects（缺省即有）', () => {
    const kernel = setup();
    const all = kernel.describeAll();
    // 所有描述符都带完整 effects 四字段
    for (const d of all) {
      expect(d.effects).toBeDefined();
      expect(Object.keys(d.effects).sort()).toEqual([
        'approval',
        'external',
        'idempotency',
        'state',
      ]);
    }
    const publish = all.find((d) => d.id === 'ext.publish')!;
    expect(publish.effects).toEqual({
      state: 'irreversible',
      external: 'write',
      approval: 'always',
      idempotency: 'none',
    });
  });

  it('toPaletteItems 同源携带 effects', () => {
    const kernel = setup();
    const item = kernel.toPaletteItems().find((p) => p.id === 'ext.publish')!;
    expect(item.effects.approval).toBe('always');
    expect(item.effects.external).toBe('write');
  });
});
