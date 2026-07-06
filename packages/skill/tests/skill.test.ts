import { describe, expect, it } from 'vitest';
import { createKernel, type SarKernel } from '@geoverse-sar/kernel';
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
  handleToolCall,
  toCapabilityId,
  toToolName,
  toToolSpecs,
} from '../src/index';

const rec = (id: string, x: number, y: number, props: Record<string, unknown> = {}): RecordEntity => ({
  id,
  x,
  y,
  props,
});

const seed = [rec('p1', 0, 0, { type: 'poi' }), rec('p2', 10, 0, { type: 'poi' })];

function makeKernel(): { kernel: SarKernel<RecordEntity, RecordDiff>; engine: InMemoryStateEngine } {
  const engine = new InMemoryStateEngine(seed);
  const kernel = createKernel<RecordEntity, RecordDiff>({
    engine,
    algebra: new RecordDiffAlgebra(),
    packs: [createRecordsPack()],
    workflows: [createHighlightAndNudgeWorkflow()],
    services: { [VIEW_SERVICE_KEY]: createMemoryViewService() },
  });
  return { kernel, engine };
}

describe('toToolSpecs（描述符 ≡ Claude 工具定义）', () => {
  it('目录完整投影：9 能力（8 记录域 + 1 工作流即工具），字段对齐', () => {
    const { kernel } = makeKernel();
    const specs = toToolSpecs(kernel);
    expect(specs).toHaveLength(9);
    expect(specs.map((s) => s.name)).toContain('workflow__highlightAndNudge');

    const translate = specs.find((s) => s.name === 'records__translate')!;
    expect(translate.description).toContain('平移');
    expect(translate.input_schema).toMatchObject({
      type: 'object',
      required: ['ids', 'dx', 'dy'],
    });
  });

  it('工具名双射：`.` ↔ `__`，且满足 Claude tool name 字符集', () => {
    expect(toToolName('records.query')).toBe('records__query');
    expect(toCapabilityId('records__query')).toBe('records.query');
    const { kernel } = makeKernel();
    for (const s of toToolSpecs(kernel)) {
      expect(s.name).toMatch(/^[a-zA-Z0-9_-]{1,128}$/);
      expect(kernel.registry.has(toCapabilityId(s.name))).toBe(true);
    }
  });

  it('schema 平价：toToolSpecs 与 toPaletteItems 的 JSON Schema 同源同构', () => {
    const { kernel } = makeKernel();
    const specs = toToolSpecs(kernel);
    const palette = kernel.toPaletteItems();
    expect(specs.length).toBe(palette.length);
    for (const item of palette) {
      const spec = specs.find((s) => s.name === toToolName(item.id))!;
      expect(spec.input_schema).toEqual(item.inputJsonSchema);
      expect(spec.description).toBe(item.description);
    }
  });

  it('schema 平价快照：records.translate 的 input_schema 形状稳定', () => {
    const { kernel } = makeKernel();
    const spec = toToolSpecs(kernel).find((s) => s.name === 'records__translate')!;
    expect(spec.input_schema).toMatchSnapshot();
  });

  it('权限化目录裁剪：grantedPermissions 为空时受限能力不可见', () => {
    const { kernel } = makeKernel();
    kernel.registry.register({
      id: 'admin.wipe',
      title: '受限',
      description: '需要 admin。',
      category: 'admin',
      kind: 'action',
      permissions: ['admin'],
      inputSchema: kernel.registry.get('records.query')!.inputSchema,
      outputSchema: kernel.registry.get('records.query')!.outputSchema,
      handler: async () => ({ output: { records: [], count: 0 } }),
    });
    const trimmed = toToolSpecs(kernel, {
      caller: { entry: 'ai', grantedPermissions: [] },
    });
    expect(trimmed.map((s) => s.name)).not.toContain('admin__wipe');
  });
});

describe('handleToolCall（M1 核心验收：跨入口平价）', () => {
  it('invoke(records.translate) ≡ handleToolCall(records__translate)：同 diff、同 output、同终态', async () => {
    const a = makeKernel();
    const b = makeKernel();
    const input = { ids: ['p1', 'p2'], dx: 3, dy: -2 };

    // 入口 A：程序化 invoke
    const viaInvoke = await a.kernel.invoke('records.translate', input);
    // 入口 B：AI 工具调用
    const viaTool = await handleToolCall(b.kernel, 'records__translate', input);

    expect(viaInvoke.ok).toBe(true);
    expect(viaTool.is_error).toBe(false);
    expect(viaTool.outcome.output).toEqual(viaInvoke.output);
    expect(viaTool.outcome.diff).toEqual(viaInvoke.diff);
    expect(JSON.parse(viaTool.content)).toEqual(viaInvoke.output);

    // 引擎终态逐记录一致
    const snapA = a.engine.snapshot().entities;
    const snapB = b.engine.snapshot().entities;
    expect([...snapB.entries()]).toEqual([...snapA.entries()]);
    expect(b.engine.undoDepth).toBe(a.engine.undoDepth);
  });

  it('能力 id 原样调用同样可达（兼容两种 name 写法）', async () => {
    const { kernel } = makeKernel();
    const res = await handleToolCall(kernel, 'records.query', { propsEquals: { type: 'poi' } });
    expect(res.is_error).toBe(false);
    expect(JSON.parse(res.content).count).toBe(2);
  });

  it('校验失败 → is_error + 结构化 issues 回灌（AI 自纠）', async () => {
    const { kernel, engine } = makeKernel();
    const res = await handleToolCall(kernel, 'records__translate', {
      ids: ['p1'],
      dx: '三',
      dy: 0,
    });
    expect(res.is_error).toBe(true);
    const payload = JSON.parse(res.content);
    expect(payload.error.code).toBe('validation_failed');
    expect(payload.issues[0].path).toBe('dx');
    expect(engine.undoDepth).toBe(0);
  });

  it('未知工具 → is_error + capability_not_found + 相似能力 hint', async () => {
    const { kernel } = makeKernel();
    const res = await handleToolCall(kernel, 'records__teleport', {});
    expect(res.is_error).toBe(true);
    const payload = JSON.parse(res.content);
    expect(payload.error.code).toBe('capability_not_found');
    expect(payload.hint).toBeTruthy();
  });

  it('校验失败的 hint 附逐条参数指引（回灌自纠增强）', async () => {
    const { kernel } = makeKernel();
    const res = await handleToolCall(kernel, 'records__translate', { ids: [], dx: 1, dy: 1 });
    expect(res.is_error).toBe(true);
    const payload = JSON.parse(res.content);
    expect(payload.hint).toContain('参数');
  });

  it('dryRun：AI 预览门——返回 diff、状态不变', async () => {
    const { kernel, engine } = makeKernel();
    const res = await handleToolCall<{ count: number }, RecordDiff>(
      kernel,
      'records__translate',
      { ids: ['p1'], dx: 9, dy: 9 },
      { dryRun: true },
    );
    expect(res.is_error).toBe(false);
    expect(res.outcome.dryRun).toBe(true);
    expect(res.outcome.diff?.modified[0].after).toMatchObject({ x: 9, y: 9 });
    expect(engine.snapshot().entities.get('p1')).toMatchObject({ x: 0, y: 0 });
    expect(engine.undoDepth).toBe(0);
  });

  it('工作流即工具：一次 tool call 跑多步 + 宏撤销可经 history__undo 一键回滚', async () => {
    const { kernel, engine } = makeKernel();
    const run = await handleToolCall(kernel, 'workflow__highlightAndNudge', {
      propsEquals: { type: 'poi' },
      dx: 5,
      dy: 0,
    });
    expect(run.is_error).toBe(false);
    expect(JSON.parse(run.content)).toEqual({ matchedIds: ['p1', 'p2'], count: 2 });
    expect(engine.undoDepth).toBe(1);
    expect(engine.snapshot().entities.get('p1')).toMatchObject({ x: 5 });

    // AI 的写操作可回退：undo 本身就是能力
    const undo = await handleToolCall(kernel, 'history__undo', {});
    expect(JSON.parse(undo.content)).toEqual({ done: true });
    expect(engine.snapshot().entities.get('p1')).toMatchObject({ x: 0 });
    expect(engine.snapshot().entities.get('p1')!.props.highlighted).toBeUndefined();
  });

  it('caller.entry 默认 ai（事件流可观测入口来源）', async () => {
    const { kernel } = makeKernel();
    const entries: string[] = [];
    kernel.events.on((e) => {
      if (e.type === 'invoke:start') entries.push(e.caller.entry);
    });
    await handleToolCall(kernel, 'records__query', {});
    expect(entries).toEqual(['ai']);
  });
});
