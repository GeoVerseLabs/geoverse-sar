/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * @geoverse-sar/eval —— 确定性评测闭环（阶段四 U2，RFC-0011）。
 *
 * 把「回放等价」资产升格为 eval 基座：scenario = 装配工厂 + 计划（脚本化动作序列，
 * 或 goal + LlmClient）+ **声明式断言**。断言白名单靠**构造**而非 lint——
 * ScenarioExpect 只有终态/撤销深度/审计序列/结局这些形状，自由函数与
 * "对 LLM 输出文本做字符串匹配"在类型上就不存在。
 *
 * 确定性判据：runner 把终态规范化（键排序 JSON）后 FNV-1a 哈希——同一 scenario
 * 跑三遍 stateHash 逐字节相同（CI 钉死）。live 档（真 LLM 报告）随 Provider 延后。
 */
import {
  clientOf,
  createAuditLog,
  type Middleware,
  type SarKernel,
} from '@geoverse-sar/kernel';
import { createPlanner } from '@geoverse-sar/planner';
import type {
  AssistantTurn,
  LlmClient,
  LlmCompleteOptions,
  LlmRequest,
} from '@geoverse-sar/planner';

// ---- scenario 模型 ----

export interface ScriptedInvokeStep {
  invoke: { capabilityId: string; input?: unknown; dryRun?: boolean };
  /** 该步期望的 outcome.ok（缺省 true）；不符即记失败。 */
  expectOk?: boolean;
}
export type ScriptedStep = ScriptedInvokeStep | { undo: number } | { redo: number };

export interface GoalPlan {
  goal: string;
  /** 用 createScriptedLlm 即 deterministic 档；真实 LLM 即 live 档（不进 CI）。 */
  llm: LlmClient;
  maxRounds?: number;
}

/** 声明式断言（白名单即全集）：只认可判定的结构事实。 */
export interface ScenarioExpect {
  entityCount?: number;
  undoDepth?: number | null;
  entities?: Array<{
    id: string;
    /** true=断言该实体不存在。 */
    absent?: true;
    /** 部分深比较：expected 的每个键路径都须在实体上取到相同值（子集匹配）。 */
    match?: Record<string, unknown>;
  }>;
  /** capabilityId 的按序子序列（治理完整性：这些调用确实按此先后发生过）。 */
  auditSequence?: string[];
  /** 关键能力的结局：审计里该能力**最后一次**调用的 ok 值。 */
  outcomes?: Array<{ capabilityId: string; ok: boolean }>;
}

export interface EvalWorld<TEntity = any, TDiff = any> {
  kernel: SarKernel<TEntity, TDiff>;
  dispose?(): void;
}

export interface EvalScenario<TEntity = any, TDiff = any> {
  id: string;
  title?: string;
  /**
   * 装配工厂：每次运行全新世界（确定性前提）。实现必须把 ctx.middleware
   * 传进 createKernel({ middleware })——runner 的审计观察由此注入，不旁路漏斗。
   */
  setup(ctx: { middleware: Middleware[] }): EvalWorld<TEntity, TDiff>;
  plan: ScriptedStep[] | GoalPlan;
  expect: ScenarioExpect;
}

export interface EvalRunResult {
  id: string;
  ok: boolean;
  failures: string[];
  /** 终态规范化哈希：跑三遍逐字节相同=确定性判据。 */
  stateHash: string;
  /** 审计里的 capabilityId 时间序（含失败调用）。 */
  auditIds: string[];
  entityCount: number;
  undoDepth: number | null;
}

// ---- 规范化哈希（零依赖、浏览器安全） ----

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map(
      (k) =>
        `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
    )
    .join(',')}}`;
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 终态哈希：实体按 id 排序 + 键排序 JSON → FNV-1a。 */
export function hashEntities(entities: ReadonlyMap<string, unknown>): string {
  const sorted = [...entities.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return fnv1a(canonicalJson(sorted));
}

// ---- 部分深比较（子集匹配） ----

function matchesSubset(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== 'object')
    return Object.is(actual, expected);
  if (Array.isArray(expected)) return canonicalJson(actual) === canonicalJson(expected);
  if (actual === null || typeof actual !== 'object') return false;
  return Object.entries(expected as Record<string, unknown>).every(([k, v]) =>
    matchesSubset((actual as Record<string, unknown>)[k], v),
  );
}

function isSubsequence(needle: string[], haystack: string[]): boolean {
  let i = 0;
  for (const item of haystack) {
    if (i < needle.length && item === needle[i]) i += 1;
  }
  return i >= needle.length;
}

// ---- scripted LLM（deterministic 档的 goal 驱动；Provider 恢复后迁往其 /testing） ----

export interface ScriptedLlm extends LlmClient {
  readonly requests: LlmRequest[];
}

/** 按序吐预设回合的假 LLM：越界重复末回合；捕获请求供断言。 */
export function createScriptedLlm(turns: AssistantTurn[]): ScriptedLlm {
  let i = 0;
  const requests: LlmRequest[] = [];
  return {
    requests,
    async complete(req: LlmRequest, opts?: LlmCompleteOptions) {
      requests.push(req);
      if (opts?.signal?.aborted) throw new Error('aborted');
      const turn = turns[Math.min(i, turns.length - 1)];
      i += 1;
      return turn;
    },
  };
}

// ---- runner ----

export async function runScenario(scenario: EvalScenario): Promise<EvalRunResult> {
  const audit = createAuditLog({ captureInput: false });
  const world = scenario.setup({ middleware: [audit.middleware] });
  const failures: string[] = [];
  try {
    if (Array.isArray(scenario.plan)) {
      for (const [i, step] of scenario.plan.entries()) {
        if ('invoke' in step) {
          const out = await world.kernel.invoke(
            step.invoke.capabilityId,
            step.invoke.input ?? {},
            { dryRun: step.invoke.dryRun },
          );
          const want = step.expectOk ?? true;
          if (out.ok !== want) {
            failures.push(
              `步骤#${i} ${step.invoke.capabilityId} 期望 ok=${want} 实得 ${out.ok}` +
                (out.error ? `（${out.error.code}: ${out.error.message}）` : ''),
            );
          }
        } else if ('undo' in step) {
          for (let n = 0; n < step.undo; n++) world.kernel.engine.undo();
        } else {
          for (let n = 0; n < step.redo; n++) world.kernel.engine.redo();
        }
      }
    } else {
      const planner = createPlanner(clientOf(world.kernel, { entry: 'ai' }), {
        client: scenario.plan.llm,
        maxRounds: scenario.plan.maxRounds,
      });
      const res = await planner.run(scenario.plan.goal);
      if (!res.ok) {
        failures.push(
          `planner run 失败: ${res.stopReason}${res.error ? `（${res.error}）` : ''}`,
        );
      }
    }

    const entities = world.kernel.engine.snapshot().entities;
    const undoDepth = world.kernel.engine.undoDepth ?? null;
    const auditIds = audit.entries().map((e) => e.capabilityId);

    const exp = scenario.expect;
    if (exp.entityCount !== undefined && entities.size !== exp.entityCount) {
      failures.push(`entityCount 期望 ${exp.entityCount} 实得 ${entities.size}`);
    }
    if (exp.undoDepth !== undefined && undoDepth !== exp.undoDepth) {
      failures.push(`undoDepth 期望 ${exp.undoDepth} 实得 ${undoDepth}`);
    }
    for (const spec of exp.entities ?? []) {
      const actual = entities.get(spec.id);
      if (spec.absent) {
        if (actual !== undefined) failures.push(`实体 ${spec.id} 期望不存在，实得存在`);
        continue;
      }
      if (actual === undefined) {
        failures.push(`实体 ${spec.id} 不存在`);
        continue;
      }
      if (spec.match && !matchesSubset(actual, spec.match)) {
        failures.push(
          `实体 ${spec.id} 子集匹配失败：期望包含 ${canonicalJson(spec.match)}，实得 ${canonicalJson(actual)}`,
        );
      }
    }
    if (exp.auditSequence && !isSubsequence(exp.auditSequence, auditIds)) {
      failures.push(
        `审计序列不含子序列 [${exp.auditSequence.join(' → ')}]，实得 [${auditIds.join(', ')}]`,
      );
    }
    for (const o of exp.outcomes ?? []) {
      const last = audit
        .entries()
        .filter((e) => e.capabilityId === o.capabilityId)
        .at(-1);
      if (!last) {
        failures.push(`结局断言：${o.capabilityId} 从未被调用`);
      } else if (last.ok !== o.ok) {
        failures.push(`结局断言：${o.capabilityId} 期望 ok=${o.ok} 实得 ${last.ok}`);
      }
    }

    return {
      id: scenario.id,
      ok: failures.length === 0,
      failures,
      stateHash: hashEntities(entities),
      auditIds,
      entityCount: entities.size,
      undoDepth,
    };
  } finally {
    world.dispose?.();
  }
}

export interface EvalSuiteResult {
  ok: boolean;
  results: EvalRunResult[];
}

/**
 * 顺序跑一组 scenario（评测集=准入门的单位）：
 * evolution L2 合成 workflow 的 enable 前置=本函数在含该 workflow 的沙箱上全绿；
 * L1 修订落地前后=对同一集跑两遍对比。任一失败即 ok:false。
 */
export async function runScenarios(scenarios: EvalScenario[]): Promise<EvalSuiteResult> {
  const results: EvalRunResult[] = [];
  for (const s of scenarios) results.push(await runScenario(s));
  return { ok: results.every((r) => r.ok), results };
}
