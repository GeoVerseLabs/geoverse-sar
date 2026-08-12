import { describe, expect, it } from 'vitest';
import { runAiToolCallExample } from './docs-snippets/ai-tool-call';
import { runRecordsWorkflowExample } from './docs-snippets/records-workflow';

describe('docs Living Doc snippets', () => {
  it('workflows.md 片段与当前 workflow API 可执行', async () => {
    const result = await runRecordsWorkflowExample();
    expect(result.outcome.ok).toBe(true);
    expect(result.undoDepth).toBe(1);
    expect(result.p1).toMatchObject({ x: 2, y: 0, props: { highlighted: true } });
  });

  it('entries.md 片段与当前 skill/client API 可执行', async () => {
    const result = await runAiToolCallExample();
    expect(result.toolName).toBe('records__query');
    expect(result.catalogSize).toBeGreaterThan(0);
    expect(result.result.is_error).toBe(false);
    expect(result.result.outcome.output).toMatchObject({ count: 1 });
  });
});
