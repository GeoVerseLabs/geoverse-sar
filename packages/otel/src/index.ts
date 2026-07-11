/**
 * OpenTelemetry 导出器（RFC-0009 F4，可选包）：
 * - `createOtelMiddleware(tracer)`：**中间件形态**给每次 invoke 开 span——
 *   包裹整个漏斗（含权限/校验/handler/写路由），天然精确关联，无 start/end 配对问题；
 *   审计维度（capability/kind/entry/callerId/dryRun/ok/errorCode/durationMs）全上属性。
 * - `bridgeEventsToOtel(events, tracer)`：EventBus → span——workflow:start/end 成对开合、
 *   engine:transaction 记零时长事件 span（撤销/重做也可见）。
 * 只依赖 `@opentelemetry/api`（peer）：provider/exporter 由宿主自带（BYO SDK）。
 */
import {
  SpanKind,
  SpanStatusCode,
  type Attributes,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import type { EventBus, Middleware, SarEvent } from '@geoverse-sar/kernel';

export interface OtelMiddlewareOptions {
  /** span 名前缀，默认 'sar.invoke'（产出 `sar.invoke records.add`）。 */
  spanPrefix?: string;
  /** 附加到每个 span 的静态属性（如 workspace id）。 */
  attributes?: Attributes;
}

/** invoke → span：挂进 createKernel({ middleware: [createOtelMiddleware(tracer)] })。 */
export function createOtelMiddleware(
  tracer: Tracer,
  options: OtelMiddlewareOptions = {},
): Middleware {
  const prefix = options.spanPrefix ?? 'sar.invoke';
  return async (ctx, next) =>
    tracer.startActiveSpan(
      `${prefix} ${ctx.capabilityId}`,
      { kind: SpanKind.INTERNAL },
      async (span) => {
        span.setAttributes({
          ...options.attributes,
          'sar.capability_id': ctx.capabilityId,
          'sar.kind': ctx.kind,
          'sar.entry': ctx.caller.entry,
          'sar.dry_run': ctx.dryRun,
          ...(ctx.caller.id ? { 'sar.caller_id': ctx.caller.id } : {}),
        });
        try {
          const outcome = await next();
          span.setAttributes({
            'sar.ok': outcome.ok,
            'sar.duration_ms': outcome.durationMs,
            'sar.has_diff': outcome.diff !== undefined,
            ...(outcome.error ? { 'sar.error_code': outcome.error.code } : {}),
          });
          if (!outcome.ok) {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: outcome.error?.message,
            });
          }
          return outcome;
        } catch (err) {
          // dispatcher 归一出参正常不抛；这里兜底非常路径
          span.recordException(err instanceof Error ? err : new Error(String(err)));
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw err;
        } finally {
          span.end();
        }
      },
    );
}

export interface OtelEventBridgeOptions {
  attributes?: Attributes;
}

/**
 * EventBus → span：workflow 成对开合（按 workflowId 先进先出配对——
 * 单漏斗下工作流不并发嵌套同 id，足够），engine:transaction 记零时长 span
 * （origin=dispatch/undo/redo 与 label 上属性）。返回解绑函数。
 */
export function bridgeEventsToOtel<TDiff>(
  events: EventBus<TDiff>,
  tracer: Tracer,
  options: OtelEventBridgeOptions = {},
): () => void {
  const open = new Map<string, Span[]>();
  return events.on((e: SarEvent<TDiff>) => {
    if (e.type === 'workflow:start') {
      const span = tracer.startSpan(`sar.workflow ${e.workflowId}`, {
        attributes: {
          ...options.attributes,
          'sar.workflow_id': e.workflowId,
          'sar.entry': e.caller.entry,
        },
      });
      const stack = open.get(e.workflowId) ?? [];
      stack.push(span);
      open.set(e.workflowId, stack);
    } else if (e.type === 'workflow:end') {
      const span = open.get(e.workflowId)?.shift();
      if (!span) return;
      span.setAttributes({
        'sar.ok': e.ok,
        ...(e.failedStepId ? { 'sar.failed_step': e.failedStepId } : {}),
      });
      if (!e.ok) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    } else if (e.type === 'engine:transaction') {
      const span = tracer.startSpan('sar.transaction', {
        attributes: {
          ...options.attributes,
          'sar.origin': e.origin,
          ...(e.label ? { 'sar.label': e.label } : {}),
        },
      });
      span.end();
    }
  });
}
