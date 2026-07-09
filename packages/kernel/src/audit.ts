/**
 * 审计日志（M4 治理，与 ErrorMonitor 互补）：ErrorMonitor 只聚合失败，
 * 审计记录**每一次** invoke——谁（caller.entry/id）在何时调了什么、参数、结果。
 * 中间件形态：挂进 createKernel({ middleware: [audit.middleware] })，
 * 四个入口（program/ui/ai/mcp/agent）自动同栈入账，无需入口配合。
 */
import type { Middleware, MiddlewareContext } from './dispatcher';
import { createSinkWriter, type StreamSink } from './journal';

export interface AuditEntry {
  seq: number;
  /** ISO 时间戳。 */
  at: string;
  capabilityId: string;
  kind: string;
  /** caller.entry / caller.id（主体归因）。 */
  entry: string;
  callerId?: string;
  dryRun: boolean;
  ok: boolean;
  errorCode?: string;
  durationMs: number;
  /** 入参快照（captureInput=false 时缺席）；不可克隆入参降级为 undefined。 */
  input?: unknown;
  /** 该次调用是否产生了 diff（写落地/dryRun 预览）。 */
  hasDiff: boolean;
}

export interface AuditFilter {
  capabilityId?: string;
  entry?: string;
  ok?: boolean;
}

export interface AuditLog {
  /** 挂进 kernel middleware。 */
  middleware: Middleware;
  entries(filter?: AuditFilter): AuditEntry[];
  readonly size: number;
  clear(): void;
  /** 持久化：JSON 串（version 包裹）；与 load 往返。 */
  toJSON(): string;
  load(json: string): void;
  /** 等待 sink 写入落定（无 sink 时立即返回）；close 存储前调用。 */
  flush(): Promise<void>;
}

export interface CreateAuditLogOptions {
  /** 环形上限，默认 1000（超出丢最旧）。 */
  maxEntries?: number;
  /** 默认 true；含敏感入参的场景可关。 */
  captureInput?: boolean;
  /** 流化出口（R2）：环形缓存照旧（查询走内存），每条同时 append 进 store（取证面）。 */
  sink?: StreamSink;
}

function safeClone(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch {
    return undefined;
  }
}

export function createAuditLog(opts: CreateAuditLogOptions = {}): AuditLog {
  const { maxEntries = 1000, captureInput = true } = opts;
  let seq = 0;
  let log: AuditEntry[] = [];
  const writer = opts.sink ? createSinkWriter(opts.sink, 'audit') : undefined;

  const push = (entry: AuditEntry): void => {
    log.push(entry);
    if (log.length > maxEntries) log = log.slice(log.length - maxEntries);
    writer?.write(entry);
  };

  const middleware: Middleware = async (mctx: MiddlewareContext, next) => {
    const outcome = await next();
    push({
      seq: ++seq,
      at: new Date().toISOString(),
      capabilityId: mctx.capabilityId,
      kind: mctx.kind,
      entry: mctx.caller.entry,
      callerId: mctx.caller.id,
      dryRun: mctx.dryRun,
      ok: outcome.ok,
      errorCode: outcome.error?.code,
      durationMs: outcome.durationMs,
      input: captureInput ? safeClone(mctx.input) : undefined,
      hasDiff: outcome.diff !== undefined,
    });
    return outcome;
  };

  return {
    middleware,
    entries(filter = {}) {
      return log.filter(
        (e) =>
          (filter.capabilityId === undefined || e.capabilityId === filter.capabilityId) &&
          (filter.entry === undefined || e.entry === filter.entry) &&
          (filter.ok === undefined || e.ok === filter.ok),
      );
    },
    get size() {
      return log.length;
    },
    clear() {
      log = [];
    },
    toJSON() {
      return JSON.stringify({ version: 1, entries: log });
    },
    load(json: string) {
      const data = JSON.parse(json) as { version?: number; entries?: AuditEntry[] };
      if (data.version !== 1 || !Array.isArray(data.entries)) {
        throw new Error('审计日志格式不支持（期待 {version:1, entries:[...]}）');
      }
      log = [...data.entries];
      seq = log.reduce((m, e) => Math.max(m, e.seq), 0);
    },
    flush: () => writer?.flush() ?? Promise.resolve(),
  };
}
