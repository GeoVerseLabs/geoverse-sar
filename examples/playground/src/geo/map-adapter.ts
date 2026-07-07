/**
 * IGMap 适配（M2）：
 * - GeoViewService 由真实 GMap 实现（focus→setCenter、zoom→setZoom）；
 * - 要素同步：引擎快照 → GVectorLayer Marker 重建（高亮/聚焦改色）。
 * 约定（geoverse CLAUDE.md）：先 map.addLayer(layer) 再 layer.addFeature；
 * Marker 勿传 projection——默认 3857 创建，addFeature 时自动转图层投影。
 */
import { GMap, GVectorLayer, Marker, Polygon as GPolygon, Polyline } from '@geoverse/core-ol';
import type { BaseLayerReference } from '@geoverse/core-ol';
import type { LineString, MultiPolygon, Polygon } from 'geojson';
import type { GeoViewService, GeoViewState } from '@geoverse-sar/capabilities-geo';
import { centerOf } from '@geoverse-sar/capabilities-geo';
import type { GeoStateEngine } from '@geoverse-sar/engine-geo';

// 天地图系列需 token，playground 未配，故只开放免 token 的底图
const BASES: BaseLayerReference[] = ['gd-vec', 'gd-sat', 'bd-vec', 'bd-sat', 'ocean'];

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
    setBase(name: string) {
      if (!(BASES as string[]).includes(name)) {
        throw new Error(`未知底图 "${name}"，可用: ${BASES.join(', ')}`);
      }
      map.switchBase(name as BaseLayerReference);
      return name;
    },
    listBases() {
      return [...BASES];
    },
  };
}

/** 引擎状态 → 地图要素层（点→Marker、线→Polyline、面→Polygon；聚焦描粗、高亮变橙）。 */
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
      const highlighted = f.properties.highlighted === true;
      const color = highlighted
        ? '#ff9f1a'
        : f.properties.type === 'road' || f.properties.type === 'route'
          ? '#2ecc71'
          : '#3a86ff';
      const weight = focused.has(f.id) ? 4 : highlighted ? 3.5 : 2.5;

      if (f.geometry.type === 'LineString') {
        const line = new Polyline({
          path: (f.geometry as LineString).coordinates as number[][],
          strokeColor: color,
          strokeWeight: weight,
        });
        line.setId(f.id);
        layer.addFeature(line);
      } else if (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') {
        // 外环渲染（playground 简化：洞不抠出）
        const rings =
          f.geometry.type === 'Polygon'
            ? [(f.geometry as Polygon).coordinates[0]]
            : (f.geometry as MultiPolygon).coordinates.map((poly) => poly[0]);
        rings.forEach((ring, i) => {
          const area = new GPolygon({
            path: ring as number[][],
            strokeColor: color,
            strokeWeight: weight,
            fillColor: highlighted ? 'rgba(255,159,26,0.25)' : 'rgba(58,134,255,0.18)',
          });
          area.setId(i === 0 ? f.id : `${f.id}#${i}`);
          layer.addFeature(area);
        });
      } else {
        const c = centerOf(f.geometry);
        const marker = new Marker({
          position: [c.x, c.y],
          color,
          size: focused.has(f.id) ? 10 : highlighted ? 9 : 7,
        });
        marker.setId(f.id);
        layer.addFeature(marker);
      }
    }
  };
  return { layer, repaint };
}
