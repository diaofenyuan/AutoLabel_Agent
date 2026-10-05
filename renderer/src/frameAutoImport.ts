import type { MediaJob } from '../../shared/media';

/**
 * 可以继续入库的抽帧任务终态。
 *
 * 只认 completed 会让引擎重启这条链路断掉：导入在「产物已封存、素材尚未提交」时被中断，
 * 任务落到 interrupted，但引擎的 canImport 仍为 true（artifactCommitted 且未入库且非在途），
 * 产物也在磁盘上完好。此时必须继续自动/手动导入，否则用户只能去素材任务里误点「重新抽帧」，
 * 白白再跑一遍解码。cancelled 是用户主动停止，不自动导入（仍保留素材任务页的手动入口）。
 */
const IMPORTABLE_STATUSES: readonly string[] = ['completed', 'interrupted'];

/**
 * 「产物已封存、尚未入库、可以导入」的判定。
 *
 * 只以引擎给出的 canImport 为准，不再在渲染层重复推导 artifactCommitted/assetsCommitted，
 * 避免引擎契约变化后两边判据漂移。纯函数供回归测试与自动导入哨兵共用（node 测试不可引入组件模块）。
 */
export function isImportableVideoJob(job: MediaJob): boolean {
  return job.kind === 'video_extract' && job.canImport && IMPORTABLE_STATUSES.includes(job.status);
}

export function importableVideoJobs(jobs: MediaJob[]): MediaJob[] {
  return jobs.filter(isImportableVideoJob);
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
