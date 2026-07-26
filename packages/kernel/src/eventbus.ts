import type { TxOrigin } from './ports';
import type { CallerInfo } from './permissions';

/** 统一事件流：人机同栈观测——UI 点击与 AI 调用发出同构事件。 */
export type SarEvent<TDiff = unknown> =
  | {
      type: 'invoke:start';
      capabilityId: string;
      caller: CallerInfo;
      dryRun: boolean;
      traceId: string;
      runId?: string;
    }
  | {
      type: 'invoke:end';
      capabilityId: string;
      caller: CallerInfo;
      ok: boolean;
      durationMs: number;
      errorCode?: string;
      traceId: string;
      runId?: string;
    }
  | {
      type: 'engine:transaction';
      origin: TxOrigin;
      label?: string;
      diff: TDiff;
      /** 关联发起 trace/run（G1-1）：仅 origin='dispatch' 的写路由事务携带；undo/redo 缺席。 */
      traceId?: string;
      runId?: string;
    }
  | {
      type: 'workflow:start';
      workflowId: string;
      caller: CallerInfo;
      dryRun?: boolean;
      traceId: string;
      runId: string;
    }
  | {
      type: 'workflow:end';
      workflowId: string;
      ok: boolean;
      failedStepId?: string;
      dryRun?: boolean;
      traceId: string;
      runId: string;
    }
  | {
      /** 异步作业进度帧（U4-C）：running 期间随 progress() 发出，终局带 succeeded/failed/cancelled。 */
      type: 'job:progress';
      jobId: string;
      title: string;
      status: 'running' | 'succeeded' | 'failed' | 'cancelled';
      progress: number;
      note?: string;
    };

export class EventBus<TDiff = unknown> {
  private listeners = new Set<(e: SarEvent<TDiff>) => void>();

  on(fn: (e: SarEvent<TDiff>) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: SarEvent<TDiff>): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        // 监听者异常不得中断 invoke 主流程
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
