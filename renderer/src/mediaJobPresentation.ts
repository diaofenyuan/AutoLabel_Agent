import type { AssetImportSummary, MediaJob, MediaJobStage, MediaJobStatus } from '../../shared/media';

/**
 * 媒体任务的展示文案。
 *
 * 单独放在纯函数模块里：组件导入它要给列表、进度条和回归测试共用，而这些判定不该依赖 React 运行时
 * （node 测试无法引入组件模块）。三种任务类型（抽帧/筛选/后台批量导入）的名称、状态与结果文案都在这里收敛。
 */
export const mediaStatuses: Record<MediaJobStatus, string> = { queued: '排队中', running: '处理中', cancelling: '正在取消', cancelled: '已取消', completed: '已完成', failed: '失败', interrupted: '执行中断' };
export const mediaStages: Record<MediaJobStage, string> = { queued: '等待处理', inspecting: '检查视频', extracting: '抽取视频帧', validating: '校验抽帧结果', ready: '抽帧就绪，待导入', importing: '正在导入素材', screening: '分析素材', done: '处理结束' };

const TERMINAL: readonly MediaJobStatus[] = ['completed', 'failed', 'cancelled', 'interrupted'];

/** 任务名称：抽帧用源视频名，后台批量导入与筛选用固定名。批量导入原先落进筛选名，用户根本认不出这条是什么。 */
export function mediaJobName(job: MediaJob): string {
  if (job.kind === 'video_extract') return job.sourceName ?? '视频抽帧';
  if (job.kind === 'asset_import') return '批量导入素材';
  return '素材筛选分析';
}

/**
 * 进度区第一行（阶段 · 状态）。
 *
 * 批量导入被引擎重启中断时 stage 会停在 importing，若仍拼「正在导入素材 · 执行中断」，
 * 用户看到的是自相矛盾的文案；终态直接以状态为准。其余类型维持原有「阶段 · 状态」。
 */
export function mediaJobStageText(job: MediaJob): string {
  if (job.kind === 'asset_import' && TERMINAL.includes(job.status)) return mediaStatuses[job.status];
  return `${mediaStages[job.stage]} · ${mediaStatuses[job.status]}`;
}

/**
 * 后台批量导入任务的可读结果。
 *
 * 优先用引擎摘要（这批的真实结果），在途时退回进度（已处理/总量 + 跳过 + 失败）；
 * 数字全部来自引擎，界面不做估算，避免出现「看着导入了、其实失败了」的假进展。
 * 导入方式是 reference 时文件未复制进项目，导入结果同样以该文案呈现，不做两套措辞。
 */
export function assetImportTally(job: MediaJob): string | null {
  if (job.kind !== 'asset_import') return null;
  const summary: Partial<AssetImportSummary> | undefined = job.summary;
  if (summary && typeof summary.imported === 'number') {
    const parts = [`已导入 ${summary.imported} 张`];
    if (summary.skipped) parts.push(`已在项目 ${summary.skipped} 张`);
    if (summary.errorsTotal) parts.push(`失败 ${summary.errorsTotal} 张`);
    if (summary.partial) parts.push('中断前已入库的部分保留');
    return parts.join(' · ');
  }
  const { completed, total, skipped, errors } = job.progress;
  if (total !== null && total > 0) {
    const parts = [`已处理 ${completed}/${total}`];
    if (skipped) parts.push(`跳过 ${skipped}`);
    if (errors) parts.push(`失败 ${errors}`);
    return parts.join(' · ');
  }
  return '正在准备导入';
}

/** 列表行的状态副标题：抽帧强调「待导入/已入库」，批量导入给真实结果，筛选只给状态名。 */
export function mediaJobRowNote(job: MediaJob): string {
  if (job.kind === 'video_extract') return job.assetsCommitted ? '已入库' : job.canImport ? (job.status === 'interrupted' ? '导入中断，待续传' : '待导入') : '尚未入库';
  if (job.kind === 'asset_import') return assetImportTally(job) ?? '';
  return '';
}