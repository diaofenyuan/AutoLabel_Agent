import type { MediaJob } from '../../shared/media';

/** 「抽帧完成、产物就绪、还没入库」的判定；纯函数供回归测试与自动导入哨兵共用（node 测试不可引入组件模块）。 */
export function importableVideoJobs(jobs: MediaJob[]): MediaJob[] {
  return jobs.filter(job => job.kind === 'video_extract'
    && job.status === 'completed' && job.artifactCommitted && job.canImport && !job.assetsCommitted);
}
