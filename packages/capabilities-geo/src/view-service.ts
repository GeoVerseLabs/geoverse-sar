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
  /** 当前视野范围 [minX,minY,maxX,maxY]（可选）——空间观察摘要与 view.bbox 用。 */
  getViewport?(): [number, number, number, number] | undefined;
  /** 当前选择集要素 id（可选，U3-D）——selection.get 指代解析用；宿主适配器接自身选择态。 */
  getSelection?(): string[];
  /** 对齐辅助线开关（可选，U3-D）——返回生效后的开关态；纯 UI 面，不产生 diff。 */
  setSnapGuide?(on: boolean): boolean;
  /**
   * 视口截图（可选，U4-B）：产出当前视图的位图——地图这个模态里一张图胜过千行
   * GeoJSON。实现须尊重 maxWidth（等比缩），输出体积有界；多模态观察接线（U4-4）
   * 随 Provider content-parts 恢复后接入，本方法先行。
   */
  capture?(opts?: {
    maxWidth?: number;
  }):
    | { mediaType: string; dataBase64: string; width: number; height: number }
    | Promise<{ mediaType: string; dataBase64: string; width: number; height: number }>;
}

export const VIEW_SERVICE_KEY = 'view';

export interface MemoryGeoViewService extends GeoViewService {
  /** 测试/宿主侧写选择集（真实宿主由适配器选择态驱动）。 */
  setSelection(ids: string[]): void;
  /** 测试/宿主侧写视野范围。 */
  setViewport(bbox: [number, number, number, number]): void;
}

export function createMemoryGeoViewService(): MemoryGeoViewService {
  let state: GeoViewState | undefined;
  let level = 12;
  let base = 'gd-vec';
  let selection: string[] = [];
  let viewport: [number, number, number, number] | undefined;
  let snapGuide = true;
  const bases = ['gd-vec', 'gd-sat', 'bd-vec', 'bd-sat', 'ocean'];
  const listeners = new Set<(v: GeoViewState) => void>();
  return {
    setSelection(ids) {
      selection = [...ids];
    },
    setViewport(bbox) {
      viewport = bbox;
    },
    getSelection() {
      return [...selection];
    },
    getViewport() {
      return viewport;
    },
    setSnapGuide(on) {
      snapGuide = on;
      return snapGuide;
    },
    capture(opts) {
      // 内存实现：确定性 1×1 PNG（真实宿主由 IGMap/canvas 适配）
      const width = Math.min(1, opts?.maxWidth ?? 1);
      return {
        mediaType: 'image/png',
        dataBase64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        width,
        height: width,
      };
    },
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
