# 远程模式：SarClient over HTTP+WS（T13/R7）

> 目标架构 §3.4 的落地：同一个 runtime，既能嵌在浏览器/Node 进程里用，也能挂成服务被远程入口调——**本地/远程入口平价**是结构不变量，不是集成测试碰巧过。

## 心智模型

```
浏览器/另一进程                          服务进程
┌─────────────────────┐    HTTP    ┌──────────────────────────────┐
│ planner / agent / UI │──invoke──▶│ @geoverse-sar/server（薄层） │
│        ↓ 依赖        │──catalog─▶│   token → CallerInfo 注入    │
│      SarClient       │            │        ↓ clientOf            │
│ (createRemoteClient) │◀──WS 帧───│ SarKernel 单漏斗（治理照旧） │
└─────────────────────┘   events   └──────────────────────────────┘
```

三条结构性保证：

1. **wire = InvokeOutcome**。不发明协议：HTTP 响应体就是 dispatcher 的归一出参。能力级失败（权限/校验/handler 错）是 200 + `ok:false`，与本地同构；HTTP 状态码只表达传输层（401/404/400/405/426）。
2. **caller 不在 wire 上**。身份由服务端从 Bearer token 换算成 `CallerInfo` 后经 `clientOf` 构造绑定——请求体带任何 caller 字段都不被读取，客户端结构性无法伪造。目录裁剪、invoke 强制、审计归因全部复用内核既有机制，服务端零新治理代码。
3. **事件 = EventBus 直桥**。WS 帧就是 `SarEvent` 的 JSON 序列化，序列与本地订阅逐帧一致（平价测试钉死）。

## 服务端（Node）

```ts
import { createSarServer } from '@geoverse-sar/server';

const server = createSarServer({
  workspaces: { main: kernel }, // id → 已装配好的 SarKernel
  tokens: {
    'tok-ui': { entry: 'ui', id: 'u1' },
    'tok-ai': { entry: 'ai', id: 'copilot', grantedPermissions: ['records:read'] },
  },
});
const { port } = await server.listen(8130);
```

- 每 workspace 单实例单写者：并发 = HTTP 天然排队进单漏斗，与引擎同步写路径一致。
- 请求断开 → 内核 AbortSignal 兜底（半途取消不落地）。
- 持久化工作区：宿主先 `openWorkspace(...)`（workspace 包），再把 `ws.kernel` 挂进 `workspaces`——server 不关心状态从哪来（客人式）。
- MCP 与 HTTP 可并存挂同一 workspace（多入口一漏斗的题中之义）。

## 客户端（浏览器 / Node）

```ts
import { createRemoteClient } from '@geoverse-sar/kernel/client-remote';

const client = createRemoteClient('http://127.0.0.1:8130/workspaces/main', 'tok-ui');

const catalog = await client.catalog(); // 已按 token 身份裁剪
const out = await client.invoke('records.add', { records: [{ x: 1, y: 2 }] });
out.ok || console.warn(out.error); // 失败是 outcome，不抛

const off = client.onEvent((e) => render(e)); // 懒连接 WS
await client.eventsReady(); // 需要不丢帧时先 await 就绪点
```

- planner/agent 直接吃它：`createPlanner(client, …)` / `createAgent(client, …)`——T12 切面的全部意义在此兑现，**远程 agent 零改动成立**（观察面走 `runtime.stats` 能力）。
- `signal` 中止 → 合成 `error.code === 'aborted'` 的 outcome（与本地平价）；服务端同时经断开兜底。
- Node 20 无全局 WebSocket：`createRemoteClient(url, token, { webSocket: WebSocket })`（`ws` 包）。
- **不自动重连**：断线经 `onSocketDown` 通知，重连与补帧策略归宿主（错过的帧不可重放——需要完整取证用服务端 audit/journal，不靠事件流）。

## 跑起来看

```shell
pnpm build                 # 包间经 dist 解析
pnpm playground:server     # 端口 8130：内存 records 工作区 + demo-ui/demo-ai 两 token
pnpm playground:dev        # 打开 http://localhost:8090/remote.html
```

remote 页整页只有一个 `createRemoteClient`——目录、调用、实体渲染、事件流全部来自远端；换 token 重连即换身份（目录与审计归因随之变化），填 `bad-token` 可看 401 与事件流拒连。

## 验收断言（S3，均在 `packages/server/tests/`）

- 本地/远程平价：同 caller 的 catalog 逐字节相等；双胞胎内核同参 invoke 去 `durationMs` 后 outcome 全等（含 diff）；dryRun/取消/未知能力同构。
- token→caller 强制：请求体伪造 caller 无效；受限身份目录被裁剪且 invoke 兜底 `permission_denied`；未知 token 401。
- WS 事件与本地 EventBus 序列一致（JSON 往返逐帧全等，含顺序）。
