import { VIDEO_DENSITY_SECONDS, VIDEO_DOWNSAMPLE_LONG_EDGE, VIDEO_DOWNSAMPLE_THRESHOLD, VIDEO_MAX_FRAMES, VIDEO_MAX_RANGE_SECONDS, VIDEO_SCENE_MIN_INTERVAL_SECONDS, VIDEO_SCENE_THRESHOLD, type VideoDensity, type VideoExtractionParameters, type VideoInspection } from '../../shared/media';

export interface BatchSamplingOptions {
  density?: VideoDensity;
  customMode?: 'interval' | 'every_n' | 'fps';
  customValue?: number;
}

type BatchSampling =
  | { mode: 'scene'; sceneThreshold: number; minIntervalSeconds: number }
  | { mode: 'interval'; intervalSeconds: number }
  | { mode: 'every_n'; everyNFrames: number }
  | { mode: 'fps'; targetFps: number };

/**
 * 一键抽帧的参数计算：默认与单个抽帧面板一样每秒一帧，也可按整批选择的策略采样；
 * PNG 输出，长边超过阈值时等比缩到目标长边（不留黑边）。
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

/** 媒体工作器单线程运行；批量检查撞上前一视频时等待释放，不把临时占用记成失败。 */
export async function retryWhileMediaBusy<T>(operation: () => Promise<T>, options: {
  shouldStop: () => boolean;
  onBusy?: () => void;
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<T | null> {
  const wait = options.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  while (!options.shouldStop()) {
    try {
      return await operation();
    } catch (error) {
      if (!error || typeof error !== 'object' || (error as { code?: unknown }).code !== 'media_busy') throw error;
      options.onBusy?.();
      await wait(750);
    }
  }
  return null;
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

export function batchExtractionPlan(inspection: VideoInspection, options: BatchSamplingOptions = {}): { parameters: VideoExtractionParameters; note?: string } | { error: string } {
  const density = options.density ?? 'standard';
  const customMode = options.customMode ?? 'interval';
  const customValue = options.customValue ?? 1;
  // 时长未知时引擎要求显式时间范围，批量场景没人填：这段只能退回单个面板手动处理。
  if (inspection.durationSeconds === null) return { error: '视频时长未知，无法按当前抽帧参数处理；请在单个面板里指定时间范围。' };
  const duration = inspection.durationSeconds;
  if (!Number.isFinite(duration) || duration <= 0 || duration > VIDEO_MAX_RANGE_SECONDS)
    return { error: `视频时长超过引擎允许的单段范围（${VIDEO_MAX_RANGE_SECONDS} 秒），请在单个抽帧面板里分段处理。` };
  const longEdge = Math.max(inspection.width, inspection.height);
  const downsampled = longEdge > VIDEO_DOWNSAMPLE_THRESHOLD && inspection.width > 0 && inspection.height > 0;
  const scale = VIDEO_DOWNSAMPLE_LONG_EDGE / longEdge;
  let sampling: BatchSampling;
  let estimatedFrames: number;
  let limitAdjustment: string | undefined;
  if (density === 'scene') {
    estimatedFrames = Math.ceil(duration / VIDEO_SCENE_MIN_INTERVAL_SECONDS);
    sampling = { mode: 'scene', sceneThreshold: VIDEO_SCENE_THRESHOLD, minIntervalSeconds: VIDEO_SCENE_MIN_INTERVAL_SECONDS };
  } else {
    let mode: 'interval' | 'every_n' | 'fps';
    let value: number;
    if (density === 'custom') {
      mode = customMode;
      value = customValue;
      const valid = Number.isFinite(value) && (mode === 'every_n'
        ? Number.isSafeInteger(value) && value >= 1 && value <= 1000000
        : value >= 0.001 && value <= (mode === 'fps' ? 240 : VIDEO_MAX_RANGE_SECONDS));
      if (!valid) return { error: mode === 'every_n' ? '源帧间隔需为 1～1000000 的整数。' : mode === 'fps' ? '目标帧率需为 0.001～240。' : `秒间隔需为 0.001～${VIDEO_MAX_RANGE_SECONDS}。` };
    } else {
      mode = 'interval';
      value = VIDEO_DENSITY_SECONDS[density];
    }
    if (mode === 'interval') estimatedFrames = Math.ceil(duration / value);
    else if (mode === 'fps') estimatedFrames = Math.ceil(duration * value);
    else {
      const [numerator, denominator = 1] = (inspection.reportedFrameRate ?? '').split('/').map(Number);
      const reportedRate = Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0 ? numerator / denominator : NaN;
      const sourceRate = Number.isFinite(reportedRate) && reportedRate > 0 ? reportedRate
        : inspection.reportedFrameCount !== null && inspection.reportedFrameCount > 0 ? inspection.reportedFrameCount / duration : NaN;
      if (!Number.isFinite(sourceRate) || sourceRate <= 0) return { error: '源帧率未知，无法估算每 N 个源帧的结果数量；请改用按秒间隔或目标帧率。' };
      estimatedFrames = Math.ceil(duration * sourceRate / value);
    }
    if (estimatedFrames > VIDEO_MAX_FRAMES) {
      if (density !== 'standard' || mode !== 'interval') return { error: `按当前参数预计超过单视频上限 ${VIDEO_MAX_FRAMES} 帧，请调低采样密度。` };
      // 默认每秒一帧沿用原有超长视频兜底，并在条目里明确告知间隔调整。
      value = Math.max(1, Math.ceil(duration / Math.max(1, VIDEO_MAX_FRAMES - 1)));
      limitAdjustment = `视频较长，默认每秒一帧会超过单次上限，已自动放宽到每 ${value} 秒一帧。`;
      estimatedFrames = Math.ceil(duration / value);
    }
    sampling = mode === 'interval' ? { mode, intervalSeconds: value }
      : mode === 'fps' ? { mode, targetFps: value }
      : { mode, everyNFrames: value };
  }
  if (estimatedFrames > VIDEO_MAX_FRAMES) return { error: `按当前参数预计超过单视频上限 ${VIDEO_MAX_FRAMES} 帧，请调低采样密度。` };
  const parameters: VideoExtractionParameters = {
    ranges: [{ start: 0, end: duration }], streamIndex: inspection.streamIndex, format: 'png',
    ...(downsampled ? { outputSize: { width: Math.max(1, Math.round(inspection.width * scale)), height: Math.max(1, Math.round(inspection.height * scale)), fit: 'contain' as const } } : {}),
    ...sampling
  };
  const notes = [
    ...(limitAdjustment ? [limitAdjustment] : []),
    ...(downsampled ? [`源视频长边 ${longEdge} 像素，已默认把输出缩到长边 ${VIDEO_DOWNSAMPLE_LONG_EDGE} 像素（保持宽高比）。`] : [])
  ];
  return { parameters, ...(notes.length ? { note: notes.join(' ') } : {}) };
}
