/**
 * L1 调优报告（T15）：真实 kernel + ErrorMonitor + audit 跑出问题模式 →
 * 报告给出 schema/description/usage 三类建议 + 成功轨迹 few-shot。
 * 全程确定性零 LLM（"进化数据不进化代码"——报告是数据，修订由人执行）。
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createAuditLog,
  createErrorMonitor,
  createKernel,
  createTuningReport,
  defineCapability,
  formatTuningReport,
  type Command,
  type DiffAlgebra,
  type DispatchResult,
  type Snapshot,
  type StateEngine,
  type TxEvent,
} from '../src/index';

type Ent = { id: string; v: number };
type Diff = { label?: string };

/** 最小假引擎（读能力为主，写不落地也无妨——本测试只看统计面）。 */
class NoopEngine implements StateEngine<Ent, Diff> {
  undoDepth = 0;
  redoDepth = 0;
  snapshot(): Snapshot<Ent> {
    return { entities: new Map() };
  }
  dispatch(cmd: Command<Ent, Diff>): DispatchResult<Diff> {
    return { ok: true, diff: { label: cmd.label } };
  }
  undo(): boolean {
    return false;
  }
  redo(): boolean {
    return false;
  }
  onTransaction(fn: (e: TxEvent<Diff>) => void): () => void {
    void fn;
    return () => {};
  }
}
const algebra: DiffAlgebra<Ent, Diff> = {
  merge: (diffs, label) => ({ label: label ?? diffs.map((d) => d.label).join('+') }),
  invert: (d) => d,
  apply: () => {},
};

const strictCap = defineCapability<{ n: number }, { n: number }, Ent, Diff>({
  id: 'test.strict',
  title: '严格入参',
  description: '仅测试：n 必须为数字。',
  category: 'test',
  kind: 'read',
  inputSchema: z.object({ n: z.number() }),
  outputSchema: z.object({ n: z.number() }),
  handler: async (_ctx, input) => ({ output: { n: input.n } }),
});

function build() {
  const monitor = createErrorMonitor();
  const audit = createAuditLog();
  const kernel = createKernel<Ent, Diff>({
    engine: new NoopEngine(),
    algebra,
    packs: [{ id: 'test', capabilities: [strictCap] }],
    middleware: [monitor.middleware, audit.middleware],
  });
  return { kernel, monitor, audit };
}

describe('createTuningReport（L1 执行器）', () => {
  it('同路径反复校验失败 → schema 建议；幻觉工具名 → description 建议；few-shot 取成功入参', async () => {
    const { kernel, monitor, audit } = build();

    // 3 次同路径校验失败（n 传了字符串）
    for (let i = 0; i < 3; i++) {
      const out = await kernel.invoke('test.strict', { n: `${i}` });
      expect(out.ok).toBe(false);
    }
    // 3 次幻觉能力名
    await kernel.invoke('test.strictly');
    await kernel.invoke('test.strictQuery');
    await kernel.invoke('test.strictly');
    // 2 次成功（few-shot 素材）
    await kernel.invoke('test.strict', { n: 1 });
    await kernel.invoke('test.strict', { n: 42 });

    const report = createTuningReport({
      audit: audit.entries(),
      monitor: monitor.report(),
      catalog: kernel.describeAll(),
    });

    // schema 建议锚定 test.strict 的 n 路径
    const schemaSug = report.suggestions.find((s) => s.kind === 'schema');
    expect(schemaSug).toBeDefined();
    expect(schemaSug!.capabilityId).toBe('test.strict');
    expect(schemaSug!.evidence.path).toBe('n');
    expect(schemaSug!.evidence.count).toBe(3);
    expect(schemaSug!.evidence.currentDescription).toContain('仅测试');

    // description 建议带幻觉名单
    const descSug = report.suggestions.find((s) => s.kind === 'description');
    expect(descSug).toBeDefined();
    expect(descSug!.evidence.hallucinatedIds).toEqual(
      expect.arrayContaining(['test.strictly', 'test.strictQuery']),
    );

    // few-shot 只取成功且带入参的调用，新在前，默认每能力 2 条
    expect(report.fewShot).toHaveLength(2);
    expect(report.fewShot[0]).toMatchObject({
      capabilityId: 'test.strict',
      input: { n: 42 },
      successCount: 2,
    });

    // 统计面：strict 3 失败 5 调用；幻觉 id 也入榜（audit 全量面）
    const strict = report.capabilities.find((c) => c.capabilityId === 'test.strict')!;
    expect(strict).toMatchObject({ calls: 5, failed: 3 });
    expect(strict.codes.validation_failed).toBe(3);

    const text = formatTuningReport(report);
    expect(text).toContain('[schema] test.strict');
    expect(text).toContain('few-shot');
  });

  it('失败率超阈值（样本≥5）→ usage 建议；无问题模式 → 零建议', async () => {
    const { kernel, monitor, audit } = build();
    for (let i = 0; i < 5; i++) await kernel.invoke('test.strict', { n: 'bad' });
    const report = createTuningReport({
      audit: audit.entries(),
      monitor: monitor.report(),
    });
    const usage = report.suggestions.find((s) => s.kind === 'usage');
    expect(usage).toBeDefined();
    expect(usage!.capabilityId).toBe('test.strict');

    // 干净样本 → 零建议
    const clean = createTuningReport({ audit: [], monitor: undefined });
    expect(clean.suggestions).toHaveLength(0);
    expect(formatTuningReport(clean)).toContain('无——样本内没有达到阈值的问题模式');
  });
});
