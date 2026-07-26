/**
 * U2 deterministic 档：records 域 scenario 集（geoverse-free，随 CI 子集运行）。
 * 覆盖：增删改/undo/dryRun 纯性/宏撤销折叠 + goal 驱动（scripted LLM 仍确定性）。
 * 确定性判据：同一 scenario 跑三遍 stateHash 逐字节相同。
 */
import { describe, expect, it } from 'vitest';
import { createKernel, type Middleware } from '@geoverse-sar/kernel';
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
import {
  createScriptedLlm,
  runScenario,
  runScenarios,
  type EvalScenario,
} from '../src/index';

const seed = (): RecordEntity[] => [
  { id: 'p1', x: 0, y: 0, props: { type: 'poi' } },
  { id: 'p2', x: 10, y: 0, props: { type: 'poi' } },
  { id: 'r1', x: 5, y: 5, props: { type: 'road' } },
];

function recordsWorld(ctx: { middleware: Middleware[] }) {
  const kernel = createKernel<RecordEntity, RecordDiff>({
    engine: new InMemoryStateEngine(seed()),
    algebra: new RecordDiffAlgebra(),
    packs: [createRecordsPack()],
    workflows: [createHighlightAndNudgeWorkflow()],
    services: { [VIEW_SERVICE_KEY]: createMemoryViewService() },
    middleware: ctx.middleware,
  });
  return { kernel };
}

const scenarios: EvalScenario[] = [
  {
    id: 'records-add',
    setup: recordsWorld,
    plan: [
      {
        invoke: {
          capabilityId: 'records.add',
          input: { records: [{ id: 'n1', x: 1, y: 2 }] },
        },
      },
    ],
    expect: {
      entityCount: 4,
      undoDepth: 1,
      entities: [{ id: 'n1', match: { x: 1, y: 2 } }],
      auditSequence: ['records.add'],
    },
  },
  {
    id: 'records-translate-undo',
    setup: recordsWorld,
    plan: [
      {
        invoke: {
          capabilityId: 'records.translate',
          input: { ids: ['p1'], dx: 5, dy: 0 },
        },
      },
      { undo: 1 },
    ],
    expect: {
      undoDepth: 0,
      entities: [{ id: 'p1', match: { x: 0, y: 0 } }],
      outcomes: [{ capabilityId: 'records.translate', ok: true }],
    },
  },
  {
    id: 'records-set-props',
    setup: recordsWorld,
    plan: [
      {
        invoke: {
          capabilityId: 'records.setProps',
          input: { ids: ['p1', 'p2'], props: { level: 2 } },
        },
      },
    ],
    expect: {
      undoDepth: 1,
      entities: [
        { id: 'p1', match: { props: { level: 2 } } },
        { id: 'p2', match: { props: { level: 2 } } },
        { id: 'r1', match: { props: { type: 'road' } } },
      ],
    },
  },
  {
    id: 'records-remove',
    setup: recordsWorld,
    plan: [{ invoke: { capabilityId: 'records.remove', input: { ids: ['r1'] } } }],
    expect: { entityCount: 2, entities: [{ id: 'r1', absent: true }] },
  },
  {
    id: 'records-dryrun-purity',
    setup: recordsWorld,
    plan: [
      {
        invoke: {
          capabilityId: 'records.translate',
          input: { ids: ['p1'], dx: 99, dy: 99 },
          dryRun: true,
        },
      },
    ],
    expect: {
      undoDepth: 0,
      entities: [{ id: 'p1', match: { x: 0, y: 0 } }],
      outcomes: [{ capabilityId: 'records.translate', ok: true }],
    },
  },
  {
    id: 'records-macro-workflow',
    setup: recordsWorld,
    plan: [
      {
        invoke: {
          capabilityId: 'workflow.highlightAndNudge',
          input: { propsEquals: { type: 'poi' }, dx: 2, dy: 0 },
        },
      },
    ],
    expect: {
      undoDepth: 1, // 宏撤销折叠：多写步恰一个撤销单元
      entities: [
        { id: 'p1', match: { x: 2 } },
        { id: 'p2', match: { x: 12 } },
      ],
      auditSequence: ['workflow.highlightAndNudge'],
    },
  },
  {
    id: 'goal-query-poi',
    setup: recordsWorld,
    plan: {
      goal: '查一下有多少 poi',
      llm: createScriptedLlm([
        {
          text: '',
          toolCalls: [
            {
              id: 'c1',
              name: 'records__query',
              arguments: '{"propsEquals":{"type":"poi"}}',
            },
          ],
        },
        { text: '共 2 条 poi。', toolCalls: [] },
      ]),
    },
    expect: { entityCount: 3, undoDepth: 0, auditSequence: ['records.query'] },
  },
  {
    id: 'goal-translate-p2',
    setup: recordsWorld,
    plan: {
      goal: '把 p2 移回原点',
      llm: createScriptedLlm([
        {
          text: '',
          toolCalls: [
            {
              id: 'c1',
              name: 'records__translate',
              arguments: '{"ids":["p2"],"dx":-10,"dy":0}',
            },
          ],
        },
        { text: '已移动。', toolCalls: [] },
      ]),
    },
    expect: {
      undoDepth: 1,
      entities: [{ id: 'p2', match: { x: 0, y: 0 } }],
      auditSequence: ['records.translate'],
    },
  },
];

describe('records 域 scenario 集（deterministic 档）', () => {
  it('全集绿（runScenarios 聚合）', async () => {
    const suite = await runScenarios(scenarios);
    const failed = suite.results.filter((r) => !r.ok);
    expect(failed.map((r) => `${r.id}: ${r.failures.join('；')}`)).toEqual([]);
    expect(suite.ok).toBe(true);
  });

  it('确定性：同一 scenario 跑三遍 stateHash 逐字节相同', async () => {
    const hashes: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await runScenario(
        scenarios.find((s) => s.id === 'records-macro-workflow')!,
      );
      expect(r.ok).toBe(true);
      hashes.push(r.stateHash);
    }
    expect(new Set(hashes).size).toBe(1);
  });

  it('runner 判负能力自证：错误期望产出结构化 failures 而非静默通过', async () => {
    const wrong: EvalScenario = {
      id: 'wrong-expect',
      setup: recordsWorld,
      plan: [{ invoke: { capabilityId: 'records.remove', input: { ids: ['r1'] } } }],
      expect: { entityCount: 99, entities: [{ id: 'r1', match: { x: 5 } }] },
    };
    const r = await runScenario(wrong);
    expect(r.ok).toBe(false);
    expect(r.failures.length).toBeGreaterThanOrEqual(2);
    expect(r.failures.join('\n')).toContain('entityCount');
  });
});
