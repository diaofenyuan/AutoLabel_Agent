import { useEffect, useRef, useState } from 'react';
import { ArrowRight, CheckCircle2, LoaderCircle, X } from 'lucide-react';
import type { MediaJob } from '../../shared/media';
import { getBridge, request, errorMessage } from './bridge';
import { Button, IconButton } from './ui';
import { MediaError, MediaProgressView, mediaJobName } from './mediaUi';

/** 自动导入的尝试上限：抽帧完成即导入，但连续失败时不再自动重发。 */
const MAX_AUTO_IMPORTS = 3;

/**
 * 工作台内联的抽帧任务卡。
 *
 * 抽帧对标注工具只是「到达标注」的中间步骤，不是一个需要独立目的的作业，因此进度、导入与
 * 进入标注都留在工作台内完成：创建任务后不再把用户踢去任务中心，再让他自己走回来。
 * 任务完成即自动导入（用户选定的口径），导入成功后卡片退化为一个「开始标注」入口；
 * 失败时通过同一套错误映射给出可执行动作。
 *
 * 转码副本的生命周期也在这里收口：导入进项目后源视频不再被任何后续步骤引用，此时才删除副本。
 */
export default function VideoJobCard({ jobId, temporarySource, onImported, onOpen, onOpenTasks, onDismiss }: {
  jobId: string; temporarySource?: string;
  onImported: () => Promise<unknown> | void;
  onOpen: () => void;
  onOpenTasks: () => void;
  onDismiss: () => void;
}) {
  const [currentId, setCurrentId] = useState(jobId);
  const [job, setJob] = useState<MediaJob | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const imported = useRef(false), recycled = useRef(false), attempts = useRef(0);
  const status = useRef('');
  status.current = job?.status ?? '';
  useEffect(() => { setCurrentId(jobId); setJob(null); imported.current = false; recycled.current = false; }, [jobId]);
  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout>;
    async function read() {
      try {
        const next = await request<MediaJob>('media.job.get', { jobId: currentId });
        if (!live) return;
        setError('');
        setJob(current => !current || current.id !== next.id || next.sequence >= current.sequence ? next : current);
        timer = setTimeout(() => void read(), ['queued', 'running', 'cancelling'].includes(next.status) ? 800 : 3000);
      } catch (e) {
        if (!live) return;
        setError(errorMessage(e));
        timer = setTimeout(() => void read(), 5000);
      }
    }
    void read();
    return () => { live = false; clearTimeout(timer); };
  }, [currentId]);
  /** 导入成功后副本即可回收；导入前的任何阶段都不动它，重试任务还需要重新读这个文件。 */
  useEffect(() => {
    if (!job?.assetsCommitted || recycled.current) return;
    recycled.current = true;
    if (!temporarySource) return;
    void getBridge().then(bridge => bridge.discardTranscode({ path: temporarySource })).catch(() => {});
  }, [job?.assetsCommitted, temporarySource]);
  useEffect(() => () => {
    // 任务还在跑时不能删源文件；这类残留交给启动时的统一清扫。
    if (!temporarySource || recycled.current || !['completed', 'failed', 'cancelled', 'interrupted'].includes(status.current)) return;
    void getBridge().then(bridge => bridge.discardTranscode({ path: temporarySource })).catch(() => {});
  }, [temporarySource]);
  useEffect(() => {
    if (!job || imported.current) return;
    if (job.status !== 'completed' || job.stage !== 'ready' || !job.artifactCommitted || !job.canImport) return;
    // 自动导入连续失败后停下来交给用户显式重试，避免每轮询一次就重发一次请求。
    if (attempts.current >= MAX_AUTO_IMPORTS) return;
    imported.current = true; attempts.current += 1;
    void importFrames();
  }, [job]);
  async function importFrames() {
    setBusy(true); setError('');
    try {
      const next = await request<MediaJob>('media.video.import', { jobId: currentId });
      setJob(current => !current || next.sequence >= current.sequence ? next : current);
      await onImported();
    } catch (e) { imported.current = false; setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  async function control(command: string) {
    setBusy(true); setError('');
    try {
      const next = await request<MediaJob>(command, { jobId: currentId });
      if (next.id !== currentId) { imported.current = false; setCurrentId(next.id); }
      else setJob(current => !current || next.sequence >= current.sequence ? next : current);
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  if (!job) return <section className="video-job-card"><p className="muted tiny"><LoaderCircle className="spin" size={13} /> 正在读取抽帧任务…</p><MediaError error={error} /></section>;
  const committed = Boolean(job.assetsCommitted);
  const importing = busy || job.stage === 'importing';
  return <section className={`video-job-card ${committed ? 'done' : ''}`} aria-live="polite">
    <div className="video-job-head"><strong>{mediaJobName(job)}</strong>{committed && <CheckCircle2 size={14} className="video-job-check" />}<IconButton label="收起抽帧任务卡" onClick={onDismiss}><X size={14} /></IconButton></div>
    <MediaProgressView job={job} />
    {importing && <p className="muted tiny"><LoaderCircle className="spin" size={13} /> 正在把抽出的帧导入项目…</p>}
    {!committed && (job.status === 'failed' || job.status === 'interrupted') && <MediaError busy={busy} handlers={{ retry: () => void control('media.job.retry') }} error={job.error ? `[${job.error.code}] ${job.error.message}` : '抽帧任务未完成'} />}
    <div className="actions">
      {committed
        ? <><Button className="primary" onClick={onOpen}>开始标注<ArrowRight size={14} /></Button><Button onClick={onOpenTasks}>在任务中心查看</Button></>
        : <>{attempts.current >= MAX_AUTO_IMPORTS && error && <Button className="primary" busy={busy} onClick={() => { attempts.current = 0; void importFrames(); }}>重试导入</Button>}{job.canCancel && <Button busy={busy} onClick={() => void control('media.job.cancel')}>{job.status === 'cancelling' ? '正在取消' : '取消抽帧'}</Button>}{job.canRetry && <Button busy={busy} onClick={() => void control('media.job.retry')}>创建重试任务</Button>}<Button onClick={onOpenTasks}>在任务中心查看</Button></>}
    </div>
    <MediaError error={error} busy={busy} />
  </section>;
}
