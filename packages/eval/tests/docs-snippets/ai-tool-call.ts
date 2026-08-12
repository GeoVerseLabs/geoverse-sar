import { clientOf, createKernel } from '@geoverse-sar/kernel';
import { createRecordsPack } from '@geoverse-sar/capabilities-records';
import { InMemoryStateEngine, RecordDiffAlgebra } from '@geoverse-sar/engine-memory';
import { handleToolCall, toToolSpecs } from '@geoverse-sar/skill';

const kernel = createKernel({
  engine: new InMemoryStateEngine([{ id: 'p1', x: 0, y: 0, props: { type: 'poi' } }]),
  algebra: new RecordDiffAlgebra(),
  packs: [createRecordsPack()],
});

export async function runAiToolCallExample() {
  const tools = toToolSpecs(kernel);
  const client = clientOf(kernel, { entry: 'ai', id: 'docs-smoke' });
  const result = await handleToolCall(kernel, 'records__query', {
    propsEquals: { type: 'poi' },
  });
  return {
    toolName: tools.find((tool) => tool.name === 'records__query')?.name,
    catalogSize: (await client.catalog()).length,
    result,
  };
}
