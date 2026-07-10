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
  /** 底图切换（可选实现）：返回生效的底图名；不认识的名字应抛错并列出可用值。 */
  setBase?(name: string): string;
  /** 宿主可用底图名列表（可选）——view.setBase 的目录提示与校验。 */
  listBases?(): string[];
  /** 当前视野范围 [minX,minY,maxX,maxY]（可选）——空间观察摘要用（T10）。 */
  getViewport?(): [number, number, number, number] | undefined;
}

export const VIEW_SERVICE_KEY = 'view';

export function createMemoryGeoViewService(): GeoViewService {
  let state: GeoViewState | undefined;
  let level = 12;
  let base = 'gd-vec';
  const bases = ['gd-vec', 'gd-sat', 'bd-vec', 'bd-sat', 'ocean'];
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
    setBase(name) {
      if (!bases.includes(name)) {
        throw new Error(`未知底图 "${name}"，可用: ${bases.join(', ')}`);
      }
      base = name;
      return base;
    },
    listBases() {
      return [...bases];
    },
  };
}
