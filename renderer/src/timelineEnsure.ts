import type { TrackTimelineEnsureResult } from '../../shared/tracks';

/**
 * ensure 结果里为指定抽帧任务取到时间轴标识：本轮新建的优先，其次是已存在的。
 * 抽帧进度条靠它把「这条视频轨迹」的入口指到正确时间轴，取不到时空串表示暂无。
 */
export function ensuredTimelineId(result: TrackTimelineEnsureResult, mediaJobId: string): string {
  return result.created.find(item => item.mediaJobId === mediaJobId)?.id
    ?? result.existing.find(item => item.mediaJobId === mediaJobId)?.id ?? '';
}

/**
 * 把补建结果转成一条给用户看的提示。
 *
 * 自动化必须可观测：真补建了要说清楚数量；补不了的任务要给出原因，不能静默吞掉；
 * 超过单轮上限要如实说明还有下一轮。非轨迹项目、无缺口、也无失败时不产出提示，避免打扰。
 */
export function ensureNotice(result: TrackTimelineEnsureResult): string {
  const parts: string[] = [];
  if (result.created.length) parts.push(`已为 ${result.created.length} 个已入库抽帧任务补建视频时间轴`);
  if (result.skipped.length) parts.push(`${result.skipped.length} 个已入库抽帧任务无法建立时间轴：${result.skipped[0].message}`);
  if (result.truncated) parts.push('超出单轮上限的缺口会在下一轮继续补建');
  return parts.join('；');
}