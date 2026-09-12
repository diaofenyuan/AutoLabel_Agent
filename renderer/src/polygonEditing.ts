import type { Point } from './types';

export const MAX_POLYGON_POINTS = 4096;
export function insertPolygonPoint(points: Point[], edge: number, point?: Point): Point[] | null {
  if (points.length < 3 || points.length >= MAX_POLYGON_POINTS || !Number.isInteger(edge) || edge < 0 || edge >= points.length) return null;
  const from = points[edge], to = points[(edge + 1) % points.length];
  // 插入点投影到选中边上；包含最后一点到首点的闭合边。
  const dx = to.x - from.x, dy = to.y - from.y, length = dx * dx + dy * dy;
  if (!length) return null;
  const t = point ? Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / length)) : 0.5;
  if (t <= 0 || t >= 1) return null;
  const inserted = { x: from.x + t * dx, y: from.y + t * dy };
  return [...points.slice(0, edge + 1), inserted, ...points.slice(edge + 1)];
}
export function deletePolygonPoint(points: Point[], index: number): Point[] | null {
  return points.length > 3 && Number.isInteger(index) && index >= 0 && index < points.length ? points.filter((_, i) => i !== index) : null;
}
