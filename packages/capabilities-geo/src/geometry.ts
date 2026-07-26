import type { Geometry, Position } from 'geojson';

// bbox 工具与 Bbox 类型已收敛到共享底座 @geoverse-sar/geo-profile（U0-3）：
// 这里原样再导出保住既有导入路径；本文件只留能力包私有的几何算子。
export { bboxIntersects, bboxOf, centerOf, type Bbox } from '@geoverse-sar/geo-profile';

/** 递归遍历任意 GeoJSON 几何的坐标（纯平面运算，遵守 geoverse 平面欧氏约束）。 */
function walkCoords(g: Geometry, fn: (pos: Position) => Position): Geometry {
  if (g.type === 'GeometryCollection') {
    return { ...g, geometries: g.geometries.map((sub) => walkCoords(sub, fn)) };
  }
  const map = (c: unknown): unknown =>
    typeof (c as Position)[0] === 'number'
      ? fn(c as Position)
      : (c as unknown[]).map(map);
  return { ...g, coordinates: map(structuredClone(g.coordinates)) } as Geometry;
}

export function translateGeometry(g: Geometry, dx: number, dy: number): Geometry {
  return walkCoords(g, ([x, y, ...rest]) => [x + dx, y + dy, ...rest]);
}
