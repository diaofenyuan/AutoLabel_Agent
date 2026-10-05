import type { MediaJob } from '../../shared/media';

/** 「抽帧完成、产物就绪、还没入库」的判定；纯函数供回归测试与自动导入哨兵共用（node 测试不可引入组件模块）。 */
export function importableVideoJobs(jobs: MediaJob[]): MediaJob[] {
  return jobs.filter(job => job.kind === 'video_extract'
    && job.status === 'completed' && job.artifactCommitted && job.canImport && !job.assetsCommitted);
}

/**
 * 自动导入的失败重试上限。
 *
 * 哨兵原先一次失败就把条目拉黑、且全程无声：引擎重启这类瞬时故障会被当成永久失败，
 * 用户还以为是「说好的自动导入」没生效。改成有界重试：瞬时故障下一轮自愈，连续失败到上限
 * 才判定为需人工处理，并且必须给出可观测的提示与出口（见 FrameJobStrip 的哨兵）。
 */
export const AUTO_IMPORT_MAX_ATTEMPTS = 3;

/** 记一次自动导入失败，返回是否已达上限（达上限的条目本会话不再自动重试）。 */
export function registerAutoImportFailure(attempts: Map<string, number>, jobId: string): boolean {
  const next = (attempts.get(jobId) ?? 0) + 1;
  attempts.set(jobId, next);
  return next >= AUTO_IMPORT_MAX_ATTEMPTS;
}

/** 该条目是否已耗尽自动重试次数。 */
export function autoImportExhausted(attempts: Map<string, number>, jobId: string): boolean {
  return (attempts.get(jobId) ?? 0) >= AUTO_IMPORT_MAX_ATTEMPTS;
}
