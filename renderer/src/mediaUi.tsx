import type { MediaJob, MediaJobStage, MediaJobStatus } from '../../shared/media';
import { MediaErrorPanel, type MediaErrorActionHandlers } from './mediaErrorMap';

export { mediaErrorInfo, parseEngineError } from './mediaErrorMap';

export const mediaStatuses: Record<MediaJobStatus, string> = { queued: '排队中', running: '处理中', cancelling: '正在取消', cancelled: '已取消', completed: '已完成', failed: '失败', interrupted: '执行中断' };
export const mediaStages: Record<MediaJobStage, string> = { queued: '等待处理', inspecting: '检查视频', extracting: '抽取视频帧', validating: '校验抽帧结果', ready: '抽帧就绪，待导入', importing: '正在导入素材', screening: '分析素材', done: '处理结束' };
export function mediaJobName(job: MediaJob) { return job.kind === 'video_extract' ? job.sourceName ?? '视频抽帧' : '素材筛选分析'; }
/** 错误文案与替代动作集中在 mediaErrorMap；此处保留原有调用签名，缺省不渲染动作按钮。 */
export function MediaError({ error, handlers, busy }: { error: string; handlers?: MediaErrorActionHandlers; busy?: boolean }) {
  return <MediaErrorPanel error={error} handlers={handlers} busy={busy} />;
}
export function MediaProgressView({ job }: { job: MediaJob }) {
  const p = job.progress;
  return <div className="media-progress"><p>{mediaStages[job.stage]} · {mediaStatuses[job.status]}</p>{p.total !== null && p.total > 0 ? <progress aria-label="素材处理进度" max={p.total} value={Math.min(p.completed, p.total)}/> : ['running', 'queued', 'cancelling'].includes(job.status) ? <progress aria-label="素材处理进度，总量未知"/> : null}<p className="muted tiny">已处理 {p.completed}{p.total === null ? ' · 总量未知' : ` / ${p.total}`}{p.completedFrames !== undefined && ` · 已生成 ${p.completedFrames} 帧`}{p.decodedFrames !== undefined && ` · 已解码 ${p.decodedFrames} 帧`}{p.sourceTimeSeconds !== undefined && ` · 源视频 ${p.sourceTimeSeconds.toFixed(2)} 秒`}</p></div>;
}
