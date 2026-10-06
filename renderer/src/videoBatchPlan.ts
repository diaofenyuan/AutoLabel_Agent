import { VIDEO_DOWNSAMPLE_LONG_EDGE, VIDEO_DOWNSAMPLE_THRESHOLD, VIDEO_MAX_FRAMES, VIDEO_SCENE_MIN_INTERVAL_SECONDS, VIDEO_SCENE_THRESHOLD, type VideoExtractionParameters, type VideoInspection } from '../../shared/media';

/**
 * 一键抽帧按单个抽帧面板的默认参数逐个建任务，这里的取值必须与 VideoImport 的首屏默认保持一致：
 * 场景变化采样、PNG 输出；长边超过阈值时等比缩到目标长边（不留黑边）。
 * 纯参数计算单独成模块：回归测试不需要界面与引擎（bridge/ui 在 node 里不可导入）。
 */
/**
 * 一键抽帧面板下一次「开始」还要处理的条目：已经排上队的视频必须跳过。
 * 面板在停止后或建完任务后仍会显示开始按钮，重复处理同一个视频会给它建第二个抽帧任务，
 * 抽出的帧再由自动导入哨兵入库，用户得到的是同一段视频的两份素材。失败项不跳过：那是重试。
 */
export function remainingBatchItems<T extends { state: { kind: string } }>(items: T[]): T[] {
  return items.filter(item => item.state.kind !== 'queued');
}

/** 一键抽帧的条目统计：失败数必须能被带出弹窗，不能只剩一个「未能创建」的数字。 */
export interface BatchOutcome { queued: number; failed: number; pending: number }

export function batchOutcome(items: Array<{ state: { kind: string } }>): BatchOutcome {
  const result: BatchOutcome = { queued: 0, failed: 0, pending: 0 };
  for (const item of items) {
    if (item.state.kind === 'queued') result.queued++;
    else if (item.state.kind === 'failed') result.failed++;
    else result.pending++;
  }
  return result;
}

/** 失败项明细：面板关闭后调用方据此提示「哪些视频没建成、原因是什么」，并可原样重开续跑。 */
export interface BatchFailure { path: string; name: string; error: string }

export function batchFailures(items: Array<{ path: string; name: string; state: { kind: string; error?: string } }>): BatchFailure[] {
  const failures: BatchFailure[] = [];
  for (const item of items) {
    if (item.state.kind !== 'failed') continue;
    // 原因取界面已经显示给用户的那一条；接口没给原因时如实说未知，不编造。
    failures.push({ path: item.path, name: item.name, error: item.state.error || '未返回失败原因' });
  }
  return failures;
}

export function batchExtractionPlan(inspection: VideoInspection): { parameters: VideoExtractionParameters; note?: string } | { error: string } {
  // 时长未知时引擎要求显式时间范围，批量场景没人填：这段只能退回单个面板手动处理。
  if (inspection.durationSeconds === null) return { error: '视频时长未知，无法按默认参数抽帧；请在单个抽帧面板里指定时间范围。' };
  const duration = inspection.durationSeconds;
  const longEdge = Math.max(inspection.width, inspection.height);
  const downsampled = longEdge > VIDEO_DOWNSAMPLE_THRESHOLD && inspection.width > 0 && inspection.height > 0;
  const scale = VIDEO_DOWNSAMPLE_LONG_EDGE / longEdge;
  // 场景模式候选帧按每 minInterval 秒一个估算，超过引擎单次上限整单会失败：退到按间隔采样并留出余量。
  // 边界按「上限内」算（ceil，D 正好是 minInterval 的整数倍时仍用场景模式）：最后一个候选落在 t=D 上，
  // 而视频末帧的 PTS 一定小于时长，实际不会多出那一帧。
  const overLimit = Math.ceil(duration / VIDEO_SCENE_MIN_INTERVAL_SECONDS) > VIDEO_MAX_FRAMES;
  const intervalSeconds = Math.max(1, Math.ceil(duration / Math.max(1, VIDEO_MAX_FRAMES - 1)));
  const parameters: VideoExtractionParameters = {
    ranges: [{ start: 0, end: duration }], streamIndex: inspection.streamIndex, format: 'png',
    ...(downsampled ? { outputSize: { width: Math.max(1, Math.round(inspection.width * scale)), height: Math.max(1, Math.round(inspection.height * scale)), fit: 'contain' as const } } : {}),
    ...(overLimit ? { mode: 'interval' as const, intervalSeconds } : { mode: 'scene' as const, sceneThreshold: VIDEO_SCENE_THRESHOLD, minIntervalSeconds: VIDEO_SCENE_MIN_INTERVAL_SECONDS })
  };
  const notes = [
    ...(overLimit ? [`视频较长（约 ${Math.round(duration)} 秒），场景模式候选帧会超过单次上限，已改为每 ${intervalSeconds} 秒一帧。`] : []),
    ...(downsampled ? [`源视频长边 ${longEdge} 像素，已默认把输出缩到长边 ${VIDEO_DOWNSAMPLE_LONG_EDGE} 像素（保持宽高比）。`] : [])
  ];
  return { parameters, ...(notes.length ? { note: notes.join(' ') } : {}) };
}
