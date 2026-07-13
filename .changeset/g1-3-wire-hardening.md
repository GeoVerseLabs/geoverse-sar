---
'@geoverse-sar/kernel': patch
'@geoverse-sar/server': patch
---

阶段三 Gate 1 · G1-3：server wire 硬化——协议版本 + 请求 id + 错误 envelope + 幂等。

修复外部复评 §5 的传输层缺口。**wire body 契约不变**（成功仍是 InvokeOutcome、能力失败仍是 200+ok:false）；只硬化传输层。

- **kernel**：新增 `wire.ts` 稳定契约——`SAR_WIRE_VERSION`、`WireError{ error:{code:WireErrorCode,message,requestId} }`、header 常量（`x-sar-protocol`/`x-request-id`/`idempotency-key`/`x-sar-idempotent-replay`）；`ids.ts` 加 `newRequestId`（`req_`）；`ClientInvokeOptions.idempotencyKey`（本地 clientOf 忽略）。`client-remote`：逐响应校验 `x-sar-protocol` 主版本不符即抛错（早失败）、发 `idempotency-key` 头、`ensureOk` 优先解析 WireError envelope。
- **server**：每个 HTTP 响应带 `x-sar-protocol` + `x-request-id`（客户端可自带 x-request-id）；传输层错误（401/404/400/405/426）改用结构化 `WireError` envelope；POST invoke/checkpoint 支持 `idempotency-key`——同 key 重放返回缓存 outcome（带 `x-sar-idempotent-replay:true`）不重复执行，缓存按 workspace+token 隔离、插入序淘汰（`idempotencyCacheMax` 缺省 1000）、不缓存 aborted。

契约测试：server 新增 5 测（协议/请求id 头 + 客户端自带 x-request-id 回写 / WireError envelope 结构 / 幂等重放不重复执行 + 反证 / createRemoteClient idempotencyKey 重放 / 协议版本不符抛错）。全仓 316 测四门禁全绿。Gate 1 收官。
