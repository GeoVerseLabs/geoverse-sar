/**
 * T12-pre→T12：agent 观察面走 runtime.stats 能力（经 SarClient 切面）——
 * 注册 runtimePack 时观察值来自能力调用（同漏斗可审计）；
 * 未注册 / 调用失败时计数缺席（entityCount undefined），循环不中断——
 * client 切面下没有 engine 对象可戳，缺席即诚实。
 */
import { describe, expect, it } from 'vitest';
import {
  clientOf,
  createAuditLog,
  createKernel,
  createRuntimePack,
  type Middleware,
  type SarClient,
} from '@geoverse-sar/kernel';
import {
  InMemoryStateEngine,
  RecordDiffAlgebra,
  type RecordDiff,
  type RecordEntity,
} from '@geoverse-sar/engine-memory';
import {
  createMemoryViewService,
  createRecordsPack,
  VIEW_SERVICE_KEY,
} from '@geoverse-sar/capabilities-records';
import { createAgent } from '../src/index';
import type { AgentObservation, AgentPolicy } from '../src/index';

const rec = (id: string, x: number, y: number): RecordEntity => ({
  id,
  x,
  y,
  props: {},
});

function makeClient(opts: { runtimePack?: boolean; middleware?: Middleware[] } = {}): {
  sar: SarClient<RecordDiff>;
  audit: ReturnType<typeof createAuditLog>;
} {
  const engine = new InMemoryStateEngine([rec('p1', 0, 0), rec('p2', 10, 0)]);
  const audit = createAuditLog();
  const kernel = createKernel<RecordEntity, RecordDiff>({
    engine,
    algebra: new RecordDiffAlgebra(),
    packs: [
      createRecordsPack(),
      ...(opts.runtimePack
        ? [createRuntimePack<RecordEntity, RecordDiff>({ checkpoint: false })]
        : []),
    ],
    services: { [VIEW_SERVICE_KEY]: createMemoryViewService() },
    middleware: [audit.middleware, ...(opts.middleware ?? [])],
  });
  return { sar: clientOf(kernel, { entry: 'agent' }), audit };
}

/** 一步收束的策略，捕获观察供断言。 */
function capturePolicy(): AgentPolicy & { observations: AgentObservation[] } {
  const observations: AgentObservation[] = [];
  return {
    observations,
    async decide(obs) {
      observations.push(obs);
      return { kind: 'done', summary: '观察完成' };
    },
  };
}

describe('agent 观察面走 runtime.stats（T12-pre/T12）', () => {
  it('注册 runtimePack：观察值来自能力调用，且同栈入审计（entry=agent）', async () => {
    const { sar, audit } = makeClient({ runtimePack: true });
    const policy = capturePolicy();
    const agent = createAgent(sar, { policy, maxSteps: 3 });

    const result = await agent.run('看一眼现场');
    expect(result.ok).toBe(true);
    expect(policy.observations[0]).toMatchObject({ entityCount: 2, undoDepth: 0 });

    // 可审计性正是能力化的意义：观察不再是黑盒对象戳探
    const statsEntries = audit
      .entries({ entry: 'agent' })
      .filter((e) => e.capabilityId === 'runtime.stats');
    expect(statsEntries.length).toBe(1);
    expect(statsEntries[0].ok).toBe(true);
  });

  it('未注册 runtimePack：计数缺席但目录/循环照常，无 stats 审计', async () => {
    const { sar, audit } = makeClient({ runtimePack: false });
    const policy = capturePolicy();
    const agent = createAgent(sar, { policy, maxSteps: 3 });

    const result = await agent.run('看一眼现场');
    expect(result.ok).toBe(true);
    expect(policy.observations[0].entityCount).toBeUndefined();
    expect(policy.observations[0].catalog.length).toBeGreaterThan(0);
    expect(
      audit.entries().filter((e) => e.capabilityId === 'runtime.stats'),
    ).toHaveLength(0);
  });

  it('stats 调用失败（中间件拦截）：计数缺席，循环不中断', async () => {
    const deny: Middleware = async (ctx, next) => {
      if (ctx.capabilityId === 'runtime.stats') {
        return {
          ok: false,
          capabilityId: ctx.capabilityId,
          error: { code: 'permission_denied', message: '测试拦截' },
          durationMs: 0,
        };
      }
      return next();
    };
    const { sar } = makeClient({ runtimePack: true, middleware: [deny] });
    const policy = capturePolicy();
    const agent = createAgent(sar, { policy, maxSteps: 3 });

    const result = await agent.run('看一眼现场');
    expect(result.ok).toBe(true);
    expect(policy.observations[0].entityCount).toBeUndefined();
  });
});
