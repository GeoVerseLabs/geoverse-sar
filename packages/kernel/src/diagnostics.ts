/**
 * 错误分析（与 doctor 互补）：doctor 管"装配对不对"，本模块管"运行中错在哪"。
 * - createErrorMonitor：中间件形态的失败聚合器（按能力/错误码/参数路径统计）——
 *   人排查"模型总在哪个参数出错"、AI 自纠回灌都吃它。
 * - explainError：把归一 InvokeOutcome 错误翻译成可操作提示（含相似能力建议）。
 */
import type { InvokeOutcome, Middleware } from './dispatcher';
import type { CapabilityRegistry } from './registry';
import type { EntryKind } from './permissions';
import type { ValidationIssue } from './schema-utils';

export interface InvokeFailure {
  capabilityId: string;
  code: string;
  message: string;
  issues?: ValidationIssue[];
  entry: EntryKind;
  at: number;
  durationMs: number;
}

export interface ErrorReport {
  /** 监控期内 invoke 总数 / 失败数 / 失败率（0~1）。 */
  total: number;
  failed: number;
  failureRate: number;
  /** 失败按能力聚合（降序）。 */
  byCapability: { capabilityId: string; failed: number; codes: Record<string, number> }[];
  /** 失败按错误码聚合。 */
  byCode: Record<string, number>;
  /** 校验失败的参数路径 Top（"模型总在哪个参数出错"）。 */
  topIssuePaths: { path: string; count: number }[];
  /** 最近 N 条失败明细（新在前）。 */
  recent: InvokeFailure[];
}

export interface ErrorMonitor {
  /** 挂进 createKernel({ middleware: [monitor.middleware] })。 */
  middleware: Middleware;
  report(): ErrorReport;
  reset(): void;
}

export function createErrorMonitor(opts: { maxRecent?: number } = {}): ErrorMonitor {
  const maxRecent = opts.maxRecent ?? 50;
  let total = 0;
  let failed = 0;
  const byCapability = new Map<string, { failed: number; codes: Map<string, number> }>();
  const byCode = new Map<string, number>();
  const issuePaths = new Map<string, number>();
  let recent: InvokeFailure[] = [];

  const middleware: Middleware = async (ctx, next) => {
    const outcome = await next();
    total += 1;
    if (!outcome.ok) {
      failed += 1;
      const code = outcome.error?.code ?? 'unknown';
      byCode.set(code, (byCode.get(code) ?? 0) + 1);
      const cap = byCapability.get(ctx.capabilityId) ?? { failed: 0, codes: new Map() };
      cap.failed += 1;
      cap.codes.set(code, (cap.codes.get(code) ?? 0) + 1);
      byCapability.set(ctx.capabilityId, cap);
      for (const issue of outcome.issues ?? []) {
        const key = `${ctx.capabilityId}#${issue.path || '(root)'}`;
        issuePaths.set(key, (issuePaths.get(key) ?? 0) + 1);
      }
      recent = [
        {
          capabilityId: ctx.capabilityId,
          code,
          message: outcome.error?.message ?? '',
          issues: outcome.issues,
          entry: ctx.caller.entry,
          at: Date.now(),
          durationMs: outcome.durationMs,
        },
        ...recent,
      ].slice(0, maxRecent);
    }
    return outcome;
  };

  return {
    middleware,
    report(): ErrorReport {
      return {
        total,
        failed,
        failureRate: total === 0 ? 0 : failed / total,
        byCapability: [...byCapability.entries()]
          .map(([capabilityId, v]) => ({
            capabilityId,
            failed: v.failed,
            codes: Object.fromEntries(v.codes),
          }))
          .sort((a, b) => b.failed - a.failed),
        byCode: Object.fromEntries(byCode),
        topIssuePaths: [...issuePaths.entries()]
          .map(([path, count]) => ({ path, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 10),
        recent: [...recent],
      };
    },
    reset() {
      total = 0;
      failed = 0;
      byCapability.clear();
      byCode.clear();
      issuePaths.clear();
      recent = [];
    },
  };
}

/** 极简编辑距离（能力 id 相似建议用，串都很短）。 */
function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const cur = dp[i];
      dp[i] = Math.min(dp[i] + 1, dp[i - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return dp[a.length];
}

/** 未命中能力时给相似 id 建议（前缀/包含优先，其次编辑距离）。 */
export function suggestCapabilityIds(
  registry: CapabilityRegistry,
  wrongId: string,
  limit = 3,
): string[] {
  const norm = wrongId.replace(/__/g, '.').toLowerCase();
  const ids = registry.list().map((c) => c.id);
  return ids
    .map((id) => {
      const l = id.toLowerCase();
      let score = editDistance(l, norm);
      if (l.includes(norm) || norm.includes(l)) score = Math.min(score, 1);
      if (l.split('.')[0] === norm.split('.')[0]) score -= 0.5;
      return { id, score };
    })
    .filter((s) => s.score <= Math.max(3, norm.length / 2))
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((s) => s.id);
}

/**
 * 错误 → 可操作提示（skill 回灌给模型自纠、UI/日志同用）。
 * 传 registry 时 capability_not_found 会附相似能力建议。
 */
export function explainError(
  outcome: Pick<InvokeOutcome, 'ok' | 'capabilityId' | 'error' | 'issues'>,
  opts: { registry?: CapabilityRegistry } = {},
): string | undefined {
  if (outcome.ok || !outcome.error) return undefined;
  const { code, message } = outcome.error;
  switch (code) {
    case 'validation_failed': {
      const lines = (outcome.issues ?? []).map(
        (i) => `- 参数 ${i.path || '(根)'}: ${i.message} [${i.code}]`,
      );
      return [
        `入参未通过 schema 校验：`,
        ...lines,
        `修正这些字段后重试；完整入参结构见该工具的 input_schema。`,
      ].join('\n');
    }
    case 'capability_not_found': {
      const suggestions = opts.registry
        ? suggestCapabilityIds(opts.registry, outcome.capabilityId)
        : [];
      return [
        `能力 ${outcome.capabilityId} 不存在。`,
        suggestions.length
          ? `是否想调用: ${suggestions.join(' / ')}？`
          : `用能力目录（tools 列表 / describeAll）核对可用能力。`,
      ].join(' ');
    }
    case 'permission_denied':
      return `${message}。当前调用方权限不足——这是配置问题，重试同一调用不会成功；换用目录中可见的能力。`;
    case 'service_missing':
      return `${message}。这是宿主装配问题（非入参问题）：运行 doctor 体检可在启动期发现。`;
    case 'tx_group_not_found':
      return `${message}。事务组已 commit/abort 或从未创建；勿复用已结束的 txGroupId。`;
    case 'engine_rejected':
      return `引擎拒绝应用变更：${message}。通常是 id 冲突或目标不存在——先用查询能力核对当前状态再重试。`;
    case 'workflow_aborted':
      return `工作流已整组中止（无半成品残留）：${message}。修正失败步骤的入参后可整体重跑。`;
    case 'handler_error':
      return `执行失败：${message}。若为"不存在/已存在"类错误，先用查询能力核对当前状态。`;
    default:
      return message;
  }
}
