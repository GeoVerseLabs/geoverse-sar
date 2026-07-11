/**
 * L1 自调优报告（RFC-0009 T15）——"传感器已建成，补执行器"：
 * 吃 ErrorMonitor 报告 + audit 全量轨迹，产出**离线**调优报告——
 * description/schema 修订建议 + 成功轨迹 few-shot 示例。
 *
 * 红线（RFC-0009）："进化数据，不进化代码"：本模块只产报告（数据），
 * 修订动作永远由人执行（改 description/schema 后过正常门禁）；
 * few-shot 示例是给宿主注入 system prompt 的素材，不自动生效。
 * 全程确定性零 LLM——报告可复现、可 diff、可入库。
 */
import type { AuditEntry } from './audit';
import type { ErrorReport } from './diagnostics';
import type { CapabilityDescriptor } from './registry';

export interface TuningSuggestion {
  capabilityId: string;
  /** schema=参数总在同一路径出错 / description=能力总被幻觉名误调 / usage=失败率异常。 */
  kind: 'schema' | 'description' | 'usage';
  suggestion: string;
  /** 证据（计数/路径/错误码），人审时核对。 */
  evidence: Record<string, unknown>;
}

export interface FewShotExample {
  capabilityId: string;
  input: unknown;
  /** 该能力成功调用总数（示例的代表性）。 */
  successCount: number;
}

export interface TuningReport {
  /** 样本量：audit 条数 / monitor 观测 invoke 数。 */
  sample: { auditEntries: number; monitorTotal: number };
  /** 能力级失败统计（降序，含错误码分布与失败率）。 */
  capabilities: {
    capabilityId: string;
    calls: number;
    failed: number;
    failureRate: number;
    codes: Record<string, number>;
  }[];
  suggestions: TuningSuggestion[];
  /** 成功轨迹抽样（captureInput=false 时缺席 input 的条目不入选）。 */
  fewShot: FewShotExample[];
}

export interface CreateTuningReportOptions {
  /** audit.entries() 全量（或过滤后）轨迹。 */
  audit?: readonly AuditEntry[];
  /** monitor.report() 快照。 */
  monitor?: ErrorReport;
  /** 能力目录（describeAll()）；提供时建议会带上现有 description 以便对照。 */
  catalog?: readonly CapabilityDescriptor[];
  /** 触发 schema 建议的同路径校验失败次数阈值，默认 3。 */
  issuePathThreshold?: number;
  /** 触发 usage 建议的失败率阈值（样本 ≥5 时生效），默认 0.5。 */
  failureRateThreshold?: number;
  /** 每能力 few-shot 示例上限，默认 2。 */
  fewShotPerCapability?: number;
}

/** ErrorMonitor 的 issuePath 键形如 `capabilityId#path`。 */
function splitIssueKey(key: string): { capabilityId: string; path: string } {
  const i = key.indexOf('#');
  return i < 0
    ? { capabilityId: key, path: '(root)' }
    : { capabilityId: key.slice(0, i), path: key.slice(i + 1) };
}

export function createTuningReport(opts: CreateTuningReportOptions = {}): TuningReport {
  const audit = opts.audit ?? [];
  const monitor = opts.monitor;
  const issueThreshold = opts.issuePathThreshold ?? 3;
  const rateThreshold = opts.failureRateThreshold ?? 0.5;
  const fewShotCap = opts.fewShotPerCapability ?? 2;
  const byId = new Map(opts.catalog?.map((d) => [d.id, d]) ?? []);

  // ---- 能力级统计（audit 是全量面；monitor 只有失败面，作补充）----
  const stats = new Map<
    string,
    { calls: number; failed: number; codes: Map<string, number> }
  >();
  const statOf = (id: string) => {
    let s = stats.get(id);
    if (!s) {
      s = { calls: 0, failed: 0, codes: new Map() };
      stats.set(id, s);
    }
    return s;
  };
  for (const e of audit) {
    const s = statOf(e.capabilityId);
    s.calls += 1;
    if (!e.ok) {
      s.failed += 1;
      const code = e.errorCode ?? 'unknown';
      s.codes.set(code, (s.codes.get(code) ?? 0) + 1);
    }
  }
  if (audit.length === 0 && monitor) {
    for (const c of monitor.byCapability) {
      const s = statOf(c.capabilityId);
      s.failed = c.failed;
      for (const [code, n] of Object.entries(c.codes)) s.codes.set(code, n);
    }
  }

  const suggestions: TuningSuggestion[] = [];

  // ---- schema 建议：同一参数路径反复校验失败 = schema/描述没把约定说清 ----
  for (const { path, count } of monitor?.topIssuePaths ?? []) {
    if (count < issueThreshold) continue;
    const { capabilityId, path: field } = splitIssueKey(path);
    const desc = byId.get(capabilityId);
    suggestions.push({
      capabilityId,
      kind: 'schema',
      suggestion:
        `参数 \`${field}\` 累计 ${count} 次校验失败——检查该字段的 schema 约束与 .describe() 是否把` +
        `取值约定写清（模型反复在同一处出错通常是描述缺信息，而非模型问题）。`,
      evidence: { path: field, count, currentDescription: desc?.description },
    });
  }

  // ---- description 建议：capability_not_found 高频 = 目录描述/命名与模型心智不合 ----
  const notFound = monitor?.byCode['capability_not_found'] ?? 0;
  if (notFound >= issueThreshold) {
    const wrongIds = (monitor?.recent ?? [])
      .filter((f) => f.code === 'capability_not_found')
      .map((f) => f.capabilityId);
    suggestions.push({
      capabilityId: '(catalog)',
      kind: 'description',
      suggestion:
        `模型累计 ${notFound} 次调用不存在的能力（幻觉名单见 evidence）——考虑在被误指向的` +
        `真实能力 description 里补"何时该调/别名提示"，或为高频幻觉名注册别名能力。`,
      evidence: { count: notFound, hallucinatedIds: [...new Set(wrongIds)] },
    });
  }

  // ---- usage 建议：失败率异常的能力 ----
  for (const [capabilityId, s] of stats) {
    if (s.calls >= 5 && s.failed / s.calls >= rateThreshold) {
      suggestions.push({
        capabilityId,
        kind: 'usage',
        suggestion:
          `失败率 ${(s.failed / s.calls) * 100}%（${s.failed}/${s.calls}）——按错误码分布排查：` +
          `validation_failed 偏 schema 描述、permission_denied 偏目录裁剪没对齐、handler_error 偏实现。`,
        evidence: { codes: Object.fromEntries(s.codes) },
      });
    }
  }

  // ---- few-shot：每能力最近成功入参（audit 成功轨迹 → 示例素材）----
  const fewShot: FewShotExample[] = [];
  const successCount = new Map<string, number>();
  for (const e of audit) {
    if (e.ok && !e.dryRun) {
      successCount.set(e.capabilityId, (successCount.get(e.capabilityId) ?? 0) + 1);
    }
  }
  const picked = new Map<string, number>();
  for (let i = audit.length - 1; i >= 0; i--) {
    const e = audit[i];
    if (!e.ok || e.dryRun || e.input === undefined) continue;
    const n = picked.get(e.capabilityId) ?? 0;
    if (n >= fewShotCap) continue;
    picked.set(e.capabilityId, n + 1);
    fewShot.push({
      capabilityId: e.capabilityId,
      input: e.input,
      successCount: successCount.get(e.capabilityId) ?? 0,
    });
  }

  return {
    sample: { auditEntries: audit.length, monitorTotal: monitor?.total ?? 0 },
    capabilities: [...stats.entries()]
      .map(([capabilityId, s]) => ({
        capabilityId,
        calls: s.calls,
        failed: s.failed,
        failureRate: s.calls === 0 ? 0 : s.failed / s.calls,
        codes: Object.fromEntries(s.codes),
      }))
      .sort((a, b) => b.failed - a.failed || b.calls - a.calls),
    suggestions,
    fewShot,
  };
}

/** 报告 → 可读文本（CLI/面板直出；与 formatDoctorReport 同风格）。 */
export function formatTuningReport(report: TuningReport): string {
  const lines: string[] = [
    `# L1 调优报告`,
    `样本：audit ${report.sample.auditEntries} 条 · monitor ${report.sample.monitorTotal} 次 invoke`,
    '',
    `## 建议（${report.suggestions.length}）`,
  ];
  if (!report.suggestions.length) lines.push('（无——样本内没有达到阈值的问题模式）');
  for (const s of report.suggestions) {
    lines.push(`- [${s.kind}] ${s.capabilityId}：${s.suggestion}`);
  }
  lines.push('', `## 能力失败榜`);
  for (const c of report.capabilities.slice(0, 10)) {
    if (!c.failed) continue;
    lines.push(
      `- ${c.capabilityId}：${c.failed}/${c.calls} 失败（${Math.round(c.failureRate * 100)}%）· ${Object.entries(
        c.codes,
      )
        .map(([k, v]) => `${k}×${v}`)
        .join(' ')}`,
    );
  }
  lines.push('', `## few-shot 素材（${report.fewShot.length} 条成功入参）`);
  for (const f of report.fewShot) {
    lines.push(
      `- ${f.capabilityId}（成功 ${f.successCount} 次）：${JSON.stringify(f.input)}`,
    );
  }
  return lines.join('\n');
}
