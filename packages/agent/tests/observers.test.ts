/**
 * U4-A 观察提供者体系：独立观察段 + token 预算确定性截断 + 失败缺席不掀翻循环
 * + 与既有 enrichObservation 钩子并存（先 enrich 后 providers）。
 */
import { describe, expect, it } from 'vitest';
import { clientOf, createKernel } from '@geoverse-sar/kernel';
import {
  InMemoryStateEngine,
  RecordDiffAlgebra,
  type RecordDiff,
  type RecordEntity,
} from '@geoverse-sar/engine-memory';
import { createRecordsPack } from '@geoverse-sar/capabilities-records';
import { createAgent, type AgentObservation, type AgentPolicy } from '../src/index';

function makeClient() {
  const kernel = createKernel<RecordEntity, RecordDiff>({
    engine: new InMemoryStateEngine([{ id: 'p1', x: 0, y: 0, props: {} }]),
    algebra: new RecordDiffAlgebra(),
    packs: [createRecordsPack()],
  });
  return clientOf(kernel, { entry: 'agent', id: 'obs-test' });
}

function capturePolicy(): AgentPolicy & { observations: AgentObservation[] } {
  const observations: AgentObservation[] = [];
  return {
    observations,
    async decide(observation) {
      observations.push(observation);
      return { kind: 'done', summary: '观察完毕。' };
    },
  };
}

describe('observers（观察提供者列表）', () => {
  it('各 provider 独立落 extra[name]；与 enrichObservation 并存（先 enrich 后 provider）', async () => {
    const policy = capturePolicy();
    const agent = createAgent(makeClient(), {
      policy,
      enrichObservation: (obs) => ({
        ...obs,
        extra: { ...obs.extra, legacy: 'hook' },
      }),
      observers: [
        { name: 'weather', provide: () => ({ sky: '晴' }) },
        {
          name: 'season',
          provide: (obs) => ({ step: obs.step, value: '夏' }),
        },
      ],
    });
    const result = await agent.run('看看环境');
    expect(result.ok).toBe(true);
    const extra = policy.observations[0].extra!;
    expect(extra.legacy).toBe('hook');
    expect(extra.weather).toEqual({ sky: '晴' });
    expect(extra.season).toEqual({ step: 1, value: '夏' });
  });

  it('token 预算：超限被替换为确定性截断标记（truncated/chars/preview）', async () => {
    const policy = capturePolicy();
    const big = { rows: Array.from({ length: 200 }, (_, i) => `记录条目-${i}`) };
    const agent = createAgent(makeClient(), {
      policy,
      observers: [
        { name: 'big', budget: 10, provide: () => big },
        { name: 'small', budget: 10_000, provide: () => ({ ok: 1 }) },
      ],
    });
    await agent.run('预算测试');
    const extra = policy.observations[0].extra!;
    const clipped = extra.big as {
      truncated: boolean;
      chars: number;
      budgetTokens: number;
      preview: string;
    };
    expect(clipped.truncated).toBe(true);
    expect(clipped.budgetTokens).toBe(10);
    expect(clipped.preview.length).toBeLessThanOrEqual(40); // 10 token × 4 字符
    expect(clipped.chars).toBeGreaterThan(40);
    expect(extra.small).toEqual({ ok: 1 }); // 预算内原样
  });

  it('provider 抛异常只让自己缺席（extra[name]={error}），循环照常收束', async () => {
    const policy = capturePolicy();
    const agent = createAgent(makeClient(), {
      policy,
      observers: [
        {
          name: 'flaky',
          provide: () => {
            throw new Error('观察源不可用');
          },
        },
        { name: 'steady', provide: () => 42 },
      ],
    });
    const result = await agent.run('容错测试');
    expect(result.ok).toBe(true);
    const extra = policy.observations[0].extra!;
    expect((extra.flaky as { error: string }).error).toContain('观察源不可用');
    expect(extra.steady).toBe(42);
  });
});
