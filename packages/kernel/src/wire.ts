/**
 * 远程 wire 契约（阶段三 G1-3）——把服务形态的可序列化协议收口成稳定 contract
 * （目标架构 §六「把 wire schema 从实现对象收口成稳定 contract」）。
 *
 * 铁律不变（R7）：**成功调用的 wire body 仍然就是 `InvokeOutcome`**——能力级失败是
 * 200 + `ok:false`，与本地入口平价。G1-3 只硬化**传输层**：
 * - 协议版本（响应头 `x-sar-protocol`）：客户端据此检测不兼容，早失败不是发神秘错。
 * - 请求 id（响应头 `x-request-id`）：传输层关联位（区别于执行身份 traceId/runId）。
 * - 错误 envelope：传输层错误（401/404/400/405/426/500）用**结构化** `{ error:{code,message,requestId} }`，
 *   与能力级 InvokeOutcome 明确区分。
 * - 幂等（请求头 `idempotency-key`）：带 key 的重放返回首次缓存的 outcome，不重复执行
 *   （配合 G1-2 的 `EffectDescriptor.idempotency`——keyed 能力可安全重试）。
 */

/** 协议主版本：不兼容变更时 +1；客户端遇到不同主版本即拒绝（早失败）。 */
export const SAR_WIRE_VERSION = 1 as const;

/** 协议版本响应头：服务端每个 HTTP 响应携带，客户端逐响应校验。 */
export const SAR_PROTOCOL_HEADER = 'x-sar-protocol';
/** 请求 id 头：客户端可 `x-request-id` 传入自带关联位，否则服务端生成并回写。 */
export const SAR_REQUEST_ID_HEADER = 'x-request-id';
/** 幂等键请求头：带则同 key 重放返回缓存 outcome。 */
export const SAR_IDEMPOTENCY_HEADER = 'idempotency-key';
/** 幂等重放标记响应头：值为 'true' 表示本次是缓存重放（未重新执行）。 */
export const SAR_IDEMPOTENT_REPLAY_HEADER = 'x-sar-idempotent-replay';

/** 传输层错误码（**不同于**能力级 SarErrorCode——那是 InvokeOutcome.error.code）。 */
export type WireErrorCode =
  | 'unauthorized'
  | 'workspace_not_found'
  | 'not_found'
  | 'bad_request'
  | 'method_not_allowed'
  | 'upgrade_required'
  | 'internal';

/** 传输层错误 envelope（HTTP 非 200 响应体）。 */
export interface WireError {
  error: {
    code: WireErrorCode;
    message: string;
    /** 关联本次请求（日志/追踪）。 */
    requestId?: string;
  };
}
