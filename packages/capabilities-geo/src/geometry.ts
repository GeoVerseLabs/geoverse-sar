import type { Geometry, Position } from 'geojson';

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

export type Bbox = [number, number, number, number];

export function bboxOf(g: Geometry): Bbox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  walkCoords(g, (pos) => {
    minX = Math.min(minX, pos[0]);
    minY = Math.min(minY, pos[1]);
    maxX = Math.max(maxX, pos[0]);
    maxY = Math.max(maxY, pos[1]);
    return pos;
  });
  return [minX, minY, maxX, maxY];
}

export function centerOf(g: Geometry): { x: number; y: number } {
  const [minX, minY, maxX, maxY] = bboxOf(g);
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

export function bboxIntersects(a: Bbox, b: Bbox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}
