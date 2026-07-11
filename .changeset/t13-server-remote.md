---
'@geoverse-sar/kernel': patch
'@geoverse-sar/server': patch
---

远程化收尾（阶段二 T13，目标架构 R7/S3）——服务形态与远程 SarClient：

- **新包 `@geoverse-sar/server`**（Node-only，`node:http` + `ws`）：`createSarServer({ workspaces, tokens })` 把内核漏斗口挂成 HTTP+WS 薄层——wire 就是 `InvokeOutcome`（能力级失败=200+`ok:false`，HTTP 状态码只表达传输层 401/404/400/405/426）；`Authorization: Bearer token`→`CallerInfo` 逐请求经 `clientOf` 注入（请求体伪造 caller 字段不被读取，身份从"约定"变"结构"）；WS `/events` 是 EventBus 直桥（帧序列与本地订阅逐帧一致）；请求断开→内核 AbortSignal 兜底；`/checkpoint` 是 `invoke('runtime.checkpoint')` 语法糖；CORS 缺省 `*` 可关。
- **kernel 子导出 `client-remote`**：`createRemoteClient(url, token)` 还原同一 `SarClient` 切面——planner/agent/UI 零改动远程成立；`signal` 中止合成 `aborted` outcome 与本地平价；`eventsReady()` 提供懒连接不丢帧的就绪点；环境中立（浏览器零配置，Node 20 经 `webSocket` 选项注入 `ws` 实现）；不自动重连（断线走 `onSocketDown` 交宿主决策）。
- **S3 验收钉死**（server 17 测）：本地/远程 catalog 逐字节相等、双胞胎内核同参 invoke 去时序位后 outcome 全等（含 diff/dryRun/未知能力/取消）、token 身份裁剪+兜底 `permission_denied`、WS 事件序列 JSON 往返全等。
- 演示：`examples/remote-server`（`pnpm playground:server`，端口 8130）+ playground `/remote.html`（整页仅一个 createRemoteClient）。
