/**
 * G1-2 契约测试：agent 审批门 effect-aware（修复复评 P0-3）。
 * - kind==='action' 但声明 approval:'always' 的危险操作**会**过审批门（旧 kind==='write' 判据漏掉）；
 * - external/irreversible 操作**跳过 dryRun 预览**（避免预览时真的触发副作用），审批仍生效；
 * - write 显式 approval:'never' 可豁免审批门。
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  clientOf,
  createKernel,
  defineCapability,
  type CallerInfo,
  type SarClient,
} from '@geoverse-sar/kernel';
import {
  InMemoryStateEngine,
  RecordDiffAlgebra,
  type RecordDiff,
  type RecordEntity,
} from '@geoverse-sar/engine-memory';
import { createRecordsPack } from '@geoverse-sar/capabilities-records';
import { createAgent } from '../src/index';
import type { AgentDecision, AgentObservation, AgentPolicy } from '../src/index';

const AGENT: CallerInfo = { entry: 'agent' };

/** 外部副作用计数器：验证 dryRun 预览是否会误触发副作用。 */
let publishCalls = 0;

function makeSar(): SarClient<RecordDiff> {
  publishCalls = 0;
  const engine = new InMemoryStateEngine([{ id: 'p1', x: 0, y: 0, props: {} }]);
  const kernel = createKernel<RecordEntity, RecordDiff>({
    engine,
    algebra: new RecordDiffAlgebra(),
    packs: [
      createRecordsPack(),
      {
        id: 'ext',
        capabilities: [
          // 危险 action：外部写 + 不可逆 + 强制审批（handler 里"发布"=递增计数）
          defineCapability<
            Record<string, never>,
            { ok: boolean },
            RecordEntity,
            RecordDiff
          >({
            id: 'ext.publish',
            title: '发布',
            description: '把工作集发布到外部系统（不可逆、外部写、需强制审批）。',
            category: 'ext',
            kind: 'action',
            effects: { external: 'write', state: 'irreversible', approval: 'always' },
            inputSchema: z.object({}),
            outputSchema: z.object({ ok: z.boolean() }),
            handler: async () => {
              publishCalls += 1; // 真实副作用
              return { output: { ok: true } };
            },
          }),
          // 显式豁免审批的写：effects.approval='never'
          defineCapability<
            { id: string },
            Record<string, never>,
            RecordEntity,
            RecordDiff
          >({
            id: 'records.autoTag',
            title: '自动打标',
            description: '给记录打自动标签（可逆写，但明确无需审批）。',
            category: 'records',
            kind: 'write',
            effects: { approval: 'never' },
            inputSchema: z.object({ id: z.string() }),
            outputSchema: z.object({}),
            handler: async (ctx, input) => {
              const before = ctx.state.get(input.id);
              if (!before) throw new Error(`不存在: ${input.id}`);
              return {
                output: {},
                diff: {
                  added: [],
                  removed: [],
                  modified: [
                    { id: input.id, before, after: { ...before, props: { auto: true } } },
                  ],
                  propertyChanges: [],
                },
              };
            },
          }),
        ],
      },
    ],
  });
  return clientOf(kernel, AGENT);
}

function policyOf(decisions: AgentDecision[]): AgentPolicy & {
  observations: AgentObservation[];
} {
  let i = 0;
  const observations: AgentObservation[] = [];
  return {
    observations,
    async decide(obs) {
      observations.push(obs);
      return decisions[Math.min(i++, decisions.length - 1)];
    },
  };
}

describe('审批门 effect-aware（G1-2）', () => {
  it('危险 action（approval:always）过审批门；external 操作跳过 dryRun 预览、副作用不被触发', async () => {
    const sar = makeSar();
    const policy = policyOf([
      { kind: 'act', actions: [{ capabilityId: 'ext.publish', input: {} }] },
      { kind: 'done', summary: '发布被拦，收束。' },
    ]);
    let previewSeen: unknown = 'unset';
    const agent = createAgent(sar, {
      policy,
      approve: (_a, preview) => {
        previewSeen = preview.diff;
        return false; // 拒绝
      },
    });
    const result = await agent.run('发布工作集');

    // action 也过门（旧 kind==='write' 判据会漏）
    expect(result.trace[0]).toMatchObject({
      capabilityId: 'ext.publish',
      ok: false,
      blocked: true,
    });
    // external/irreversible → 未做 dryRun 预览：审批看到的 diff 为 undefined
    expect(previewSeen).toBeUndefined();
    // 关键：预览未触发外部副作用，拒绝后也未执行 → 计数为 0
    expect(publishCalls).toBe(0);
    // 观察目录带 effects，策略能据此判断风险
    const pub = policy.observations[0].catalog.find((c) => c.id === 'ext.publish');
    expect(pub?.effects?.approval).toBe('always');
    expect(pub?.effects?.external).toBe('write');
  });

  it('write 显式 approval:never 豁免审批门（approve 不被调用）', async () => {
    const sar = makeSar();
    const agent = createAgent(sar, {
      policy: policyOf([
        {
          kind: 'act',
          actions: [{ capabilityId: 'records.autoTag', input: { id: 'p1' } }],
        },
        { kind: 'done', summary: 'ok' },
      ]),
      approve: () => {
        throw new Error('approval:never 的写不应过审批门');
      },
    });
    const result = await agent.run('自动打标');
    expect(result.ok).toBe(true);
    expect(result.trace[0]).toMatchObject({ capabilityId: 'records.autoTag', ok: true });
  });
});
