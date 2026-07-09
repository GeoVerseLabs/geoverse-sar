import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAuditLog, createKernel, type SarKernel } from '@geoverse-sar/kernel';
import {
  InMemoryStateEngine,
  RecordDiffAlgebra,
  type RecordDiff,
  type RecordEntity,
} from '@geoverse-sar/engine-memory';
import {
  createHighlightAndNudgeWorkflow,
  createMemoryViewService,
  createRecordsPack,
  VIEW_SERVICE_KEY,
} from '@geoverse-sar/capabilities-records';
import type { AssistantTurn, LlmClient } from '@geoverse-sar/planner';
import { createAgent, createLlmPolicy } from '../src/index';
import type {
  AgentDecision,
  AgentEvent,
  AgentObservation,
  AgentPolicy,
} from '../src/index';

const rec = (
  id: string,
  x: number,
  y: number,
  props: Record<string, unknown> = {},
): RecordEntity => ({
  id,
  x,
  y,
  props,
});

function makeKernel(opts: { audit?: boolean } = {}): {
  kernel: SarKernel<RecordEntity, RecordDiff>;
  engine: InMemoryStateEngine;
  audit?: ReturnType<typeof createAuditLog>;
} {
  const engine = new InMemoryStateEngine([
    rec('p1', 0, 0, { type: 'poi' }),
    rec('p2', 10, 0, { type: 'poi' }),
  ]);
  const audit = opts.audit ? createAuditLog() : undefined;
  const kernel = createKernel<RecordEntity, RecordDiff>({
    engine,
    algebra: new RecordDiffAlgebra(),
    packs: [createRecordsPack()],
    workflows: [createHighlightAndNudgeWorkflow()],
    services: { [VIEW_SERVICE_KEY]: createMemoryViewService() },
    middleware: audit ? [audit.middleware] : undefined,
  });
  return { kernel, engine, audit };
}

/** 脚本化策略：按步吐预设决策（把非确定性隔离在 Policy 端口外）。 */
function scriptedPolicy(
  decisions: AgentDecision[],
): AgentPolicy & { observations: AgentObservation[] } {
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

describe('createAgent（observe→plan→act）', () => {
  it('多步循环达成目标：观察反馈上一步结果、workflow 宏撤销、审计同栈归因 entry=agent', async () => {
    const { kernel, engine, audit } = makeKernel({ audit: true });
    const policy = scriptedPolicy([
      {
        kind: 'act',
        actions: [
          { capabilityId: 'records.query', input: { propsEquals: { type: 'poi' } } },
        ],
      },
      {
        kind: 'act',
        actions: [
          {
            capabilityId: 'workflow.highlightAndNudge',
            input: { propsEquals: { type: 'poi' }, dx: 15, dy: 0 },
          },
        ],
      },
      { kind: 'done', summary: '所有 poi 已高亮并右移 15。' },
    ]);
    const agent = createAgent(kernel, { policy, maxSteps: 5 });
    const events: AgentEvent[] = [];
    const result = await agent.run('把所有 poi 高亮并右移 15', {
      onEvent: (e) => events.push(e),
    });

    expect(result).toMatchObject({ ok: true, stopReason: 'done', steps: 3 });
    expect(result.summary).toContain('高亮');
    expect(result.trace).toHaveLength(2);
    expect(result.trace.every((t) => t.ok)).toBe(true);

    // 真实生效 + 宏撤销一个单元
    expect(engine.snapshot().entities.get('p1')!.x).toBe(15);
    expect(engine.snapshot().entities.get('p1')!.props.highlighted).toBe(true);
    expect(engine.undoDepth).toBe(1);

    // 观察闭环：第 2 步能看到第 1 步查询结果；第 3 步能看到工作流输出
    expect(policy.observations[0].lastResults).toHaveLength(0);
    expect(policy.observations[1].lastResults[0]).toMatchObject({
      capabilityId: 'records.query',
      ok: true,
    });
    expect(policy.observations[2].lastResults[0].capabilityId).toBe(
      'workflow.highlightAndNudge',
    );
    // 观察面带权限裁剪目录与实体计数
    expect(policy.observations[0].entityCount).toBe(2);
    expect(policy.observations[0].catalog.some((c) => c.id === 'records.translate')).toBe(
      true,
    );

    // 治理：审计中间件把 agent 动作同栈入账（含工作流内步）
    const agentEntries = audit!.entries({ entry: 'agent' });
    expect(agentEntries.length).toBeGreaterThanOrEqual(2);
    expect(agentEntries.every((e) => e.entry === 'agent')).toBe(true);

    const kinds = events.map((e) => e.type);
    expect(kinds[0]).toBe('observe');
    expect(kinds.at(-1)).toBe('end');
  });

  it('审批门：写动作 dryRun 预览交 approve，拒绝 → blocked、状态不动、策略下一步可见', async () => {
    const { kernel, engine } = makeKernel();
    const policy = scriptedPolicy([
      {
        kind: 'act',
        actions: [{ capabilityId: 'records.remove', input: { ids: ['p1'] } }],
      },
      { kind: 'done', summary: '删除被拦，收束。' },
    ]);
    const previews: unknown[] = [];
    const events: AgentEvent[] = [];
    const agent = createAgent(kernel, {
      policy,
      approve: (_action, preview) => {
        previews.push(preview.diff);
        return false; // 一律拒绝
      },
    });
    const result = await agent.run('删除 p1', { onEvent: (e) => events.push(e) });

    expect(result.ok).toBe(true);
    expect(result.trace[0]).toMatchObject({
      capabilityId: 'records.remove',
      ok: false,
      blocked: true,
    });
    // 审批时拿到了 dryRun diff 预览
    expect(previews).toHaveLength(1);
    expect(previews[0]).toBeDefined();
    // 状态未变：p1 还在、撤销栈不长
    expect(engine.snapshot().entities.has('p1')).toBe(true);
    expect(engine.undoDepth).toBe(0);
    expect(events.some((e) => e.type === 'blocked')).toBe(true);
    // 策略在第 2 步观察到被拦
    expect(policy.observations[1].lastResults[0].blocked).toBe(true);

    // read 动作不过门：query 不触发 approve
    const readOnly = createAgent(kernel, {
      policy: scriptedPolicy([
        { kind: 'act', actions: [{ capabilityId: 'records.query', input: {} }] },
        { kind: 'done', summary: 'ok' },
      ]),
      approve: () => {
        throw new Error('read 不应过审批门');
      },
    });
    await expect(readOnly.run('查一下')).resolves.toMatchObject({ ok: true });
  });

  it('权限白名单：目录裁剪（策略看不见受限能力）+ 硬调也 permission_denied', async () => {
    const { kernel } = makeKernel();
    // 注册一个声明了 permissions 的受限写能力
    kernel.registry.register({
      id: 'records.purge',
      title: '清空数据',
      description: '删除全部记录（危险操作），需要 records:admin 权限授权后方可调用。',
      category: 'records',
      kind: 'write',
      permissions: ['records:admin'],
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      handler: async () => ({ output: {} }),
    });
    const caller = { entry: 'agent', grantedPermissions: [] as string[] } as const;
    const policy = scriptedPolicy([
      // 无视目录硬调受限能力
      { kind: 'act', actions: [{ capabilityId: 'records.purge', input: {} }] },
      { kind: 'done', summary: '无权限，收束。' },
    ]);
    const agent = createAgent(kernel, { policy, caller });
    const result = await agent.run('清空数据');

    // 目录裁剪：策略的观察面看不见 records.purge
    expect(policy.observations[0].catalog.some((c) => c.id === 'records.purge')).toBe(
      false,
    );
    // 硬调也被单漏斗拦下（同一 isGranted 判定）
    expect(result.trace[0].ok).toBe(false);
    expect(result.trace[0].error).toContain('permission_denied');
    // 策略下一步能观察到失败并收束
    expect(result).toMatchObject({ ok: true, stopReason: 'done' });
  });

  it('AbortSignal 中止 + maxSteps 预算 + policy 抛错三种收束', async () => {
    const { kernel } = makeKernel();

    const aborter = new AbortController();
    aborter.abort();
    const agent1 = createAgent(kernel, {
      policy: scriptedPolicy([{ kind: 'done', summary: 'x' }]),
    });
    await expect(agent1.run('已中止', { signal: aborter.signal })).resolves.toMatchObject(
      {
        ok: false,
        stopReason: 'aborted',
      },
    );

    const looping = scriptedPolicy([
      { kind: 'act', actions: [{ capabilityId: 'records.query', input: {} }] },
    ]);
    const agent2 = createAgent(kernel, { policy: looping, maxSteps: 3 });
    await expect(agent2.run('永不收束')).resolves.toMatchObject({
      ok: false,
      stopReason: 'max_steps',
      steps: 3,
    });

    const agent3 = createAgent(kernel, {
      policy: {
        decide: async () => {
          throw new Error('策略崩了');
        },
      },
    });
    await expect(agent3.run('崩溃')).resolves.toMatchObject({
      ok: false,
      stopReason: 'policy_error',
      error: '策略崩了',
    });
  });
});

describe('createLlmPolicy（LLM 作策略）', () => {
  it('tool_calls → 动作（名字双射还原）；纯文本 → done；坏 JSON 参数不崩', async () => {
    const { kernel } = makeKernel();
    const turns: AssistantTurn[] = [
      {
        text: '先查询确认',
        toolCalls: [
          {
            id: 'c1',
            name: 'records__query',
            arguments: '{"propsEquals":{"type":"poi"}}',
          },
        ],
      },
      { text: '目标已达成。', toolCalls: [] },
    ];
    let i = 0;
    const requests: { toolCount: number; userContent: string }[] = [];
    const client: LlmClient = {
      async complete(req) {
        requests.push({
          toolCount: req.tools.length,
          userContent: String(req.messages[0].content),
        });
        return turns[Math.min(i++, turns.length - 1)];
      },
    };
    const policy = createLlmPolicy(kernel, { client, system: '单位是平面坐标。' });

    const obs: Parameters<typeof policy.decide>[0] = {
      goal: '查 poi',
      step: 1,
      maxSteps: 8,
      entityCount: 2,
      undoDepth: 0,
      catalog: [],
      lastResults: [],
    };
    const d1 = await policy.decide(obs);
    expect(d1).toMatchObject({
      kind: 'act',
      note: '先查询确认',
      actions: [
        { capabilityId: 'records.query', input: { propsEquals: { type: 'poi' } } },
      ],
    });
    // 工具目录随规格给到（describeAll 投影），观察 JSON 进 user 消息
    expect(requests[0].toolCount).toBe(9);
    expect(requests[0].userContent).toContain('"goal": "查 poi"');

    const d2 = await policy.decide({ ...obs, step: 2 });
    expect(d2).toEqual({ kind: 'done', summary: '目标已达成。' });
  });

  it('端到端：LLM 策略驱动 agent 循环完成目标（脚本化 client）', async () => {
    const { kernel, engine } = makeKernel();
    const turns: AssistantTurn[] = [
      {
        text: '',
        toolCalls: [
          {
            id: 'c1',
            name: 'workflow__highlightAndNudge',
            arguments: '{"propsEquals":{"type":"poi"},"dx":5,"dy":0}',
          },
        ],
      },
      { text: '已完成高亮与平移。', toolCalls: [] },
    ];
    let i = 0;
    const client: LlmClient = {
      complete: async () => turns[Math.min(i++, turns.length - 1)],
    };
    const agent = createAgent(kernel, { policy: createLlmPolicy(kernel, { client }) });
    const result = await agent.run('把所有 poi 高亮并右移 5');

    expect(result).toMatchObject({ ok: true, stopReason: 'done', steps: 2 });
    expect(engine.snapshot().entities.get('p1')!.x).toBe(5);
    expect(engine.undoDepth).toBe(1);
  });
});
