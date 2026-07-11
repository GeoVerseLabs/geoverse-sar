# @geoverse-sar/server

SAR 的服务形态（目标架构 §3.4 / R7）——**薄到不值得叫框架**的 HTTP+WS 层：不发明协议，wire 格式就是 dispatcher 的归一出参 `InvokeOutcome`。Node-only（`node:http` + `ws`）。

```
POST /workspaces/:id/invoke      body { id, input?, dryRun? } → InvokeOutcome JSON
GET  /workspaces/:id/catalog     ?kind=&category=&tag=        → CapabilityDescriptor[]
WS   /workspaces/:id/events      ?token=                      ← SarEvent 帧（EventBus 直桥）
POST /workspaces/:id/checkpoint  （invoke('runtime.checkpoint') 语法糖）→ InvokeOutcome JSON
```

## 快速开始

```ts
import { createSarServer } from '@geoverse-sar/server';

const server = createSarServer({
  workspaces: { main: kernel }, // 已装配好的 SarKernel（客人式：server 不建不销毁）
  tokens: {
    'tok-admin': { entry: 'ui', id: 'admin' },
    'tok-agent': { entry: 'ai', id: 'agent-1', grantedPermissions: ['records:read'] },
  },
});
const { port } = await server.listen(8130);
// …
await server.close();
```

客户端用 kernel 子导出的 [`createRemoteClient`](../kernel/README.md#远程-sarclient子导出-client-remote)——同一 `SarClient` 切面，本地/远程平价。

## 治理零新增（全部复用内核机制）

- **token → CallerInfo 强制注入**：`Authorization: Bearer <token>`（WS 用 `?token=`）经映射表换算 caller，逐请求 `clientOf(kernel, caller)`。请求体里带任何 caller 字段都**不被读取**——身份从"约定"变"结构"，客户端无处伪造。权限裁剪（目录）与 invoke 强制（兜底）随 caller 自动生效，审计归因照旧。
- **HTTP 状态码只表达传输层**：401 未认证 / 404 无工作区 / 400 坏 JSON / 405 方法不符 / 426 events 需 WS。能力级失败（权限/校验/handler 错）永远是 200 + `ok:false` 的 outcome——与本地入口平价。
- **abort 语义闭环**：响应完成前请求断开 → `AbortController.abort()` → 内核写路由前兜底（M4 既有），半途取消不落地。
- **事件是工作区全局广播**：凡持有效 token 即可订阅完整 EventBus（含他人 caller 归因）——单团队工作区的取证语义；更细事件裁剪属上层策略，薄层不做。
- CORS 缺省 `*`（本地开发/演示友好）；同源部署或经网关时传 `corsOrigin: null` 关闭。

## 演示

仓内 `examples/remote-server/serve.mjs`（`pnpm playground:server`，端口 8130）+ playground `/remote.html`（`createRemoteClient` 连接、目录/调用/事件流全远程）。

指南：[远程模式](../../docs/remote.md) · [入口全景](../../docs/entries.md)
