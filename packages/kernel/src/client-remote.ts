/**
 * createRemoteClient（目标架构 R7）：SarClient 的远程实现——
 * 把 @geoverse-sar/server 暴露的 HTTP+WS wire 还原成与本地 clientOf 同形的切面。
 *
 * 设计要点：
 * - **caller 不出现在任何参数里**：身份由服务端从 Bearer token 换算注入（token→CallerInfo），
 *   客户端带什么 caller 字段都不生效——"无处伪造"在远程形态闭环。
 * - **wire 就是 InvokeOutcome**：能力失败（权限/校验/handler 错）是 HTTP 200 + ok:false 的
 *   归一出参，与本地入口平价；只有传输层问题（401/404/网络断）才抛异常。
 * - **取消平价**：`opts.signal` 中止 → fetch 中断，客户端合成 `error.code === 'aborted'`
 *   的 outcome（服务端同时经请求断开触发内核 AbortController 兜底，不落地半途变更）。
 * - 环境中立：默认用 `globalThis.fetch` / `globalThis.WebSocket`（浏览器原生；
 *   Node 20 无全局 WebSocket，经 `webSocket` 选项注入如 `ws` 包的实现）。
 * - 事件订阅懒连接单 socket，多订阅共享；**不做自动重连**（断线经 `onSocketDown`
 *   通知宿主自行决策——重连语义与错过帧的补偿属宿主策略，薄层不猜）。
 */
import type { ClientDescribeFilter, ClientInvokeOptions, SarClient } from './client';
import type { CapabilityDescriptor } from './registry';
import type { InvokeOutcome } from './dispatcher';
import type { SarEvent } from './eventbus';

/** WebSocket 的最小结构子集（浏览器原生与 `ws` 包实现都满足）。 */
export interface RemoteSocket {
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  close(): void;
}
export type RemoteSocketCtor = new (url: string) => RemoteSocket;

export interface RemoteClientOptions {
  /** 缺省 globalThis.fetch。 */
  fetch?: typeof globalThis.fetch;
  /** 缺省 globalThis.WebSocket；Node 侧注入 `ws` 包的 WebSocket。 */
  webSocket?: RemoteSocketCtor;
  /** 事件 socket 断开/出错时通知（薄层不自动重连，由宿主决策）。 */
  onSocketDown?: (reason: 'error' | 'close') => void;
}

export interface RemoteSarClient<TDiff = unknown> extends SarClient<TDiff> {
  /** 关闭事件 socket（HTTP 调用无常驻连接，不受影响）。 */
  close(): void;
  /**
   * 事件 socket 就绪点：resolve 后服务端订阅已挂上，之后发生的事件帧不再丢失。
   * （onEvent 是懒连接——订阅后立即 invoke 可能跑在握手前，需要不丢帧时先 await 本方法。）
   */
  eventsReady(): Promise<void>;
}

/**
 * @param baseUrl 工作区端点，如 `http://127.0.0.1:8130/workspaces/main`
 * @param token   Bearer token（服务端映射成 CallerInfo；事件 WS 经 `?token=` 传递）
 */
export function createRemoteClient<TDiff = unknown>(
  baseUrl: string,
  token: string,
  options: RemoteClientOptions = {},
): RemoteSarClient<TDiff> {
  const base = baseUrl.replace(/\/+$/, '');
  const doFetch =
    options.fetch ?? (globalThis.fetch as typeof globalThis.fetch | undefined);
  if (!doFetch) {
    throw new Error('createRemoteClient: 当前环境无 fetch，请经 options.fetch 注入');
  }

  const authHeaders = { Authorization: `Bearer ${token}` };

  async function ensureOk(res: Response, what: string): Promise<Response> {
    if (res.ok) return res;
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      /* 传输层错误信息尽力而为 */
    }
    throw new Error(
      `远程 ${what} 失败: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`,
    );
  }

  // ---- 事件订阅：懒连接单 socket，多订阅共享 ----
  const listeners = new Set<(e: SarEvent<TDiff>) => void>();
  let socket: RemoteSocket | undefined;
  let socketOpen = false;
  let openWaiters: { res: () => void; rej: (e: Error) => void }[] = [];

  function ensureSocket(): void {
    if (socket) return;
    const Ctor =
      options.webSocket ??
      ((globalThis as Record<string, unknown>).WebSocket as RemoteSocketCtor | undefined);
    if (!Ctor) {
      throw new Error(
        'createRemoteClient: 当前环境无 WebSocket，请经 options.webSocket 注入（如 ws 包）',
      );
    }
    const wsUrl =
      base.replace(/^http/, 'ws') + `/events?token=${encodeURIComponent(token)}`;
    const s = new Ctor(wsUrl);
    s.addEventListener('message', (ev) => {
      let parsed: SarEvent<TDiff>;
      try {
        parsed = JSON.parse(String(ev.data)) as SarEvent<TDiff>;
      } catch {
        return; // 非 JSON 帧忽略（wire 只发 JSON）
      }
      for (const fn of [...listeners]) fn(parsed);
    });
    s.addEventListener('open', () => {
      if (socket !== s) return;
      socketOpen = true;
      for (const w of openWaiters) w.res();
      openWaiters = [];
    });
    const down = (reason: 'error' | 'close') => {
      if (socket !== s) return;
      socket = undefined;
      socketOpen = false;
      for (const w of openWaiters) w.rej(new Error(`事件 socket 断开(${reason})`));
      openWaiters = [];
      options.onSocketDown?.(reason);
    };
    s.addEventListener('error', () => down('error'));
    s.addEventListener('close', () => down('close'));
    socket = s;
  }

  return {
    async catalog(filter?: ClientDescribeFilter): Promise<CapabilityDescriptor[]> {
      const qs = new URLSearchParams();
      if (filter?.kind) qs.set('kind', filter.kind);
      if (filter?.category) qs.set('category', filter.category);
      if (filter?.tag) qs.set('tag', filter.tag);
      const q = qs.toString();
      const url = `${base}/catalog${q ? `?${q}` : ''}`;
      const res = await ensureOk(await doFetch(url, { headers: authHeaders }), 'catalog');
      return (await res.json()) as CapabilityDescriptor[];
    },

    async invoke<O = unknown>(
      id: string,
      input?: unknown,
      opts?: ClientInvokeOptions,
    ): Promise<InvokeOutcome<O, TDiff>> {
      const started = Date.now();
      let res: Response;
      try {
        res = await doFetch(`${base}/invoke`, {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, input, dryRun: opts?.dryRun }),
          signal: opts?.signal,
        });
      } catch (e) {
        // 取消平价：中止 → 与本地入口同构的 aborted outcome（不抛）
        if (opts?.signal?.aborted || (e as Error | undefined)?.name === 'AbortError') {
          return {
            ok: false,
            capabilityId: id,
            error: { code: 'aborted', message: `调用已被取消（请求中止）: ${id}` },
            durationMs: Date.now() - started,
            ...(opts?.dryRun ? { dryRun: true } : {}),
          };
        }
        throw e;
      }
      await ensureOk(res, `invoke ${id}`);
      return (await res.json()) as InvokeOutcome<O, TDiff>;
    },

    onEvent(fn: (e: SarEvent<TDiff>) => void): () => void {
      ensureSocket();
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    eventsReady(): Promise<void> {
      ensureSocket();
      if (socketOpen) return Promise.resolve();
      return new Promise((res, rej) => openWaiters.push({ res, rej }));
    },

    close(): void {
      const s = socket;
      socket = undefined;
      socketOpen = false;
      listeners.clear();
      openWaiters = [];
      s?.close();
    },
  };
}
