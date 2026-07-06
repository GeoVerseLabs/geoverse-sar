import type { TxOrigin } from './ports';
import type { CallerInfo } from './permissions';

/** 统一事件流：人机同栈观测——UI 点击与 AI 调用发出同构事件。 */
export type SarEvent<TDiff = unknown> =
  | {
      type: 'invoke:start';
      capabilityId: string;
      caller: CallerInfo;
      dryRun: boolean;
    }
  | {
      type: 'invoke:end';
      capabilityId: string;
      caller: CallerInfo;
      ok: boolean;
      durationMs: number;
      errorCode?: string;
    }
  | { type: 'engine:transaction'; origin: TxOrigin; label?: string; diff: TDiff }
  | { type: 'workflow:start'; workflowId: string; caller: CallerInfo }
  | { type: 'workflow:end'; workflowId: string; ok: boolean; failedStepId?: string };

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
