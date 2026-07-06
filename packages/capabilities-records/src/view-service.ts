/** 内存视野服务（RFC-0008 §4.2 的"视野占位"）：M2 起由真实地图适配器替换。 */
export interface ViewState {
  center: { x: number; y: number };
  focusedIds: string[];
}

export interface ViewService {
  focus(center: { x: number; y: number }, ids: string[]): void;
  current(): ViewState | undefined;
  onChange(fn: (v: ViewState) => void): () => void;
}

export const VIEW_SERVICE_KEY = 'view';

export function createMemoryViewService(): ViewService {
  let state: ViewState | undefined;
  const listeners = new Set<(v: ViewState) => void>();
  return {
    focus(center, ids) {
      state = { center, focusedIds: [...ids] };
      for (const fn of listeners) fn(state);
    },
    current() {
      return state;
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
