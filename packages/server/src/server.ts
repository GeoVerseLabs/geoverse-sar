/**
 * @geoverse-sar/server（目标架构 §3.4 / R7）——"薄到不值得叫框架"的服务形态：
 * 不发明协议，wire 格式就是 dispatcher 的归一出参 InvokeOutcome。
 *
 *   POST /workspaces/:id/invoke      body { id, input?, dryRun?, traceId?, runId? } → InvokeOutcome JSON
 *   GET  /workspaces/:id/catalog     ?kind=&category=&tag=        → CapabilityDescriptor[]
 *   WS   /workspaces/:id/events      ?token=                      ← SarEvent 帧（EventBus 直桥）
 *   POST /workspaces/:id/checkpoint  （invoke('runtime.checkpoint') 的语法糖）→ InvokeOutcome JSON
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
  type CallerInfo,
  type CapabilityKind,
  type SarClient,
  type SarKernel,
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
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

  /** 每连接的解绑函数，close() 时兜底清理。 */
  const liveSockets = new Set<WebSocket>();

  function applyCors(res: ServerResponse): void {
    if (corsOrigin === null) return;
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }

  /** 认证 + 工作区解析；失败已回写响应，返回 undefined。 */
  function resolveContext(
    req: IncomingMessage,
    res: ServerResponse | null,
    url: URL,
    workspaceId: string,
  ): { client: SarClient; caller: CallerInfo } | undefined {
    const token = bearerToken(req, url);
    const caller = token !== undefined ? tokens[token] : undefined;
    if (!caller) {
      if (res) sendJson(res, 401, { error: 'unauthorized' });
      return undefined;
    }
    const kernel = workspaces[workspaceId];
    if (!kernel) {
      if (res) sendJson(res, 404, { error: `workspace 不存在: ${workspaceId}` });
      return undefined;
    }
    // caller 逐请求经 token 注入——wire 上不存在可伪造的身份位
    return { client: clientOf(kernel, caller), caller };
  }

  const httpServer = createServer((req, res) => {
    void handle(req, res).catch((e) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      } else {
        res.destroy();
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    applyCors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://internal');
    const match = ROUTE_RE.exec(url.pathname);
    if (!match) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const [, workspaceId, action] = match;
    if (action === 'events') {
      // WS 端点走 upgrade；HTTP 直访给出提示
      sendJson(res, 426, { error: 'events 端点须经 WebSocket 连接' });
      return;
    }
    const ctx = resolveContext(req, res, url, workspaceId);
    if (!ctx) return;

    if (action === 'catalog') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'catalog 只支持 GET' });
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
      sendJson(res, 405, { error: `${action} 只支持 POST` });
      return;
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
      sendJson(res, 400, {
        error: `请求体不是合法 JSON: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }
    if (typeof body.id !== 'string' || !body.id) {
      sendJson(res, 400, { error: 'body.id（能力 id）必填且须为字符串' });
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
    const ctx = resolveContext(req, null, url, match[1]);
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
