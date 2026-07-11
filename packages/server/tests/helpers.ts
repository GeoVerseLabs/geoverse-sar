/** 测试装配：双胞胎内核（本地/远端各一，显式 id 保证确定性）+ 服务器脚手架。 */
import { z } from 'zod';
import {
  clientOf,
  createKernel,
  createRuntimePack,
  defineCapability,
  type CallerInfo,
  type SarKernel,
} from '@geoverse-sar/kernel';
import {
  createRemoteClient,
  type RemoteClientOptions,
  type RemoteSarClient,
  type RemoteSocketCtor,
} from '@geoverse-sar/kernel/client-remote';
import {
  InMemoryStateEngine,
  RecordDiffAlgebra,
  type RecordDiff,
  type RecordEntity,
} from '@geoverse-sar/engine-memory';
import { createRecordsPack } from '@geoverse-sar/capabilities-records';
import WebSocket from 'ws';
import { createSarServer, type SarServerHandle } from '../src/index';

export const ADMIN: CallerInfo = { entry: 'ui', id: 'admin-1' };
export const VIEWER: CallerInfo = {
  entry: 'ui',
  id: 'viewer-1',
  grantedPermissions: [], // 白名单为空：带 permissions 声明的能力全被裁掉
};

export const TOKENS = { 'tok-admin': ADMIN, 'tok-viewer': VIEWER };

/** 带权限声明的只读能力：验证 token→caller 的目录裁剪与 invoke 强制。 */
const guarded = defineCapability({
  id: 'test.guarded',
  title: '受保护读取',
  description: '仅测试：声明 permissions 的能力。',
  category: 'test',
  kind: 'read',
  inputSchema: z.object({}),
  outputSchema: z.object({ secret: z.boolean() }),
  permissions: ['test:secret'],
  handler: async () => ({ output: { secret: true } }),
});

/** 慢能力：验证请求中止 → aborted outcome 平价。 */
const slow = defineCapability({
  id: 'test.slow',
  title: '慢读取',
  description: '仅测试：200ms 后返回。',
  category: 'test',
  kind: 'read',
  inputSchema: z.object({}),
  outputSchema: z.object({ done: z.boolean() }),
  handler: async () => {
    await new Promise((r) => setTimeout(r, 200));
    return { output: { done: true } };
  },
});

export function buildKernel(): SarKernel<RecordEntity, RecordDiff> {
  return createKernel<RecordEntity, RecordDiff>({
    engine: new InMemoryStateEngine([]),
    algebra: new RecordDiffAlgebra(),
    packs: [
      createRecordsPack(),
      createRuntimePack(), // checkpoint 未注入服务 → service_missing（路由糖断言用）
      { id: 'test-pack', capabilities: [guarded, slow] },
    ],
  });
}

export interface Harness {
  kernel: SarKernel<RecordEntity, RecordDiff>;
  server: SarServerHandle;
  /** 工作区端点，如 http://127.0.0.1:PORT/workspaces/main */
  base: string;
  /** 服务器根，如 http://127.0.0.1:PORT */
  origin: string;
  close(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const kernel = buildKernel();
  const server = createSarServer({ workspaces: { main: kernel }, tokens: TOKENS });
  const { port } = await server.listen(0);
  const origin = `http://127.0.0.1:${port}`;
  return {
    kernel,
    server,
    base: `${origin}/workspaces/main`,
    origin,
    async close() {
      await server.close();
      kernel.dispose();
    },
  };
}

/** Node 20 无全局 WebSocket：注入 ws 包实现。 */
export function remote(
  base: string,
  token: string,
  opts: Omit<RemoteClientOptions, 'webSocket'> = {},
): RemoteSarClient {
  return createRemoteClient(base, token, {
    ...opts,
    webSocket: WebSocket as unknown as RemoteSocketCtor,
  });
}

export const local = (kernel: SarKernel<RecordEntity, RecordDiff>, caller: CallerInfo) =>
  clientOf(kernel, caller);

/** 去掉时序噪音位后应逐字节相等（本地/远程入口平价）。 */
export function stripTiming<T extends { durationMs?: number }>(
  o: T,
): Omit<T, 'durationMs'> {
  const { durationMs: _durationMs, ...rest } = o;
  return rest;
}

export async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 10));
  }
}
