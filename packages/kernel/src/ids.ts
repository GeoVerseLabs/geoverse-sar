/**
 * 执行身份 id 生成（阶段三 G1-1，Execution Contract Freeze）。
 *
 * - `traceId`：一次**顶层操作**的关联 id——独立 invoke 每次新生成；一条工作流
 *   （无论直调、以能力形式调、还是嵌套）全程共享一个 traceId，内部步骤继承它，
 *   故"一个长任务调用了哪些步骤"可用单一标识回答。
 * - `runId`：一次**持久/编排运行实例**的 id——工作流运行、durable run、agent 循环
 *   各自一个；普通原子 invoke 无运行上下文（runId 可缺席，除非宿主显式给）。
 *
 * 浏览器/Node 通用：优先 `crypto.randomUUID`（现代浏览器与 Node 20 均有全局
 * `crypto`），缺失时回退到时间戳+计数器+随机（不追求密码学强度，只需全局唯一）。
 */
let counter = 0;

function randomSuffix(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  counter = (counter + 1) % 0xffffff;
  return `${Date.now().toString(36)}-${counter.toString(36)}-${Math.floor(
    Math.random() * 0xffffff,
  ).toString(36)}`;
}

/** 生成 trace id（前缀 `tr_`）。 */
export function newTraceId(): string {
  return `tr_${randomSuffix()}`;
}

/** 生成 run id（前缀 `run_`）。 */
export function newRunId(): string {
  return `run_${randomSuffix()}`;
}

/** 生成请求 id（前缀 `req_`）——传输层关联位（G1-3），区别于执行身份 traceId/runId。 */
export function newRequestId(): string {
  return `req_${randomSuffix()}`;
}

/** 执行模式：预览（dryRun）/ 执行 / 回放（journal 级，不经 invoke）。 */
export type ExecutionMode = 'execute' | 'preview' | 'replay';

/**
 * 执行身份（G1-1）：贯穿原子能力 / 工作流 / Agent / MCP / 远程的统一标识载体。
 * 现阶段以字段形式随 InvokeOptions / CapabilityContext / 事件 / 审计传播，
 * 本类型是其**规范分组**，供宿主构造与类型标注。
 */
export interface ExecutionIdentity {
  runId?: string;
  traceId: string;
  mode: ExecutionMode;
}
