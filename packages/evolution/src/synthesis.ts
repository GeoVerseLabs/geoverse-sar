/**
 * L2 workflow 合成闭环（RFC-0009 规范流程）：
 * 轨迹挖掘 → LLM 起草 → 机器验证（静态引用检查 + 逐步 dryRun 干跑）→
 * 审批门（人/策略）→ `workflows.register` + 持久化（synthesized-workflows 流，含 provenance）。
 *
 * 治理性质（为什么这是"甜点"而非风险）：
 * - 草稿是声明式数据，只能组合**已注册已校验**的能力；
 * - 注册后仍走单漏斗——权限/审计/dryRun 对合成 workflow 全生效；
 * - undo:'macro'——一次调用一个撤销单元，爆炸半径兜住；
 * - 默认 `pending`（不注册不进目录），审批通过才 enable；
 * - 每条产物带 provenance（挖掘来源/次数/时间/创建者）落 SarStore 流，可追溯可回放。
 */
import type { AuditEntry, SarKernel, SarStore } from '@geoverse-sar/kernel';
import { mineSequences, type MineOptions } from './mine';
import { draftWorkflow } from './draft';
import { checkDraftReferences, compileDraft, resolveTemplate } from './compile';
import {
  SYNTHESIZED_WORKFLOWS_STREAM,
  type DraftLlm,
  type DraftValidation,
  type MinedSequence,
  type SynthesizedWorkflowRecord,
  type WorkflowDraft,
} from './types';

export interface CreateSynthesisOptions {
  kernel: SarKernel;
  llm: DraftLlm;
  /** 提供则产物（含状态迁移）追加进 `synthesized-workflows` 流。 */
  store?: SarStore;
  /** provenance 归因，默认 'synthesis'。 */
  createdBy?: string;
  /** 时间源可注入（测试确定性）。 */
  now?: () => string;
}

export interface ProposeOptions {
  /** dryRun 干跑用的样例入参；缺省按 inputFields 类型生成占位值。 */
  sampleInput?: Record<string, unknown>;
}

export interface SynthesisRunOptions extends ProposeOptions {
  /** 每轮最多处理的高频序列数，默认 1。 */
  top?: number;
  /** 审批门：返回 true 才 enable；缺省不审批——一律停在 pending。 */
  approve?: (record: SynthesizedWorkflowRecord) => boolean | Promise<boolean>;
  mine?: MineOptions;
}

export interface Synthesis {
  mine(entries: readonly AuditEntry[], opts?: MineOptions): MinedSequence[];
  /** 起草 + 验证 + 落库（pending）；LLM 草稿非法时抛错。 */
  propose(
    sequence: MinedSequence,
    opts?: ProposeOptions,
  ): Promise<SynthesizedWorkflowRecord>;
  /** 审批通过：注册进 kernel（目录即刻投影）+ 状态迁移落库。验证未过拒绝启用。 */
  enable(record: SynthesizedWorkflowRecord): Promise<SynthesizedWorkflowRecord>;
  reject(record: SynthesizedWorkflowRecord): Promise<SynthesizedWorkflowRecord>;
  /** 完整闭环：mine → 逐序列 propose → approve → enable/pending。 */
  run(
    entries: readonly AuditEntry[],
    opts?: SynthesisRunOptions,
  ): Promise<SynthesizedWorkflowRecord[]>;
}

const SAMPLE_VALUES = { string: 'sample', number: 1, boolean: true } as const;

/**
 * 机器验证：静态引用检查 + **逐步 dryRun 干跑**——
 * 每步对样例 scope 解析模板后经真实漏斗 invoke（dryRun:true 不落地），
 * read 步产出真实输出供后步引用，写步产出 diff 证明 schema/权限走得通。
 */
export async function validateDraft(
  kernel: SarKernel,
  draft: WorkflowDraft,
  opts: ProposeOptions = {},
): Promise<DraftValidation> {
  const issues = checkDraftReferences(draft);
  const known = new Set(kernel.describeAll().map((d) => d.id));
  for (const step of draft.steps) {
    if (!known.has(step.capability)) {
      issues.push(`步 ${step.id}：能力不存在 ${step.capability}`);
    }
  }
  if (known.has(draft.id)) issues.push(`id 已被占用: ${draft.id}`);
  if (issues.length) return { ok: false, issues };

  const sample: Record<string, unknown> = { ...(opts.sampleInput ?? {}) };
  for (const [field, type] of Object.entries(draft.inputFields ?? {})) {
    if (!(field in sample)) sample[field] = SAMPLE_VALUES[type];
  }
  const scope = { input: sample, steps: {} as Record<string, unknown> };
  for (const step of draft.steps) {
    const input =
      step.input === undefined ? undefined : resolveTemplate(step.input, scope);
    const out = await kernel.invoke(step.capability, input, { dryRun: true });
    if (!out.ok) {
      issues.push(
        `步 ${step.id}（${step.capability}）dryRun 失败: ${out.error?.code} ${out.error?.message ?? ''}`,
      );
      break; // 后步大概率依赖本步输出，继续没有意义
    }
    scope.steps[step.id] = out.output;
  }
  return { ok: issues.length === 0, issues };
}

export function createSynthesis(options: CreateSynthesisOptions): Synthesis {
  const { kernel, llm, store } = options;
  const createdBy = options.createdBy ?? 'synthesis';
  const now = options.now ?? (() => new Date().toISOString());

  async function persist(record: SynthesizedWorkflowRecord): Promise<void> {
    if (!store) return;
    await store.append(SYNTHESIZED_WORKFLOWS_STREAM, [record]);
  }

  async function propose(
    sequence: MinedSequence,
    opts: ProposeOptions = {},
  ): Promise<SynthesizedWorkflowRecord> {
    const draft = await draftWorkflow(llm, kernel.describeAll(), sequence);
    const validation = await validateDraft(kernel, draft, opts);
    const record: SynthesizedWorkflowRecord = {
      draft,
      status: 'pending',
      provenance: {
        minedFrom: sequence.capabilityIds,
        count: sequence.count,
        createdAt: now(),
        createdBy,
      },
      validation,
    };
    await persist(record);
    return record;
  }

  async function enable(
    record: SynthesizedWorkflowRecord,
  ): Promise<SynthesizedWorkflowRecord> {
    if (!record.validation.ok) {
      throw new Error(`验证未通过的草稿不可启用: ${record.validation.issues.join('; ')}`);
    }
    kernel.workflows.register(compileDraft(record.draft));
    const enabled: SynthesizedWorkflowRecord = { ...record, status: 'enabled' };
    await persist(enabled);
    return enabled;
  }

  async function reject(
    record: SynthesizedWorkflowRecord,
  ): Promise<SynthesizedWorkflowRecord> {
    const rejected: SynthesizedWorkflowRecord = { ...record, status: 'rejected' };
    await persist(rejected);
    return rejected;
  }

  return {
    mine: (entries, opts) => mineSequences(entries, opts),
    propose,
    enable,
    reject,
    async run(entries, opts = {}) {
      const top = opts.top ?? 1;
      const sequences = mineSequences(entries, opts.mine).slice(0, top);
      const records: SynthesizedWorkflowRecord[] = [];
      for (const seq of sequences) {
        let record: SynthesizedWorkflowRecord;
        try {
          record = await propose(seq, opts);
        } catch (err) {
          // 起草失败（LLM 输出非法）：记录为验证失败的占位产物，不中断其余序列
          record = {
            draft: {
              id: 'workflow.invalid-draft',
              title: '(起草失败)',
              description: String(err),
              steps: [{ id: 'noop', capability: '(none)' }],
            },
            status: 'rejected',
            provenance: {
              minedFrom: seq.capabilityIds,
              count: seq.count,
              createdAt: now(),
              createdBy,
            },
            validation: { ok: false, issues: [String(err)] },
          };
          await persist(record);
          records.push(record);
          continue;
        }
        if (record.validation.ok && opts.approve && (await opts.approve(record))) {
          record = await enable(record);
        }
        records.push(record);
      }
      return records;
    },
  };
}

/**
 * 启动装载：读 `synthesized-workflows` 流，同 id 以最新记录为准，
 * `enabled` 的编译注册进 kernel（已注册的跳过）。返回生效清单。
 */
export async function loadSynthesizedWorkflows(
  kernel: SarKernel,
  store: SarStore,
): Promise<SynthesizedWorkflowRecord[]> {
  const rows = await store.read(SYNTHESIZED_WORKFLOWS_STREAM);
  const latest = new Map<string, SynthesizedWorkflowRecord>();
  for (const row of rows) {
    const record = row.record as SynthesizedWorkflowRecord;
    latest.set(record.draft.id, record);
  }
  const active: SynthesizedWorkflowRecord[] = [];
  for (const record of latest.values()) {
    if (record.status !== 'enabled') continue;
    if (!kernel.workflows.get(record.draft.id)) {
      kernel.workflows.register(compileDraft(record.draft));
    }
    active.push(record);
  }
  return active;
}
