import { useEffect, useRef, useState } from 'react';
import { useApp } from './context';
import { errorMessage, request } from './bridge';
import { Button } from './ui';
import { mediaJobName, mediaStatuses } from './mediaUi';
import type { MediaJob } from '../../shared/media';

/**
 * 抽帧进度条（对话区常驻）。
 *
 * 走查里的断链是：抽帧完成 ≠ 素材可用，用户得自己想到去「任务 → 素材任务」再点一次导入；
 * 而这条自动导入链路其实早就设计好了——`mediaJob` 一直挂在应用层，却没有任何组件读它，
 * 留下的是死状态和过时的注释。这里把它接回来：
 * 1. 对话区直接显示抽帧进度与状态，不必切页；
 * 2. 产物就绪（completed + stage=ready + artifactCommitted）时自动调用 media.video.import；
 * 3. 导入后再自动建立视频时间轴，用户点「去视频轨迹」就能直接落到这一条上。
 *
 * 同一任务只由一处推进：模块级 Set 记录正在导入的任务，避免同时挂载的两个入口重复提交。
 */
const importing = new Set<string>();

export function FrameJobStrip() {
  const { mediaJob, setMediaJob, prefs, notify, refreshAssets, refreshProjects, project, navigate } = useApp();
  const [job, setJob] = useState<MediaJob | null>(null);
  const [error, setError] = useState('');
  const [timelineId, setTimelineId] = useState<string | null>(null);
  const jobId = mediaJob?.id ?? '';
  const autoImport = prefs.frameAutoImport !== false;
  const advanced = useRef('');

  useEffect(() => {
    if (!jobId) { setJob(null); setTimelineId(null); return; }
    let live = true; let timer: ReturnType<typeof setTimeout>;
    async function read() {
      try {
        const next = await request<MediaJob>('media.job.get', { jobId });
        if (!live) return;
        setError(''); setJob(next);
        timer = setTimeout(() => void read(), ['queued', 'running', 'cancelling'].includes(next.status) ? 1200 : 2500);
      } catch (e) {
        if (!live) return;
        setError(errorMessage(e));
        timer = setTimeout(() => void read(), 5000);
      }
    }
    void read();
    return () => { live = false; clearTimeout(timer); };
  }, [jobId]);

  // 产物就绪就自动导入：这一步原先要用户自己记着去任务页点，忘了就会以为素材没进来。
  useEffect(() => {
    if (!job || !jobId || !autoImport) return;
    const ready = job.status === 'completed' && job.stage === 'ready' && job.artifactCommitted && job.canImport && !job.assetsCommitted;
    if (!ready || importing.has(jobId) || advanced.current === jobId) return;
    advanced.current = jobId;
    importing.add(jobId);
    void (async () => {
      try {
        const imported = await request<MediaJob>('media.video.import', { jobId });
        setJob(imported);
        await Promise.all([refreshAssets(), refreshProjects()]);
        // 导入后接着把时间轴建好：原设计就是「导入即建轴」，用户点进去就是这一条，不必在历史里找。
        if (project && ['detect', 'pose'].includes(project.taskType)) {
          try {
            const timeline = await request<{ id: string }>('track.timeline.create', { projectId: project.id, mediaJobId: jobId });
            setTimelineId(timeline.id);
            setMediaJob(current => current?.id === jobId ? { ...current, timelineId: timeline.id } : current);
          } catch { /* 建轴失败不影响素材已经入库这件事，如实让用户自己去轨迹页建 */ }
        }
        notify('抽帧产物已自动导入项目，素材可以直接标注了。');
      } catch (e) {
        setError(errorMessage(e));
      } finally { importing.delete(jobId); }
    })();
  }, [job, jobId, autoImport, project, refreshAssets, refreshProjects, notify, setMediaJob]);

  if (!jobId || !job) return null;
  const ready = job.status === 'completed' && job.artifactCommitted;
  const imported = job.assetsCommitted;
  return <div className="frame-job-strip" role="status" data-status={job.status}>
    <span className="frame-job-name truncate">{mediaJobName(job)}</span>
    <span className="frame-job-state">{imported
      ? '素材已入库，可以直接标注'
      : ready ? (autoImport ? '抽帧就绪，正在导入素材…' : '抽帧就绪，待导入')
        : `${mediaStatuses[job.status]} · 已生成 ${job.progress.completedFrames ?? 0} 帧`}</span>
    <span className="frame-job-actions">
      {imported && timelineId && <Button onClick={() => void navigate('tasks')}>去视频轨迹</Button>}
      {imported && <Button onClick={() => { setMediaJob(null); void navigate('overview'); }}>查看素材</Button>}
      {!imported && ready && !autoImport && <Button className="primary" onClick={async () => {
        try { setJob(await request<MediaJob>('media.video.import', { jobId })); await Promise.all([refreshAssets(), refreshProjects()]); }
        catch (e) { setError(errorMessage(e)); }
      }}>立即导入素材</Button>}
      {!imported && job.status === 'completed' && !job.artifactCommitted && <span className="muted tiny">正在封存抽帧产物…</span>}
      {error && <span className="text-error tiny">{error}</span>}
      <Button onClick={() => setMediaJob(null)}>收起</Button>
    </span>
  </div>;
}

/** 抽帧面板里的自动导入开关：默认开，关掉之后仍然可以在任务页手动导入。 */
export function FrameAutoImportOption({ disabled }: { disabled?: boolean }) {
  const { prefs, savePrefs, notify } = useApp();
  return <label className="checkbox-row">
    <input type="checkbox" disabled={disabled} checked={prefs.frameAutoImport !== false}
      onChange={e => void savePrefs({ ...prefs, frameAutoImport: e.target.checked }).catch(err => notify(errorMessage(err), true))} />
    抽帧完成后自动导入项目（关掉之后也可以在「任务 → 素材任务」手动导入）
  </label>;
}
