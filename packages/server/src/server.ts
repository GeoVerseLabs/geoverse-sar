/**
 * @geoverse-sar/server（目标架构 §3.4 / R7）——"薄到不值得叫框架"的服务形态：
 * 不发明协议，wire 格式就是 dispatcher 的归一出参 InvokeOutcome。
 *
 *   POST /workspaces/:id/invoke      body { id, input?, dryRun?, traceId?, runId? } → InvokeOutcome JSON
 *   GET  /workspaces/:id/catalog     ?kind=&category=&tag=        → CapabilityDescriptor[]
 *   WS   /workspaces/:id/events      ?token=                      ← SarEvent 帧（EventBus 直桥）
 *   POST /workspaces/:id/checkpoint  （invoke('runtime.checkpoint') 的语法糖）→ InvokeOutcome JSON
 *
 * 传输层硬化（G1-3，body 契约不变）：每个 HTTP 响应带 `x-sar-protocol`（协议版本）+
 * `x-request-id`（关联位）；传输层错误（401/404/400/405/426）是结构化 `WireError`
 * envelope `{ error:{code,message,requestId} }`——与能力级 InvokeOutcome 明确区分；
 * POST invoke/checkpoint 支持 `idempotency-key` 头（同 key 重放返回缓存 outcome、
 * 带 `x-sar-idempotent-replay: true`，不重复执行）。
 *
 * 治理零新增（全部复用内核既有机制）：
 * - **token → CallerInfo 强制注入**：`Authorization: Bearer <token>`（WS 用 `?token=`）
 *   经映射表换算 caller，逐请求 `clientOf(kernel, caller)`——请求体里带任何 caller
 *   字段都不被读取，客户端结构性无法伪造身份。
 * - 能力级失败（权限/校验/handler 错）是 HTTP 200 + ok:false 的 outcome——与本地平价；
 *   HTTP 状态码只表达传输层：401 未认证 / 404 无工作区 / 400 坏 JSON / 405 方法不符。
 * - abort：响应完成前请求断开 → AbortController.abort() → 内核写路由前兜底（M4 既有）。
 * - 事件是工作区全局广播（凡持有效 token 即可订阅完整 EventBus，含他人 caller 归因）——
 *   面向单团队工作区的取证语义；更细粒度的事件裁剪属上层策略，薄层不做。
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { Socket } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  clientOf,
  newRequestId,
  SAR_IDEMPOTENCY_HEADER,
  SAR_IDEMPOTENT_REPLAY_HEADER,
  SAR_PROTOCOL_HEADER,
  SAR_REQUEST_ID_HEADER,
  SAR_WIRE_VERSION,
  type CallerInfo,
  type CapabilityKind,
  type InvokeOutcome,
  type SarClient,
  type SarKernel,
  type WireErrorCode,
} from '@geoverse-sar/kernel';

export interface SarServerOptions {
  /** 工作区 id → 已装配好的内核（客人式：server 不建不销毁宿主内核）。 */
  workspaces: Record<string, SarKernel>;
  /** Bearer token → CallerInfo 映射（权限裁剪/审计归因随 caller 复用内核机制）。 */
  tokens: Record<string, CallerInfo>;
  /**
   * CORS 允许来源；缺省 '*'（本地开发/演示友好）。
   * 传 null 关闭 CORS 头（同源部署或经网关时）。
   */
  corsOrigin?: string | null;
  /** invoke 请求体上限（字节），缺省 10 MiB。 */
  maxBodyBytes?: number;
  /**
   * 幂等缓存条目上限（G1-3），缺省 1000；超出按插入序淘汰最旧。
   * 带 `Idempotency-Key` 头的 invoke 缓存首次 outcome，同 key 重放直接返回不重复执行。
   */
  idempotencyCacheMax?: number;
}

export interface SarServerHandle {
  /** port=0 取随机空闲端口；resolve 出实际端口。 */
  listen(port?: number, host?: string): Promise<{ port: number }>;
  close(): Promise<void>;
  /** 暴露原始 http.Server（嵌入既有进程/自定义路由时用）。 */
  readonly httpServer: Server;
}

const ROUTE_RE = /^\/workspaces\/([^/]+)\/(catalog|invoke|checkpoint|events)$/;

function bearerToken(req: IncomingMessage, url: URL): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length);
  return url.searchParams.get('token') ?? undefined;
}

function firstHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** 传输层错误 envelope（G1-3）：与能力级 InvokeOutcome 明确区分。 */
function sendWireError(
  res: ServerResponse,
  status: number,
  code: WireErrorCode,
  message: string,
  requestId: string,
): void {
  sendJson(res, status, { error: { code, message, requestId } });
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new Error(`请求体超限（>${maxBytes} 字节）`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createSarServer(options: SarServerOptions): SarServerHandle {
  const { workspaces, tokens } = options;
  const corsOrigin = options.corsOrigin === undefined ? '*' : options.corsOrigin;
  const maxBodyBytes = options.maxBodyBytes ?? 10 * 1024 * 1024;
  const idempotencyCacheMax = options.idempotencyCacheMax ?? 1000;

  /** 每连接的解绑函数，close() 时兜底清理。 */
  const liveSockets = new Set<WebSocket>();

  // 幂等缓存（G1-3）：key = `${workspaceId}::${token}::${idempotencyKey}`（按 token 隔离
  // 租户，防跨客户端重放）→ 首次 outcome。插入序淘汰（Map 保序），只缓存已完成结果——
  // 主要覆盖"网络失败后安全重试"（顺序重放）；不去重并发在途请求（同 key 并发会各执行一次）。
  const idempotencyCache = new Map<string, InvokeOutcome>();
  function idempotencyGet(key: string): InvokeOutcome | undefined {
    return idempotencyCache.get(key);
  }
  function idempotencyPut(key: string, outcome: InvokeOutcome): void {
    idempotencyCache.set(key, outcome);
    while (idempotencyCache.size > idempotencyCacheMax) {
      const oldest = idempotencyCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      idempotencyCache.delete(oldest);
    }
  }

  function applyCors(res: ServerResponse): void {
    if (corsOrigin === null) return;
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader(
      'Access-Control-Allow-Headers',
      `Authorization, Content-Type, ${SAR_IDEMPOTENCY_HEADER}, ${SAR_REQUEST_ID_HEADER}`,
    );
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader(
      'Access-Control-Expose-Headers',
      `${SAR_PROTOCOL_HEADER}, ${SAR_REQUEST_ID_HEADER}, ${SAR_IDEMPOTENT_REPLAY_HEADER}`,
    );
  }

  /** 认证 + 工作区解析；失败已回写响应，返回 undefined。 */
  function resolveContext(
    req: IncomingMessage,
    res: ServerResponse | null,
    url: URL,
    workspaceId: string,
    requestId: string,
  ): { client: SarClient; token: string; caller: CallerInfo } | undefined {
    const token = bearerToken(req, url);
    const caller = token !== undefined ? tokens[token] : undefined;
    if (!caller || token === undefined) {
      if (res) sendWireError(res, 401, 'unauthorized', '未认证或 token 无效', requestId);
      return undefined;
    }
    const kernel = workspaces[workspaceId];
    if (!kernel) {
      if (res) {
        sendWireError(
          res,
          404,
          'workspace_not_found',
          `workspace 不存在: ${workspaceId}`,
          requestId,
        );
      }
      return undefined;
    }
    // caller 逐请求经 token 注入——wire 上不存在可伪造的身份位
    return { client: clientOf(kernel, caller), token, caller };
  }

  const httpServer = createServer((req, res) => {
    void handle(req, res).catch((e) => {
      if (!res.headersSent) {
        const requestId =
          firstHeader(req.headers[SAR_REQUEST_ID_HEADER]) ?? newRequestId();
        sendWireError(
          res,
          500,
          'internal',
          e instanceof Error ? e.message : String(e),
          requestId,
        );
      } else {
        res.destroy();
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    applyCors(res);
    // 传输层关联位（G1-3）：协议版本 + 请求 id（客户端可自带 x-request-id）随每个响应回写
    const requestId = firstHeader(req.headers[SAR_REQUEST_ID_HEADER]) ?? newRequestId();
    res.setHeader(SAR_PROTOCOL_HEADER, String(SAR_WIRE_VERSION));
    res.setHeader(SAR_REQUEST_ID_HEADER, requestId);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://internal');
    const match = ROUTE_RE.exec(url.pathname);
    if (!match) {
      sendWireError(res, 404, 'not_found', 'not found', requestId);
      return;
    }
    const [, workspaceId, action] = match;
    if (action === 'events') {
      // WS 端点走 upgrade；HTTP 直访给出提示
      sendWireError(
        res,
        426,
        'upgrade_required',
        'events 端点须经 WebSocket 连接',
        requestId,
      );
      return;
    }
    const ctx = resolveContext(req, res, url, workspaceId, requestId);
    if (!ctx) return;

    if (action === 'catalog') {
      if (req.method !== 'GET') {
        sendWireError(res, 405, 'method_not_allowed', 'catalog 只支持 GET', requestId);
        return;
      }
      const descriptors = await ctx.client.catalog({
        kind: (url.searchParams.get('kind') as CapabilityKind | null) ?? undefined,
        category: url.searchParams.get('category') ?? undefined,
        tag: url.searchParams.get('tag') ?? undefined,
      });
      sendJson(res, 200, descriptors);
      return;
    }

    if (req.method !== 'POST') {
      sendWireError(res, 405, 'method_not_allowed', `${action} 只支持 POST`, requestId);
      return;
    }

    // 幂等键（G1-3）：带 key 则先查缓存（同 key 重放不重复执行）；执行后存缓存。
    // 按 workspace + token 隔离——防跨客户端重放拿别人结果。
    const idemKey = firstHeader(req.headers[SAR_IDEMPOTENCY_HEADER]);
    const cacheKey = idemKey ? `${workspaceId}::${ctx.token}::${idemKey}` : undefined;
    if (cacheKey) {
      const cached = idempotencyGet(cacheKey);
      if (cached) {
        res.setHeader(SAR_IDEMPOTENT_REPLAY_HEADER, 'true');
        sendJson(res, 200, cached);
        return;
      }
    }

    // 客户端断开 → 中止内核调用（写路由前兜底，半途取消不落地）
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });

    if (action === 'checkpoint') {
      const outcome = await ctx.client.invoke('runtime.checkpoint', undefined, {
        signal: abort.signal,
      });
      // 不缓存中止结果——重试应能重新执行
      if (cacheKey && outcome.error?.code !== 'aborted')
        idempotencyPut(cacheKey, outcome);
      sendJson(res, 200, outcome);
      return;
    }

    // action === 'invoke'
    let body: {
      id?: unknown;
      input?: unknown;
      dryRun?: unknown;
      traceId?: unknown;
      runId?: unknown;
    };
    try {
      const text = await readBody(req, maxBodyBytes);
      body = text ? (JSON.parse(text) as typeof body) : {};
    } catch (e) {
      sendWireError(
        res,
        400,
        'bad_request',
        `请求体不是合法 JSON: ${e instanceof Error ? e.message : String(e)}`,
        requestId,
      );
      return;
    }
    if (typeof body.id !== 'string' || !body.id) {
      sendWireError(
        res,
        400,
        'bad_request',
        'body.id（能力 id）必填且须为字符串',
        requestId,
      );
      return;
    }
    // 执行身份（G1-1）：客户端可传 traceId/runId 关联整条长任务；缺省内核生成。
    // 注意 caller 仍只由 token 注入——traceId/runId 是可观测关联位、不是权限位，可跟随请求。
    const outcome = await ctx.client.invoke(body.id, body.input, {
      dryRun: body.dryRun === true,
      signal: abort.signal,
      traceId: typeof body.traceId === 'string' ? body.traceId : undefined,
      runId: typeof body.runId === 'string' ? body.runId : undefined,
    });
    // 不缓存中止结果——重试应能重新执行
    if (cacheKey && outcome.error?.code !== 'aborted') idempotencyPut(cacheKey, outcome);
    sendJson(res, 200, outcome);
  }

  // ---- WS：EventBus 直桥 ----
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://internal');
    const match = ROUTE_RE.exec(url.pathname);
    if (!match || match[2] !== 'events') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    // WS 握手无响应体 envelope（升级前）；requestId 仅用于内部一致签名
    const ctx = resolveContext(req, null, url, match[1], newRequestId());
    if (!ctx) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      liveSockets.add(ws);
      const off = ctx.client.onEvent((e) => {
        try {
          ws.send(JSON.stringify(e));
        } catch {
          /* 序列化失败/连接已断：跳过该帧，不影响主流程 */
        }
      });
      ws.on('close', () => {
        off();
        liveSockets.delete(ws);
      });
    });
  });

  return {
    httpServer,
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => {
          const addr = httpServer.address();
          resolve({ port: typeof addr === 'object' && addr ? addr.port : port });
        });
      });
    },
    close() {
      for (const ws of liveSockets) ws.terminate();
      liveSockets.clear();
      wss.close();
      return new Promise((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
