import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from './context';
import { errorMessage, request } from './bridge';
import { Button } from './ui';
import { mediaJobName, mediaStatuses } from './mediaUi';
import type { MediaJob, MediaJobList } from '../../shared/media';
import { AUTO_IMPORT_MAX_ATTEMPTS, autoImportExhausted, importableVideoJobs, isImportableVideoJob, registerAutoImportFailure } from './frameAutoImport';
import { trackRequest } from './trackUi';
import { ensuredTimelineId } from './timelineEnsure';

/**
 * 抽帧进度条（对话区常驻）。
 *
 * 走查里的断链是：抽帧完成 ≠ 素材可用，用户得自己想到去「任务 → 素材任务」再点一次导入；
 * 而这条自动导入链路其实早就设计好了——`mediaJob` 一直挂在应用层，却没有任何组件读它，
 * 留下的是死状态和过时的注释。这里把它接回来：
 * 1. 对话区直接显示抽帧进度与状态，不必切页；
 * 2. 产物已封存且可导入（引擎 canImport，覆盖 completed 与导入被中断的 interrupted）时自动调用 media.video.import；
 * 3. 导入后再自动建立视频时间轴，用户点「去视频轨迹」就能直接落到这一条上。
 *
 * 同一任务只由一处推进：模块级 Set 记录正在导入的任务，避免同时挂载的两个入口重复提交。
 */
const importing = new Set<string>();

/**
 * 自动导入的失败计数。瞬时故障（引擎重启、请求抖动）下一轮会自愈，连续失败到上限才判定为需人工处理：
 * 既不让永久失败（如源视频损坏）无限重试，也不把瞬时故障当成永久失败而静默丢掉。
 */
const autoImportAttempts = new Map<string, number>();

/** 哨兵每轮翻页大小与最多处理的任务数：上限兜住超大历史，避免稳态下退化成整表翻页。 */
const SWEEP_PAGE = 100;
const SWEEP_MAX_JOBS = 1000;

/**
 * 全局自动导入哨兵（无界面）。进度条只跟踪界面发起的任务，助手或重试等途径创建的抽帧
 * 完成后会一直停在「待导入」，必须有人记得去任务页点一下——这正是「明明抽完了、项目里
 * 却没素材」的来由。这里定期扫描素材任务，把所有就绪未入库的抽帧产物自动导入各自项目。
 * 导入失败按有界重试处理（瞬时故障自愈，连续失败到上限才判定为需人工处理），
 * 判定后必须提示用户并给出「任务 → 素材任务」出口；引擎对重复导入幂等。
 */
export function AutoImportWatcher() {
  const { prefs, notify, refreshAssets, refreshProjects, navigate, setMediaTaskId } = useApp();
  const autoImport = prefs.frameAutoImport !== false;
  useEffect(() => {
    if (!autoImport) return;
    let live = true, timer: ReturnType<typeof setTimeout>, imported = 0;
    async function sweep() {
      // 本轮刚达失败上限、需要人工处理的条目：只在这一刻提示一次，瞬时故障不打扰用户。
      const exhausted: string[] = [];
      // 本轮导入过素材的项目：导入落库后统一补建时间轴，避免按任务重复调用。
      const importedProjects = new Set<string>();
      try {
        // media.job.list 按 rowid 倒序、单页最多 100：只看第一页会让积压（例如关掉自动导入一段时间后
        // 再打开）里排在 100 条之外的就绪产物永远没人导入。这里按页扫到末尾，并保留一个任务数上限。
        for (let offset = 0; offset < SWEEP_MAX_JOBS; offset += SWEEP_PAGE) {
          const list = await request<MediaJobList>('media.job.list', { kind: 'video_extract', limit: SWEEP_PAGE, offset });
          if (!live) return;
          for (const job of importableVideoJobs(list.items)) {
            if (importing.has(job.id) || autoImportExhausted(autoImportAttempts, job.id)) continue;
            importing.add(job.id);
            try {
              await request<MediaJob>('media.video.import', { jobId: job.id });
              imported++;
              autoImportAttempts.delete(job.id);
              importedProjects.add(job.projectId);
              await Promise.all([refreshAssets(), refreshProjects()]);
            } catch { if (registerAutoImportFailure(autoImportAttempts, job.id)) exhausted.push(job.id); }
            finally { importing.delete(job.id); }
            if (!live) return;
          }
          if (!list.items.length || offset + list.items.length >= list.total) break;
        }
        // 与进度条同一条「导入即建轴」约定：对导入过的每个项目统一走 ensure，既覆盖当前打开的项目，
        // 也覆盖助手/重试在别的项目里产生的任务。引擎幂等，且会如实回报不支持的任务。
        for (const projectId of importedProjects) {
          try { await trackRequest('track.timeline.ensure', { projectId }); }
          catch { /* 建轴失败不影响素材已经入库这件事，打开该项目的轨迹页时会再补一次 */ }
        }
      } catch { /* 引擎未就绪或请求失败：静默等下一轮，不打扰用户 */ }
      if (live) {
        if (imported) notify(`已自动导入 ${imported} 个抽帧任务的素材，可以直接标注。`);
        // 失败必须可观测、可回退：说清连续失败次数与去处，一键落到出问题的那条素材任务。
        if (exhausted.length) notify(`自动导入连续 ${AUTO_IMPORT_MAX_ATTEMPTS} 次失败：${exhausted.length} 个抽帧任务已转为手动处理，请在「任务 → 素材任务」查看原因并导入。`, { error: true, action: { label: '查看素材任务', run: () => { setMediaTaskId(exhausted[0]); void navigate('tasks'); } } });
        imported = 0;
        timer = setTimeout(() => void sweep(), 5000);
      }
    }
    void sweep();
    return () => { live = false; clearTimeout(timer); };
  }, [autoImport, refreshAssets, refreshProjects, notify, navigate, setMediaTaskId]);
  return null;
}

export function FrameJobStrip() {
  const { mediaJob, setMediaJob, prefs, notify, refreshAssets, refreshProjects, navigate } = useApp();
  const [job, setJob] = useState<MediaJob | null>(null);
  const [error, setError] = useState('');
  const [createdTimelineId, setCreatedTimelineId] = useState<string | null>(null);
  const jobId = mediaJob?.id ?? '';
  const autoImport = prefs.frameAutoImport !== false;
  const advanced = useRef('');

  // 导入后统一走 ensure 补建时间轴：用任务自己的项目（助手/重试可能在非当前项目里建任务），
  // 引擎幂等，且会如实回报不支持轨迹的任务；建轴失败不影响「素材已入库」这件事。
  const ensureTimeline = useCallback(async (target: MediaJob) => {
    try {
      const timelineId = ensuredTimelineId(await trackRequest('track.timeline.ensure', { projectId: target.projectId }), target.id);
      if (!timelineId) return;
      setCreatedTimelineId(timelineId);
      setMediaJob(current => current?.id === target.id ? { ...current, timelineId } : current);
    } catch { /* 打开该项目的轨迹页时会再补一次 */ }
  }, [setMediaJob]);

  useEffect(() => {
    if (!jobId) { setJob(null); setCreatedTimelineId(null); return; }
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
  // 判定只认引擎 canImport（见 isImportableVideoJob）：引擎重启把在途导入打断成 interrupted 时，
  // 产物其实已封存，这条链路必须继续补导入，否则用户只能重新抽帧白跑一遍解码。
  useEffect(() => {
    if (!job || !jobId || !autoImport) return;
    if (!isImportableVideoJob(job) || importing.has(jobId) || advanced.current === jobId) return;
    advanced.current = jobId;
    importing.add(jobId);
    void (async () => {
      try {
        const imported = await request<MediaJob>('media.video.import', { jobId });
        setJob(imported);
        await Promise.all([refreshAssets(), refreshProjects()]);
        // 导入后接着把时间轴建好：原设计就是「导入即建轴」，用户点进去就是这一条，不必在历史里找。
        await ensureTimeline(imported);
        notify('抽帧产物已自动导入项目，素材可以直接标注了。');
      } catch (e) {
        setError(errorMessage(e));
      } finally { importing.delete(jobId); }
    })();
  }, [job, jobId, autoImport, ensureTimeline, refreshAssets, refreshProjects, notify]);

  // 一键抽帧建出的任务队列：当前这条走到终态（素材已入库、失败、取消等）就接上下一条，
  // 让整批任务都享有同一条进度与自动导入链路；单个任务没有 following，行为与原先完全一致。
  const following = mediaJob?.following;
  useEffect(() => {
    if (!job || !jobId || !following?.length) return;
    if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)) return;
    // 还能导入（含导入被中断的 interrupted）时，要给自动导入留出兑现时间：导入在跑（importing 里还有它）
    // 或还没轮到它都不推进。原先按 status==='completed' 判断会把 interrupted 任务当成已结算而跳过，
    // 队列会越过它直接跑下一条，这条的产物就再也补不进来了。
    const settled = !isImportableVideoJob(job) || !autoImport
      || (advanced.current === jobId && !importing.has(jobId));
    if (!settled) return;
    setMediaJob(current => current?.id === jobId ? { id: following[0], following: following.slice(1) } : current);
  }, [job, jobId, following, autoImport, setMediaJob]);

  if (!jobId || !job) return null;
  const importable = isImportableVideoJob(job);
  const importInterrupted = importable && job.status === 'interrupted';
  const imported = job.assetsCommitted;
  return <div className="frame-job-strip" role="status" data-status={job.status}>
    <span className="frame-job-name truncate">{mediaJobName(job)}</span>
    <span className="frame-job-state">{imported
      ? '素材已入库，可以直接标注'
      : importable ? (autoImport
        ? (importInterrupted ? '上次导入被中断，正在自动补导入…' : '抽帧就绪，正在导入素材…')
        : (importInterrupted ? '导入被中断，产物已封存，可手动导入' : '抽帧就绪，待导入'))
        : `${mediaStatuses[job.status]} · 已生成 ${job.progress.completedFrames ?? 0} 帧`}</span>
    <span className="frame-job-actions">
      {(imported && (mediaJob?.timelineId ?? createdTimelineId)) && <Button onClick={() => void navigate('tasks')}>查看这条视频轨迹</Button>}
      {imported && <Button onClick={() => { setMediaJob(null); void navigate('overview'); }}>查看素材</Button>}
      {!imported && importable && !autoImport && <Button className="primary" onClick={async () => {
        try { const next = await request<MediaJob>('media.video.import', { jobId }); setJob(next); await Promise.all([refreshAssets(), refreshProjects()]); await ensureTimeline(next); }
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
