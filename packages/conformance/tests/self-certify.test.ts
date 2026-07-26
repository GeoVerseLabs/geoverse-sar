/**
 * U5-A 自食：内建 records 能力包过一致性套件（certified 的样板姿势）。
 * 套件形态=createCapabilityPackTestSuite（vitest hooks 显式传入，库本体不依赖测试框架）。
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createKernel } from '@geoverse-sar/kernel';
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
import { createCapabilityPackTestSuite } from '../src/index';

const seed = (): RecordEntity[] => [
  { id: 'p1', x: 0, y: 0, props: { type: 'poi' } },
  { id: 'p2', x: 10, y: 0, props: { type: 'poi' } },
];

createCapabilityPackTestSuite(
  'capabilities-records（内建包自证）',
  {
    pack: createRecordsPack(),
    createHarness: () => ({
      kernel: createKernel<RecordEntity, RecordDiff>({
        engine: new InMemoryStateEngine(seed()),
        algebra: new RecordDiffAlgebra(),
        packs: [createRecordsPack()],
        services: { [VIEW_SERVICE_KEY]: createMemoryViewService() },
      }),
    }),
    samples: {
      'records.query': { inputs: [{}, { propsEquals: { type: 'poi' } }] },
      'records.add': {
        inputs: [{ records: [{ id: 'n1', x: 1, y: 2 }] }],
        arbitrary: fc
          .record({
            x: fc.integer({ min: -50, max: 50 }),
            y: fc.integer({ min: -50, max: 50 }),
          })
          .map((p, i) => ({ records: [{ id: `gen-${p.x}-${p.y}-${String(i)}`, ...p }] })),
      },
      'records.translate': {
        inputs: [{ ids: ['p1'], dx: 5, dy: 0 }],
        arbitrary: fc
          .record({
            dx: fc.integer({ min: -20, max: 20 }),
            dy: fc.integer({ min: -20, max: 20 }),
          })
          .map((d) => ({ ids: ['p1', 'p2'], ...d })),
      },
      'records.setProps': { inputs: [{ ids: ['p1'], props: { level: 2 } }] },
      'records.remove': { inputs: [{ ids: ['p2'] }] },
      'records.focus': { inputs: [{ ids: ['p1'] }] },
      'history.undo': { inputs: [{}] },
      'history.redo': { inputs: [{}] },
    },
  },
  { describe, it, expect },
);
