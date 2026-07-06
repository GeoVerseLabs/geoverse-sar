/** geo 视野服务：M2 真地图接入前的内存实现；接入后由 IGMap 适配（whenReady 门控）。 */
export interface GeoViewState {
  center: { x: number; y: number };
  focusedIds: string[];
}

export interface GeoViewService {
  focus(center: { x: number; y: number }, ids: string[]): void;
  current(): GeoViewState | undefined;
  onChange(fn: (v: GeoViewState) => void): () => void;
  /** 视野缩放（可选实现）：绝对级别或增量；返回生效后的级别。 */
  zoom?(opts: { level?: number; delta?: number }): number;
}

export const VIEW_SERVICE_KEY = 'view';

export function createMemoryGeoViewService(): GeoViewService {
  let state: GeoViewState | undefined;
  let level = 12;
  const listeners = new Set<(v: GeoViewState) => void>();
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
    zoom({ level: abs, delta }) {
      level = abs ?? level + (delta ?? 0);
      return level;
    },
  };
}
