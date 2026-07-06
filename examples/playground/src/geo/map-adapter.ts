/**
 * IGMap 适配（M2）：
 * - GeoViewService 由真实 GMap 实现（focus→setCenter、zoom→setZoom）；
 * - 要素同步：引擎快照 → GVectorLayer Marker 重建（高亮/聚焦改色）。
 * 约定（geoverse CLAUDE.md）：先 map.addLayer(layer) 再 layer.addFeature；
 * Marker 勿传 projection——默认 3857 创建，addFeature 时自动转图层投影。
 */
import { GMap, GVectorLayer, Marker } from '@geoverse/core-ol';
import type { GeoViewService, GeoViewState } from '@geoverse-sar/capabilities-geo';
import { centerOf } from '@geoverse-sar/capabilities-geo';
import type { GeoStateEngine } from '@geoverse-sar/engine-geo';

export function createGMapViewService(map: GMap): GeoViewService {
  let state: GeoViewState | undefined;
  const listeners = new Set<(v: GeoViewState) => void>();
  return {
    focus(center, ids) {
      map.setCenter([center.x, center.y]);
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
    zoom({ level, delta }: { level?: number; delta?: number }) {
      const next = level ?? (map.getZoom() ?? 12) + (delta ?? 0);
      map.setZoom(next);
      return next;
    },
  };
}

/** 引擎状态 → 地图要素层（点要素渲染为 Marker；聚焦描粗、加高亮变橙）。 */
export function createFeatureSync(
  map: GMap,
  engine: GeoStateEngine,
  view: GeoViewService,
): { layer: GVectorLayer; repaint: () => void } {
  const layer = new GVectorLayer({ zIndex: 10 });
  map.addLayer(layer);

  const repaint = (): void => {
    layer.clear();
    const focused = new Set(view.current()?.focusedIds ?? []);
    for (const f of engine.snapshot().entities.values()) {
      const c = centerOf(f.geometry);
      const highlighted = f.properties.highlighted === true;
      const marker = new Marker({
        position: [c.x, c.y],
        color: highlighted ? '#ff9f1a' : f.properties.type === 'road' ? '#2ecc71' : '#3a86ff',
        size: focused.has(f.id) ? 10 : highlighted ? 9 : 7,
      });
      marker.setId(f.id);
      layer.addFeature(marker);
    }
  };
  return { layer, repaint };
}
