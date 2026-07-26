/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * @geoverse-sar/conformance —— 能力包一致性套件（阶段四 U5-A，RFC-0012 §四，ADR-0018）。
 *
 * 把 SarStore 三适配器 describe.each 的纪律产品化给包作者：
 * **certified pack = doctor 绿 + conformance 绿 + 文档齐**——认证背书契约诚实，
 * 不背书行为质量。双形态：
 * - `runConformance(opts)`：纯检查器（无测试框架依赖），返回结构化 failures——
 *   坏包判红本身可被测试；
 * - `createCapabilityPackTestSuite(name, opts)`：vitest 薄绑定（peer，可选）。
 *
 * 八项检查：① doctor 委托 ② schema 派生往返 ③ description lint（strict）
 * ④ dryRun 纯性（含 state:'none' 能力真实 invoke 后快照全等=effects 行为验证）
 * ⑤ 写能力 invert∘apply 可逆（fast-check，走漏斗经 engine.undo/redo）
 * ⑥ effects 声明一致性探针（fetch 计数 + services 触达记录——探针级非沙箱级，
 *   有效性前提=「外访必须经 services」的规范条款）⑦ 非法组合 ⑧ outputSchema 履约
 *   （样例须至少一次真实成功）。
 */
import fc from 'fast-check';
import {
  resolveEffects,
  runDoctor,
  type Capability,
  type CapabilityPack,
  type SarKernel,
} from '@geoverse-sar/kernel';

export interface CapabilitySample {
  /** 静态样例入参（与 arbitrary 至少给一个才跑行为级检查）。 */
  inputs?: readonly unknown[];
  /** fast-check 入参生成器（可逆性属性测试的样本源）。 */
  arbitrary?: fc.Arbitrary<unknown>;
}

export interface ConformanceHarness<TEntity = any, TDiff = any> {
  kernel: SarKernel<TEntity, TDiff>;
  dispose?(): void;
}

export interface ConformanceOptions<TEntity = any, TDiff = any> {
  pack: CapabilityPack<TEntity, TDiff>;
  /** 每次行为级检查都全新装配（隔离可重建——与 store 契约测试同范式）。 */
  createHarness():
    ConformanceHarness<TEntity, TDiff> | Promise<ConformanceHarness<TEntity, TDiff>>;
  /** capabilityId → 样例；缺席的能力跳过行为级检查（报告记 skipped）。 */
  samples?: Record<string, CapabilitySample>;
  /** strict：description 质量等 warn 级也判红。 */
  strict?: boolean;
  /** 可逆性属性测试的迭代数（每次迭代全新 harness），默认 8。 */
  reversibilityRuns?: number;
  /** effects 一致性探针配置。 */
  effectProbe?: {
    /** external:'none' 能力执行期 fetch 计数必须为 0（默认开）。 */
    fetchProbe?: boolean;
    /** external:'none' 能力不得触达这些服务键（require/get 记录 proxy）。 */
    externalServiceKeys?: readonly string[];
  };
}

export interface ConformanceFailure {
  check:
    | 'doctor'
    | 'schema-roundtrip'
    | 'description'
    | 'dryrun-purity'
    | 'reversibility'
    | 'effects-honesty'
    | 'illegal-combo'
    | 'output-contract';
  capabilityId?: string;
  message: string;
}

export interface ConformanceReport {
  ok: boolean;
  failures: ConformanceFailure[];
  /** 无样例而跳过行为级检查的能力（诚实披露，不算失败）。 */
  skipped: string[];
}

// ---- 工具 ----

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map(
      (k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`,
    )
    .join(',')}}`;
}

function snapshotHash(kernel: SarKernel<any, any>): string {
  const sorted = [...kernel.engine.snapshot().entities.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return canonical(sorted);
}

async function withHarness<TEntity, TDiff, R>(
  opts: ConformanceOptions<TEntity, TDiff>,
  fn: (h: ConformanceHarness<TEntity, TDiff>) => Promise<R>,
): Promise<R> {
  const h = await opts.createHarness();
  try {
    return await fn(h);
  } finally {
    h.dispose?.();
  }
}

// ---- 纯检查器 ----

export async function runConformance<TEntity, TDiff>(
  opts: ConformanceOptions<TEntity, TDiff>,
): Promise<ConformanceReport> {
  const failures: ConformanceFailure[] = [];
  const skipped: string[] = [];
  const caps = opts.pack.capabilities as Capability<any, any, TEntity, TDiff>[];
  const sampleOf = (id: string): CapabilitySample | undefined => opts.samples?.[id];
  const sampleInputs = (s: CapabilitySample | undefined): unknown[] =>
    s?.inputs ? [...s.inputs] : [];

  // ① doctor 委托（不重造既有检查）
  await withHarness(opts, async (h) => {
    const report = runDoctor(h.kernel);
    if (report.errors > 0) {
      for (const c of report.checks.filter((c) => c.level === 'error')) {
        failures.push({
          check: 'doctor',
          capabilityId: c.target,
          message: `[${c.id}] ${c.message}`,
        });
      }
    }
    if (opts.strict && report.warnings > 0) {
      for (const c of report.checks.filter((c) => c.level === 'warn')) {
        failures.push({
          check: 'doctor',
          capabilityId: c.target,
          message: `[strict][${c.id}] ${c.message}`,
        });
      }
    }
  });

  // ②⑦（静态，逐能力）：schema 往返 + 非法组合 +（strict）描述质量
  await withHarness(opts, async (h) => {
    for (const cap of caps) {
      try {
        const d1 = h.kernel.registry.describe(cap.id);
        const d2 = h.kernel.registry.describe(cap.id);
        if (d1 !== d2) {
          failures.push({
            check: 'schema-roundtrip',
            capabilityId: cap.id,
            message: '描述符不稳定（两次 describe 非同一对象）',
          });
        }
        const roundtrip = JSON.parse(JSON.stringify(d1.inputJsonSchema));
        if (canonical(roundtrip) !== canonical(d1.inputJsonSchema)) {
          failures.push({
            check: 'schema-roundtrip',
            capabilityId: cap.id,
            message: 'inputJsonSchema JSON 往返不稳定（含不可序列化残留）',
          });
        }
      } catch (e) {
        failures.push({
          check: 'schema-roundtrip',
          capabilityId: cap.id,
          message: `describe 失败: ${e instanceof Error ? e.message : String(e)}`,
        });
      }

      const effects = resolveEffects(cap.kind, cap.effects);
      if (cap.kind === 'read' && effects.state !== 'none') {
        failures.push({
          check: 'illegal-combo',
          capabilityId: cap.id,
          message: `read + state:'${effects.state}'`,
        });
      }
      if (cap.kind === 'read' && effects.external === 'write') {
        failures.push({
          check: 'illegal-combo',
          capabilityId: cap.id,
          message: "read + external:'write'",
        });
      }
      if ((cap.undoable ?? cap.kind === 'write') && effects.state === 'irreversible') {
        failures.push({
          check: 'illegal-combo',
          capabilityId: cap.id,
          message: "undoable + state:'irreversible'",
        });
      }
      if (opts.strict && cap.description.trim().length < 15) {
        failures.push({
          check: 'description',
          capabilityId: cap.id,
          message: `描述过短（${cap.description.trim().length} 字）`,
        });
      }
    }
  });

  // ④⑥⑧（行为级，样例驱动）
  for (const cap of caps) {
    const sample = sampleOf(cap.id);
    const inputs = sampleInputs(sample);
    if (inputs.length === 0 && !sample?.arbitrary) {
      skipped.push(cap.id);
      continue;
    }
    const effects = resolveEffects(cap.kind, cap.effects);

    // ④ dryRun 纯性 + state:'none' 真实 invoke 快照全等
    for (const input of inputs) {
      await withHarness(opts, async (h) => {
        const before = snapshotHash(h.kernel);
        const dry = await h.kernel.invoke(cap.id, input, { dryRun: true });
        if (snapshotHash(h.kernel) !== before) {
          failures.push({
            check: 'dryrun-purity',
            capabilityId: cap.id,
            message: 'dryRun 后快照变化（预览击穿写入）',
          });
        }
        if ((h.kernel.engine.undoDepth ?? 0) !== 0 && dry.ok) {
          failures.push({
            check: 'dryrun-purity',
            capabilityId: cap.id,
            message: 'dryRun 后撤销栈增长',
          });
        }
      });
      if (effects.state === 'none') {
        await withHarness(opts, async (h) => {
          const before = snapshotHash(h.kernel);
          await h.kernel.invoke(cap.id, input);
          if (snapshotHash(h.kernel) !== before) {
            failures.push({
              check: 'effects-honesty',
              capabilityId: cap.id,
              message: "声明 state:'none' 却在真实调用后改变了状态",
            });
          }
        });
      }
    }

    // ⑥ external:'none' 的 fetch/services 探针（探针级非沙箱级，如实声明）
    if (effects.external === 'none' && inputs.length > 0) {
      const probeFetch = opts.effectProbe?.fetchProbe !== false;
      const keys = opts.effectProbe?.externalServiceKeys ?? [];
      await withHarness(opts, async (h) => {
        let fetchCalls = 0;
        const touched: string[] = [];
        const g = globalThis as { fetch?: typeof fetch };
        const originalFetch = g.fetch;
        if (probeFetch) {
          g.fetch = ((...args: Parameters<typeof fetch>) => {
            fetchCalls += 1;
            return originalFetch
              ? originalFetch(...args)
              : Promise.reject(new Error('probe'));
          }) as typeof fetch;
        }
        const services = h.kernel.services as {
          get: (k: string) => unknown;
          require: (k: string) => unknown;
        };
        const origGet = services.get.bind(services);
        const origRequire = services.require.bind(services);
        if (keys.length > 0) {
          services.get = (k: string) => {
            if (keys.includes(k)) touched.push(k);
            return origGet(k);
          };
          services.require = (k: string) => {
            if (keys.includes(k)) touched.push(k);
            return origRequire(k);
          };
        }
        try {
          await h.kernel.invoke(cap.id, inputs[0]);
        } finally {
          if (probeFetch) g.fetch = originalFetch;
          if (keys.length > 0) {
            services.get = origGet;
            services.require = origRequire;
          }
        }
        if (probeFetch && fetchCalls > 0) {
          failures.push({
            check: 'effects-honesty',
            capabilityId: cap.id,
            message: `声明 external:'none' 却发起了 ${fetchCalls} 次 fetch`,
          });
        }
        if (touched.length > 0) {
          failures.push({
            check: 'effects-honesty',
            capabilityId: cap.id,
            message: `声明 external:'none' 却触达外部服务键: ${[...new Set(touched)].join(', ')}`,
          });
        }
      });
    }

    // ⑧ outputSchema 履约：至少一次真实成功（handler_error/违约在此暴露）
    let succeeded = false;
    for (const input of inputs) {
      const ok = await withHarness(opts, async (h) => {
        const out = await h.kernel.invoke(cap.id, input);
        return out.ok;
      });
      if (ok) {
        succeeded = true;
        break;
      }
    }
    if (inputs.length > 0 && !succeeded) {
      failures.push({
        check: 'output-contract',
        capabilityId: cap.id,
        message: '全部样例真实调用均失败（样例应至少一条可成功，出参契约无从验证）',
      });
    }

    // ⑤ 写能力可逆性（fast-check：invoke → undo 还原 → redo 复现；走漏斗）
    if (cap.kind === 'write' && effects.state === 'reversible') {
      const arb =
        sample?.arbitrary ?? (inputs.length > 0 ? fc.constantFrom(...inputs) : undefined);
      if (arb) {
        const runs = opts.reversibilityRuns ?? 8;
        const result = await fc.check(
          fc.asyncProperty(arb, async (input) => {
            return withHarness(opts, async (h) => {
              const before = snapshotHash(h.kernel);
              const out = await h.kernel.invoke(cap.id, input);
              if (!out.ok) return true; // 状态相关的失败样例不判逆（成功率由 ⑧ 把守）
              const after = snapshotHash(h.kernel);
              h.kernel.engine.undo();
              if (snapshotHash(h.kernel) !== before) return false;
              h.kernel.engine.redo();
              return snapshotHash(h.kernel) === after;
            });
          }),
          { numRuns: runs },
        );
        if (result.failed) {
          failures.push({
            check: 'reversibility',
            capabilityId: cap.id,
            message: `invert∘apply 不可逆（反例: ${canonical(result.counterexample?.[0])}）`,
          });
        }
      }
    }
  }

  return { ok: failures.length === 0, failures, skipped };
}

// ---- vitest 薄绑定（peer 可选：仅在测试环境 import 本函数）----

type SuiteHooks = {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => Promise<void> | void) => void;
  expect: (actual: unknown) => { toEqual(expected: unknown): void };
};

/**
 * 在 vitest 里展开一致性套件：一次 runConformance、按检查类别分 it 断言。
 * 显式传入 { describe, it, expect }（来自 vitest）——库本体不静态依赖测试框架。
 */
export function createCapabilityPackTestSuite<TEntity, TDiff>(
  name: string,
  opts: ConformanceOptions<TEntity, TDiff>,
  hooks: SuiteHooks,
): void {
  const { describe, it, expect } = hooks;
  let reportPromise: Promise<ConformanceReport> | undefined;
  const report = (): Promise<ConformanceReport> =>
    (reportPromise ??= runConformance(opts));

  const CHECKS: ConformanceFailure['check'][] = [
    'doctor',
    'schema-roundtrip',
    'description',
    'dryrun-purity',
    'reversibility',
    'effects-honesty',
    'illegal-combo',
    'output-contract',
  ];

  describe(`conformance: ${name}`, () => {
    for (const check of CHECKS) {
      it(check, async () => {
        const r = await report();
        expect(
          r.failures
            .filter((f) => f.check === check)
            .map((f) => `${f.capabilityId ?? '-'}: ${f.message}`),
        ).toEqual([]);
      });
    }
  });
}
