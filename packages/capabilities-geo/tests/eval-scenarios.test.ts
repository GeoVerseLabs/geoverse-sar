/**
 * U2 geo 域 scenario 集（4 个）：eval 的 deterministic 档在真实 editor-core 引擎上。
 * 本包依赖 geoverse（file:），CI geoverse-free 期间随本地 pnpm verify 全量跑。
 */
import { describe, expect, it } from 'vitest';
import type { Point } from 'geojson';
import { createKernel, type Middleware } from '@geoverse-sar/kernel';
import { runScenario, runScenarios, type EvalScenario } from '@geoverse-sar/eval';
import {
  ChangeSetAlgebra,
  createGeoEngine,
  type ChangeSet,
  type EditableFeature,
} from '@geoverse-sar/engine-geo';
import {
  createGeoHighlightAndNudgeWorkflow,
  createGeoPack,
  createMemoryGeoViewService,
  VIEW_SERVICE_KEY,
  type CreateGeoPackOptions,
} from '../src/index';

const pt = (
  id: string,
  x: number,
  y: number,
  props: Record<string, unknown> = {},
): EditableFeature => ({
  id,
  geometry: { type: 'Point', coordinates: [x, y] } as Point,
  properties: props,
});

const seed = (): EditableFeature[] => [
  pt('b1', 0, 0, { type: 'building' }),
  pt('b2', 20, 0, { type: 'building' }),
  pt('r1', 5, 5, { type: 'road' }),
];

const geoWorld =
  (options: CreateGeoPackOptions = {}) =>
  (ctx: { middleware: Middleware[] }) => ({
    kernel: createKernel<EditableFeature, ChangeSet>({
      engine: createGeoEngine({ features: seed() }),
      algebra: new ChangeSetAlgebra(),
      packs: [createGeoPack(options)],
      workflows: [createGeoHighlightAndNudgeWorkflow()],
      services: { [VIEW_SERVICE_KEY]: createMemoryGeoViewService() },
      middleware: ctx.middleware,
    }),
  });

const scenarios: EvalScenario[] = [
  {
    id: 'geo-add-point',
    setup: geoWorld(),
    plan: [
      {
        invoke: {
          capabilityId: 'features.add',
          input: { features: [{ id: 'n1', x: 3, y: 4, props: { type: 'poi' } }] },
        },
      },
    ],
    expect: {
      entityCount: 4,
      undoDepth: 1,
      entities: [
        { id: 'n1', match: { geometry: { type: 'Point', coordinates: [3, 4] } } },
      ],
      auditSequence: ['features.add'],
    },
  },
  {
    id: 'geo-translate-undo',
    setup: geoWorld(),
    plan: [
      {
        invoke: {
          capabilityId: 'features.translate',
          input: { ids: ['b1'], dx: 7, dy: 0 },
        },
      },
      { undo: 1 },
    ],
    expect: {
      undoDepth: 0,
      entities: [{ id: 'b1', match: { geometry: { coordinates: [0, 0] } } }],
    },
  },
  {
    id: 'geo-buffer-quantity-km',
    setup: geoWorld({ localUnit: 'm' }),
    plan: [
      {
        invoke: {
          capabilityId: 'features.buffer',
          input: { ids: ['b1'], distance: { value: 0.01, unit: 'km' } },
        },
      },
    ],
    expect: {
      entityCount: 4, // 派生新面要素，原要素保留
      undoDepth: 1,
      entities: [{ id: 'b1' }],
      outcomes: [{ capabilityId: 'features.buffer', ok: true }],
    },
  },
  {
    id: 'geo-macro-workflow',
    setup: geoWorld(),
    plan: [
      {
        invoke: {
          capabilityId: 'workflow.highlightAndNudge',
          input: { propsEquals: { type: 'building' }, dx: 2, dy: 0 },
        },
      },
    ],
    expect: {
      undoDepth: 1, // 宏撤销折叠
      entities: [
        { id: 'b1', match: { geometry: { coordinates: [2, 0] } } },
        { id: 'b2', match: { geometry: { coordinates: [22, 0] } } },
      ],
    },
  },
];

describe('geo 域 scenario 集（deterministic 档，真实 editor-core 引擎）', () => {
  it('全集绿', async () => {
    const suite = await runScenarios(scenarios);
    const failed = suite.results.filter((r) => !r.ok);
    expect(failed.map((r) => `${r.id}: ${r.failures.join('；')}`)).toEqual([]);
    expect(suite.ok).toBe(true);
  });

  it('确定性：宏工作流 scenario 跑三遍 stateHash 相同', async () => {
    const hashes = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const r = await runScenario(scenarios.find((s) => s.id === 'geo-macro-workflow')!);
      expect(r.ok).toBe(true);
      hashes.add(r.stateHash);
    }
    expect(hashes.size).toBe(1);
  });
});
