/**
 * F4：invoke 中间件 span（成功/失败/dryRun 属性与状态）+ EventBus 桥
 * （workflow 成对开合、engine:transaction 零时长 span）。
 * 用 sdk-trace-base 的 InMemorySpanExporter 断言真实导出面。
 */
import { describe, expect, it } from 'vitest';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { createKernel } from '@geoverse-sar/kernel';
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
import { bridgeEventsToOtel, createOtelMiddleware } from '../src/index';

function setup() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer('sar-test');
  const kernel = createKernel<RecordEntity, RecordDiff>({
    engine: new InMemoryStateEngine([{ id: 'p1', x: 0, y: 0, props: { type: 'poi' } }]),
    algebra: new RecordDiffAlgebra(),
    packs: [createRecordsPack()],
    workflows: [createHighlightAndNudgeWorkflow()],
    services: { [VIEW_SERVICE_KEY]: createMemoryViewService() },
    middleware: [createOtelMiddleware(tracer, { attributes: { 'sar.ws': 'w1' } })],
  });
  return { exporter, tracer, kernel };
}

describe('createOtelMiddleware', () => {
  it('成功/失败/dryRun 各一 span：命名、审计维属性、错误状态', async () => {
    const { exporter, kernel } = setup();
    await kernel.invoke(
      'records.translate',
      { ids: ['p1'], dx: 1, dy: 0 },
      {
        caller: { entry: 'ai', id: 'copilot' },
      },
    );
    await kernel.invoke('records.translate', { ids: ['ghost'], dx: 1, dy: 0 });
    await kernel.invoke('records.add', { records: [{ x: 1, y: 2 }] }, { dryRun: true });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(3);

    const okSpan = spans[0];
    expect(okSpan.name).toBe('sar.invoke records.translate');
    expect(okSpan.attributes).toMatchObject({
      'sar.ws': 'w1',
      'sar.capability_id': 'records.translate',
      'sar.kind': 'write',
      'sar.entry': 'ai',
      'sar.caller_id': 'copilot',
      'sar.ok': true,
      'sar.has_diff': true,
      'sar.dry_run': false,
    });

    const failSpan = spans[1];
    expect(failSpan.attributes['sar.ok']).toBe(false);
    expect(failSpan.attributes['sar.error_code']).toBe('handler_error');
    expect(failSpan.status.code).toBe(2); // SpanStatusCode.ERROR

    const drySpan = spans[2];
    expect(drySpan.attributes['sar.dry_run']).toBe(true);
    expect(drySpan.attributes['sar.ok']).toBe(true);
  });
});

describe('bridgeEventsToOtel', () => {
  it('workflow 成对开合（含每步 invoke 子 span）+ engine:transaction 零时长 span；解绑停止导出', async () => {
    const { exporter, tracer, kernel } = setup();
    const off = bridgeEventsToOtel(kernel.events, tracer);

    const out = await kernel.invoke('workflow.highlightAndNudge', {
      propsEquals: { type: 'poi' },
      dx: 5,
      dy: 0,
    });
    expect(out.ok).toBe(true);

    const spans = exporter.getFinishedSpans();
    const wf = spans.find((s) => s.name === 'sar.workflow workflow.highlightAndNudge');
    expect(wf).toBeDefined();
    expect(wf!.attributes['sar.ok']).toBe(true);
    // 宏撤销：整条工作流恰好一个 engine:transaction
    expect(spans.filter((s) => s.name === 'sar.transaction')).toHaveLength(1);
    // 工作流内步骤照常有 invoke span（同栈）
    expect(spans.some((s) => s.name === 'sar.invoke records.query')).toBe(true);

    // undo 也进 trace（origin=undo）
    kernel.engine.undo();
    const undoSpan = exporter
      .getFinishedSpans()
      .filter((s) => s.name === 'sar.transaction')
      .at(-1)!;
    expect(undoSpan.attributes['sar.origin']).toBe('undo');

    off();
    const count = exporter.getFinishedSpans().length;
    kernel.engine.redo();
    expect(exporter.getFinishedSpans()).toHaveLength(count);
  });
});
