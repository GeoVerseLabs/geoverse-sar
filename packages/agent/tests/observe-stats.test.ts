/**
 * T12-pre（R6 先行小步）：agent 观察面去 engine 对象戳探——
 * 注册 runtimePack 时 observe 走 `invoke('runtime.stats')`（同漏斗可审计），
 * 未注册 / 调用失败时回退对象戳探，循环不受影响。
 */
import { describe, expect, it } from 'vitest';
import {
  createAuditLog,
  createKernel,
  createRuntimePack,
  type Middleware,
  type SarKernel,
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

function makeKernel(opts: { runtimePack?: boolean; middleware?: Middleware[] } = {}): {
  kernel: SarKernel<RecordEntity, RecordDiff>;
  engine: InMemoryStateEngine;
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
  return { kernel, engine, audit };
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

describe('agent 观察面走 runtime.stats（T12-pre）', () => {
  it('注册 runtimePack：观察值来自能力调用，且同栈入审计（entry=agent）', async () => {
    const { kernel, audit } = makeKernel({ runtimePack: true });
    const policy = capturePolicy();
    const agent = createAgent(kernel, { policy, maxSteps: 3 });

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

  it('未注册 runtimePack：回退对象戳探，观察值不变、无 stats 审计', async () => {
    const { kernel, audit } = makeKernel({ runtimePack: false });
    const policy = capturePolicy();
    const agent = createAgent(kernel, { policy, maxSteps: 3 });

    const result = await agent.run('看一眼现场');
    expect(result.ok).toBe(true);
    expect(policy.observations[0]).toMatchObject({ entityCount: 2, undoDepth: 0 });
    expect(
      audit.entries().filter((e) => e.capabilityId === 'runtime.stats'),
    ).toHaveLength(0);
  });

  it('stats 调用失败（中间件拦截）：回退戳探，循环不中断', async () => {
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
    const { kernel } = makeKernel({ runtimePack: true, middleware: [deny] });
    const policy = capturePolicy();
    const agent = createAgent(kernel, { policy, maxSteps: 3 });

    const result = await agent.run('看一眼现场');
    expect(result.ok).toBe(true);
    expect(policy.observations[0]).toMatchObject({ entityCount: 2, undoDepth: 0 });
  });
});
