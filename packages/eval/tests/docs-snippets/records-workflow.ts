import { createKernel } from '@geoverse-sar/kernel';
import {
  createHighlightAndNudgeWorkflow,
  createMemoryViewService,
  createRecordsPack,
  VIEW_SERVICE_KEY,
} from '@geoverse-sar/capabilities-records';
import {
  InMemoryStateEngine,
  RecordDiffAlgebra,
  type RecordEntity,
} from '@geoverse-sar/engine-memory';

const seed: RecordEntity[] = [
  { id: 'p1', x: 0, y: 0, props: { type: 'poi' } },
  { id: 'p2', x: 10, y: 0, props: { type: 'poi' } },
  { id: 'r1', x: 5, y: 5, props: { type: 'road' } },
];

const engine = new InMemoryStateEngine(seed);
const kernel = createKernel({
  engine,
  algebra: new RecordDiffAlgebra(),
  packs: [createRecordsPack()],
  workflows: [createHighlightAndNudgeWorkflow()],
  services: { [VIEW_SERVICE_KEY]: createMemoryViewService() },
});

export async function runRecordsWorkflowExample() {
  const outcome = await kernel.invoke('workflow.highlightAndNudge', {
    propsEquals: { type: 'poi' },
    dx: 2,
    dy: 0,
  });
  return {
    outcome,
    undoDepth: engine.undoDepth,
    p1: engine.snapshot().entities.get('p1'),
  };
}
