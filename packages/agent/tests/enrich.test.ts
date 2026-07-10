/** T10：enrichObservation 钩子——领域摘要注入观察面、异常按 policy_error 收敛。 */
import { describe, expect, it } from 'vitest';
import { createKernel } from '@geoverse-sar/kernel';
import { InMemoryStateEngine, RecordDiffAlgebra } from '@geoverse-sar/engine-memory';
import { createRecordsPack } from '@geoverse-sar/capabilities-records';
import { createAgent, type AgentObservation } from '../src/index';

function kernelOf() {
  return createKernel({
    engine: new InMemoryStateEngine([]),
    algebra: new RecordDiffAlgebra(),
    packs: [createRecordsPack()],
  });
}

describe('enrichObservation（T10）', () => {
  it('钩子注入 extra，策略在观察里看得到；observe 事件带增强后观察', async () => {
    let seen: AgentObservation | undefined;
    const events: AgentObservation[] = [];
    const agent = createAgent(kernelOf(), {
      policy: {
        decide: async (obs) => {
          seen = obs;
          return { kind: 'done', summary: 'ok' };
        },
      },
      enrichObservation: (obs) => ({
        ...obs,
        extra: { ...obs.extra, spatial: { featureCount: 42 } },
      }),
    });
    const result = await agent.run('看看现场', {
      onEvent: (e) => {
        if (e.type === 'observe') events.push(e.observation);
      },
    });
    expect(result.ok).toBe(true);
    expect((seen!.extra!.spatial as { featureCount: number }).featureCount).toBe(42);
    expect(events[0].extra).toBeDefined(); // 事件面也拿到增强后的观察
  });

  it('钩子抛异常 → policy_error 收敛，不崩循环', async () => {
    const agent = createAgent(kernelOf(), {
      policy: { decide: async () => ({ kind: 'done', summary: 'ok' }) },
      enrichObservation: () => {
        throw new Error('观察服务不可用');
      },
    });
    const result = await agent.run('goal');
    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe('policy_error');
    expect(result.error).toContain('观察服务不可用');
  });
});
