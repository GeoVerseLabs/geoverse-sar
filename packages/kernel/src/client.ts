/**
 * SarClient——远程化切面（目标架构 R5，本方案唯一的接口重构）：
 * 入口层（planner/agent/UI）一律依赖这个**可序列化的最小子集**，而非全功能 SarKernel
 * （后者暴露 engine/registry/algebra 等进程内对象，无法跨网络）。
 *
 * 三个刻意为之的设计决策（SAR_TARGET_ARCHITECTURE §3.3）：
 * 1. **caller 不在方法参数里**——构造时绑定（本地 clientOf；远程由服务端从鉴权
 *    token 换算注入）。客户端从此无法伪造身份：权限/审计归因从"约定"变"结构"。
 * 2. **观察面走能力**（runtime.stats）不走对象戳探——远程 agent 自动成立。
 * 3. **SarKernel 保持全功能不删减**——进程内高级用法（beginGroup、直接引擎访问）
 *    不受影响；SarClient 只是子集投影，本地=clientOf、远程=createRemoteClient（R7）。
 */
import type { CapabilityDescriptor, DescribeFilter } from './registry';
import type { InvokeOutcome } from './dispatcher';
import type { SarEvent } from './eventbus';
import type { CallerInfo } from './permissions';
import type { SarKernel } from './kernel';

/** client 侧目录过滤：caller 已构造绑定，不可再指定。 */
export type ClientDescribeFilter = Omit<DescribeFilter, 'caller'>;

/** client 侧调用选项：caller 已构造绑定，只剩 dryRun / 取消 / 执行身份。 */
export interface ClientInvokeOptions {
  dryRun?: boolean;
  signal?: AbortSignal;
  /**
   * 执行身份（G1-1）：一次长任务/agent 运行的多次 invoke 传同一 traceId/runId，
   * 使审计/事件/日志可按单一标识重建时间线；缺省时内核每次生成新 traceId。
   */
  traceId?: string;
  runId?: string;
  /**
   * 幂等键（G1-3）：**远程**实现据此让同 key 的重放返回首次缓存 outcome、不重复执行
   * （安全重试网络失败）。本地 `clientOf` 是进程内直调、无重试语义，忽略此项。
   * 只应用于声明 `EffectDescriptor.idempotency === 'keyed'` 的能力。
   */
  idempotencyKey?: string;
}

export interface SarClient<TDiff = unknown> {
  /** 能力目录（异步化：远程实现要过网络；本地实现也保持同一形状）。 */
  catalog(filter?: ClientDescribeFilter): Promise<CapabilityDescriptor[]>;
  /** 单一漏斗调用（workflow 也以能力形式注册，同一入口）。 */
  invoke<O = unknown>(
    id: string,
    input?: unknown,
    opts?: ClientInvokeOptions,
  ): Promise<InvokeOutcome<O, TDiff>>;
  /** 统一事件流订阅（远程=WS 推送重放，R7）；返回解绑函数。 */
  onEvent(fn: (e: SarEvent<TDiff>) => void): () => void;
}

/**
 * 本地实现：把 kernel 投影成绑定了 caller 的 SarClient。
 * 目录裁剪与 invoke 权限强制用同一 caller——"看不见 ≡ 调不到"在切面上闭合。
 */
export function clientOf<TEntity, TDiff>(
  kernel: SarKernel<TEntity, TDiff>,
  caller: CallerInfo,
): SarClient<TDiff> {
  return {
    async catalog(filter) {
      return kernel.describeAll({ ...filter, caller });
    },
    invoke(id, input, opts) {
      return kernel.invoke(id, input, {
        caller,
        dryRun: opts?.dryRun,
        signal: opts?.signal,
        traceId: opts?.traceId,
        runId: opts?.runId,
      });
    },
    onEvent(fn) {
      return kernel.events.on(fn);
    },
  };
}
