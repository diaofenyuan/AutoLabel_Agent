import type { Keypoint } from '../../shared/protocol';

// 只接受模板明示的点名或零基索引；缺失点不能被相邻可见点跨接。
export function keypointEdges(points: Keypoint[] = [], connections: unknown): Array<[Keypoint, Keypoint]> {
  if (!Array.isArray(connections)) return [];
  const locate = (value: unknown) => typeof value === 'number' && Number.isInteger(value) ? points[value] : typeof value === 'string' ? points.find(p => p.name === value) : undefined;
  return connections.flatMap(pair => {
    if (!Array.isArray(pair) || pair.length !== 2) return [];
    const left = locate(pair[0]), right = locate(pair[1]);
    return left && right && left.visibility > 0 && right.visibility > 0 && [left.x, left.y, right.x, right.y].every(Number.isFinite) ? [[left, right] as [Keypoint, Keypoint]] : [];
  });
}
