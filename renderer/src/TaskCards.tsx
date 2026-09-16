import { useCallback, useEffect, useState } from 'react';
import { Activity, AlertTriangle, FlaskConical, RefreshCw, RotateCcw } from 'lucide-react';
import type { FlowRun } from '../../shared/flow';
import type { TrainingJob } from '../../shared/training';
import { activeTrainingJob, TRAINING_JOB_STATUS } from '../../shared/training';
import { errorMessage, request } from './bridge';
import { Button, Modal, Notice } from './ui';
import { useApp } from './context';
import { TrainingDetail } from './TrainingJobDetail';
import type { AgentStep } from './AgentActivity';
import { statusNames, type Run } from './types';

/**
 * 对话里的任务卡片：把这一步实际启动的训练与流程摊在消息流下方。
 * 卡片只读取引擎状态，进度、指标与失败原因都来自同一条事件流；提交成功不等于完成。
 */
const FINISHED_FLOW = ['completed', 'completed_with_errors', 'failed', 'cancelled', 'partial'];
const flowStatusNames: Record<string, string> = {
  queued: '排队中', running: '执行中', paused: '已暂停', pausing: '正在暂停', needs_attention: '等待人工检查',
  completed: '已完成', completed_with_errors: '完成但有失败', failed: '失败', cancelled: '已取消', partial: '部分完成',
};

function jobIdOf(step: AgentStep): string | undefined {
  if (!['start_training', 'inspect_training_job', 'cancel_training_job'].includes(step.name)) return undefined;
  const result = step.result as Record<string, unknown> | null;
  const job = result?.job as Record<string, unknown> | undefined;
  return typeof job?.id === 'string' ? job.id : undefined;
}
/** 标注运行的终态；未进入终态就继续轮询。 */
const RUN_FINISHED = ['completed', 'completed_with_errors', 'failed', 'cancelled', 'partial'];

function runIdOf(step: AgentStep): string | undefined {
  if (!['start_flow', 'inspect_flow', 'control_flow', 'retry_flow', 'rerun_flow'].includes(step.name)) return undefined;
  const result = step.result as Record<string, unknown> | null | undefined;
  if (!result) return undefined;
  const run = (result.run ?? result) as Record<string, unknown> | undefined;
  return typeof run?.id === 'string' && Array.isArray(run.steps) ? run.id : undefined;
}
/**
 * 普通标注运行（不是流程）的标识。流程运行带 steps 数组，标注运行带 statistics，
 * 用这个差异把两类分开，避免同一张卡片重复出现。
 */
function annotationRunIdOf(step: AgentStep): string | undefined {
  if (!['run_annotation', 'control_run'].includes(step.name)) return undefined;
  const result = step.result as Record<string, unknown> | null | undefined;
  if (!result) return undefined;
  const run = (result.run ?? result) as Record<string, unknown> | undefined;
  return typeof run?.id === 'string' && !Array.isArray(run.steps) ? run.id : undefined;
}
function collect(steps: AgentStep[]) {
  const jobs: string[] = [], runs: string[] = [], annotationRuns: string[] = [];
  for (const step of steps) {
    const jobId = jobIdOf(step), runId = runIdOf(step), annotationRunId = annotationRunIdOf(step);
    if (jobId && !jobs.includes(jobId)) jobs.push(jobId);
    if (runId && !runs.includes(runId)) runs.push(runId);
    if (annotationRunId && !annotationRuns.includes(annotationRunId)) annotationRuns.push(annotationRunId);
  }
  return { jobs, runs, annotationRuns };
}

export function TaskCards({ steps, onUseModel }: { steps: AgentStep[]; onUseModel: (instruction: string) => void }) {
  const { jobs, runs, annotationRuns } = collect(steps);
  if (!jobs.length && !runs.length && !annotationRuns.length) return null;
  return <div className="task-cards" aria-label="本轮任务">
    {jobs.map(jobId => <TrainingTaskCard key={jobId} jobId={jobId} onUseModel={onUseModel} />)}
    {runs.map(runId => <FlowTaskCard key={runId} runId={runId} />)}
    {annotationRuns.map(runId => <AnnotationRunCard key={runId} runId={runId} />)}
  </div>;
}

/**
 * 对话里的标注运行卡片。此前只有训练与流程有卡片，标注运行停在「需要处理」时
 * 对话区什么都不显示，用户必须自己想到去任务中心——这里把状态与下一步一并放回对话。
 */
function AnnotationRunCard({ runId }: { runId: string }) {
  const { navigate, notify, project } = useApp();
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const load = useCallback(async () => {
    try { setRun(await request<Run>('run.get', { runId })); setError(''); }
    catch (e) { setError(errorMessage(e)); }
  }, [runId]);
  useEffect(() => { void load(); }, [load]);
  const live = run ? !RUN_FINISHED.includes(run.status) : true;
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => { void load(); }, 4000);
    return () => window.clearInterval(timer);
  }, [live, load]);
  if (!run) return <article className="task-card" data-status="loading">
    {error ? <p className="inline-error">{error}</p> : <p className="muted tiny"><RefreshCw size={13} className="spin" />正在读取标注任务…</p>}
  </article>;
  const stats = run.statistics ?? {};
  const failed = stats.failed ?? 0, unknown = stats.unknown ?? 0;
  /** 用户在此确认过的重发：原请求可能已计费，这条路径必须由人发起，助手不能代劳。 */
  async function retryUnknown(target: Run) {
    if (busy) return;
    setBusy(true);
    try {
      const assets = (target.samples ?? []).filter(sample => sample.status === 'failed' || sample.status === 'unknown').map(sample => sample.assetId);
      setRun(await request<Run>('run.retry', { runId: target.id, assetIds: assets, retryUnknown: true }));
      setRetrying(false); notify('已提交重试，结果未知的样本会重新发送。');
    } catch (e) { notify(errorMessage(e), true); }
    finally { setBusy(false); }
  }
  return <article className="task-card" data-status={run.status}>
    <header>
      <span className="task-card-title"><Activity size={15} />标注任务 · {String(run.model ?? '')}</span>
      <span className={`training-badge ${run.status}`}>{statusNames[run.status] ?? run.status}</span>
    </header>
    <p className="muted tiny">
      完成 {stats.completed ?? 0} / {stats.total ?? run.total ?? 0} · 成功 {stats.succeeded ?? 0} · 失败 {failed} · 结果未知 {unknown}
      {` · 已发送请求 ${stats.requestsUsed ?? '未知'}`}
    </p>
    {run.status === 'needs_attention' && <><p className="muted tiny">还有 {unknown} 个样本结果未知，未完成的样本不会被当成「无目标图片」。</p>
      <div className="actions">
        <Button disabled={!unknown} className="primary" onClick={() => setRetrying(true)}><RotateCcw size={13} />重试未知样本（{unknown}）</Button>
        <Button onClick={() => { if (!project) { notify('先打开一个项目，导出按项目进行。', true); return; } void navigate('overview').then(() => notify('未完成的样本保持「结果未知」；在概览里点「导出」，未标注的素材可以在导出面板一键剔除。')); }}>先不管未完成的，去导出</Button>
        <Button onClick={() => void navigate('tasks')}>在任务里查看</Button>
      </div></>}
    {run.status !== 'needs_attention' && <div className="actions"><Button onClick={() => void navigate('tasks')}>在任务里查看</Button></div>}
    {retrying && <Modal title="重试结果未知的样本" onClose={() => { if (!busy) setRetrying(false); }}><div className="form-stack">
      <Notice>这 {unknown} 个样本的结果未知，原请求可能已在服务商那边处理或计费；重发会产生新的真实调用。本次同时会带上该任务的失败样本，成功样本保持不变。</Notice>
      <div className="modal-actions"><Button disabled={busy} onClick={() => setRetrying(false)}>取消</Button><Button busy={busy} className="primary" onClick={() => void retryUnknown(run)}>发送重试请求（含未知）</Button></div>
    </div></Modal>}
  </article>;
}

function TrainingTaskCard({ jobId, onUseModel }: { jobId: string; onUseModel: (instruction: string) => void }) {
  const { notify } = useApp();
  const [job, setJob] = useState<TrainingJob | null>(null);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState(false);
  const load = useCallback(async () => {
    try { setJob(await request<TrainingJob>('training.job.get', { jobId })); setError(''); }
    catch (e) { setError(errorMessage(e)); }
  }, [jobId]);
  useEffect(() => { void load(); }, [load]);
  const live = job ? activeTrainingJob(job.status) : true;
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => { void load(); }, 4000);
    return () => window.clearInterval(timer);
  }, [live, load]);
  if (!job) return <article className="task-card" data-status="loading">
    {error ? <p className="inline-error">{error}</p> : <p className="muted tiny"><RefreshCw size={13} className="spin" />正在读取训练任务…</p>}
  </article>;
  const best = job.bestMetrics?.mAP50, loss = job.lastMetrics?.boxLoss ?? job.lastMetrics?.loss;
  return <article className="task-card" data-status={job.status}>
    <header>
      <span className="task-card-title"><FlaskConical size={15} />训练任务 · {job.actualDevice ?? job.device ?? '未定设备'}</span>
      <span className={`training-badge ${job.status}`}>{TRAINING_JOB_STATUS[job.status]}</span>
    </header>
    {job.progressKnown && <div className="training-progress" aria-label="训练进度"><span style={{ width: `${Math.round(job.progress * 100)}%` }} /></div>}
    <p className="muted tiny">
      {job.progressKnown ? `已完成 ${job.completedEpochs ?? 0}/${job.epochs ?? 0} 轮` : '尚未产生训练轮次'}
      {best === undefined ? '' : ` · 最优 mAP50 ${best.toFixed(4)}`}
      {loss === undefined ? '' : ` · 最近 boxLoss ${loss.toFixed(4)}`}
      {` · 快照 ${(job.snapshotHash ?? '').slice(0, 12)}…`}
    </p>
    {job.message && <p className="muted tiny">{job.message}</p>}
    {job.error && <div className="issue error"><AlertTriangle size={13} />{job.error.code}：{job.error.message}</div>}
    {job.artifacts.length > 0 && <p className="muted tiny break-word">产物：{job.artifacts.map(item => item.name).join(' · ')}</p>}
    <div className="actions">
      <Button onClick={() => setDetail(true)}>查看详情</Button>
      {job.status === 'succeeded' && <Button className="primary" onClick={() => { onUseModel('用刚训练好的权重标注当前项目里还没标注的图片；没有登记就先用产物登记为本地模型。'); notify('已把下一步写进输入框，确认后发送。'); }}>用此模型标注</Button>}
    </div>
    {detail && <TrainingDetail jobId={job.id} live={live} onClose={() => setDetail(false)} onChanged={() => void load()} />}
  </article>;
}

function FlowTaskCard({ runId }: { runId: string }) {
  const { navigate } = useApp();
  const [run, setRun] = useState<FlowRun | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try { setRun(await request<FlowRun>('flow.get', { flowRunId: runId })); setError(''); }
    catch (e) { setError(errorMessage(e)); }
  }, [runId]);
  useEffect(() => { void load(); }, [load]);
  const live = run ? !FINISHED_FLOW.includes(run.status) : true;
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => { void load(); }, 4000);
    return () => window.clearInterval(timer);
  }, [live, load]);
  if (!run) return <article className="task-card" data-status="loading">
    {error ? <p className="inline-error">{error}</p> : <p className="muted tiny"><RefreshCw size={13} className="spin" />正在读取流程运行…</p>}
  </article>;
  const stats = run.statistics;
  return <article className="task-card" data-status={run.status}>
    <header>
      <span className="task-card-title"><Activity size={15} />流程 · {run.name}</span>
      <span className={`training-badge ${run.status}`}>{flowStatusNames[run.status] ?? run.status}</span>
    </header>
    <p className="muted tiny">
      步骤 {stats.stepsCompleted}/{stats.stepsTotal}{stats.stepsFailed ? ` · 失败 ${stats.stepsFailed}` : ''}
      {` · 输入 ${stats.inputAssets} 张 · 产出 ${stats.outputAssets} 张 · 已发送请求 ${stats.requestsUsed}`}
      {stats.reused ? ` · 复用 ${stats.reused}` : ''}
    </p>
    {run.pauseReason && <p className="muted tiny">{run.pauseReason}</p>}
    <div className="actions"><Button onClick={() => void navigate('tasks')}>在任务里查看</Button></div>
  </article>;
}
