import { VIDEO_DOWNSAMPLE_LONG_EDGE, VIDEO_DOWNSAMPLE_THRESHOLD, VIDEO_MAX_FRAMES, VIDEO_SCENE_MIN_INTERVAL_SECONDS, VIDEO_SCENE_THRESHOLD, type VideoExtractionParameters, type VideoInspection } from '../../shared/media';

/**
 * 一键抽帧按单个抽帧面板的默认参数逐个建任务，这里的取值必须与 VideoImport 的首屏默认保持一致：
 * 场景变化采样、PNG 输出；长边超过阈值时等比缩到目标长边（不留黑边）。
 * 纯参数计算单独成模块：回归测试不需要界面与引擎（bridge/ui 在 node 里不可导入）。
 */
export function batchExtractionPlan(inspection: VideoInspection): { parameters: VideoExtractionParameters; note?: string } | { error: string } {
  // 时长未知时引擎要求显式时间范围，批量场景没人填：这段只能退回单个面板手动处理。
  if (inspection.durationSeconds === null) return { error: '视频时长未知，无法按默认参数抽帧；请在单个抽帧面板里指定时间范围。' };
  const duration = inspection.durationSeconds;
  const longEdge = Math.max(inspection.width, inspection.height);
  const downsampled = longEdge > VIDEO_DOWNSAMPLE_THRESHOLD && inspection.width > 0 && inspection.height > 0;
  const scale = VIDEO_DOWNSAMPLE_LONG_EDGE / longEdge;
  // 场景模式候选帧按每 minInterval 秒一个估算，超过引擎单次上限整单会失败：退到按间隔采样并留出余量。
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
