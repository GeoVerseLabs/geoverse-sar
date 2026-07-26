/**
 * U2-4 evolution 准入接线（RFC-0011 §五）：L2 合成 workflow 的 enable 前置=
 * 在含该合成物的沙箱 kernel 上跑域 scenario 集，任一失败停在 pending。
 * evolution 与 eval 互不依赖——准入是组装根的纪律，本测试即该纪律的端到端形态。
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
  createMemoryViewService,
  createRecordsPack,
  VIEW_SERVICE_KEY,
} from '@geoverse-sar/capabilities-records';
import { compileDraft, type WorkflowDraft } from '@geoverse-sar/evolution';
import { runScenarios, type EvalScenario } from '../src/index';

const seed = (): RecordEntity[] => [
  { id: 'p1', x: 0, y: 0, props: { type: 'poi' } },
  { id: 'p2', x: 10, y: 0, props: { type: 'poi' } },
  { id: 'r1', x: 5, y: 5, props: { type: 'road' } },
];

/** 沙箱世界工厂：把合成 workflow 装进全新 kernel（enable 前的试运行环境）。 */
function sandboxWith(draft: WorkflowDraft) {
  return (ctx: { middleware: Middleware[] }) => ({
    kernel: createKernel<RecordEntity, RecordDiff>({
      engine: new InMemoryStateEngine(seed()),
      algebra: new RecordDiffAlgebra(),
      packs: [createRecordsPack()],
      workflows: [compileDraft(draft)],
      services: { [VIEW_SERVICE_KEY]: createMemoryViewService() },
      middleware: ctx.middleware,
    }),
  });
}

/** 域评测集（准入门的单位）：合成物冒烟 + 世界不变量。 */
function admissionScenarios(draft: WorkflowDraft): EvalScenario[] {
  return [
    {
      id: `admission-smoke-${draft.id}`,
      setup: sandboxWith(draft),
      plan: [{ invoke: { capabilityId: draft.id, input: {} } }],
      expect: {
        // 域不变量：演示域的三条种子记录必须健在——合成物不得顺手清场
        entityCount: 3,
        entities: [{ id: 'p1' }, { id: 'p2' }, { id: 'r1' }],
        outcomes: [{ capabilityId: draft.id, ok: true }],
      },
    },
  ];
}

const evilDraft: WorkflowDraft = {
  id: 'workflow.synthEvil',
  title: '合成的坏流程',
  description: '劣化合成示例：借"整理"之名把种子记录删掉，应被评测集拦在 pending。',
  steps: [{ id: 'wipe', capability: 'records.remove', input: { ids: ['p1', 'p2'] } }],
};

const goodDraft: WorkflowDraft = {
  id: 'workflow.synthNudge',
  title: '合成的轻移流程',
  description: '良性合成示例：把 p1 向东轻移一步，可整体撤销。',
  steps: [
    {
      id: 'nudge',
      capability: 'records.translate',
      input: { ids: ['p1'], dx: 1, dy: 0 },
    },
  ],
};

describe('L2 合成 workflow 准入门（enable 必过 scenario 集）', () => {
  it('故意劣化的合成 workflow → 评测集判红 → 停在 pending（不 enable）', async () => {
    const gate = await runScenarios(admissionScenarios(evilDraft));
    expect(gate.ok).toBe(false);
    expect(gate.results[0].failures.join('\n')).toContain('entityCount');
    // 组装根纪律：gate.ok===false ⇒ 不调用 synthesis.enable，状态停 pending。
  });

  it('良性合成 workflow → 评测集全绿 → 方可 enable', async () => {
    const gate = await runScenarios(admissionScenarios(goodDraft));
    expect(gate.results[0].failures).toEqual([]);
    expect(gate.ok).toBe(true);
  });
});
