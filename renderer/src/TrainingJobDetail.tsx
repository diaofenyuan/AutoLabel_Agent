import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { TrainingEpoch, TrainingJob, TrainingLog, TrainingMetricsListing } from '../../shared/training';
import { activeTrainingJob, TRAINING_JOB_STATUS } from '../../shared/training';
import { errorMessage, request } from './bridge';
import { Button, Field, Modal, Notice } from './ui';
import { useApp } from './context';
import { taskNames } from './types';

/**
 * 训练任务详情从训练页抽出来：对话里的任务卡片与任务看板都要打开同一份详情，
 * 页面本身在「模块退场」阶段会被删除，这份视图必须独立存活。
 */
const ARTIFACT_NAMES: Record<string, string> = { best: 'best.pt（最优权重）', last: 'last.pt（最后一轮）', results: 'results.csv', args: 'args.yaml', log: 'train.log' };

export function formatDuration(milliseconds?: number) {
  if (!milliseconds || milliseconds < 0) return '—';
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}
export function formatBytes(bytes?: number) {
  if (!bytes || bytes < 1) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}
export function fmt(value?: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(4) : '—';
}
function MetricChart({ series, maximum, label }: {
  series: Array<{ name: string; color: string; points: Array<number | undefined> }>; maximum?: number; label: string;
}) {
  const values = series.flatMap(item => item.points).filter((value): value is number => typeof value === 'number');
  if (values.length < 2) return null;
  const top = maximum ?? Math.max(...values);
  const scale = top > 0 ? top : 1;
  const width = 320, height = 96;
  return <figure className="training-chart">
    <figcaption className="muted tiny">{label}</figcaption>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      <line x1="0" y1={height - 1} x2={width} y2={height - 1} className="axis" />
      {series.map(item => {
        const count = item.points.length;
        const path = item.points.map((value, index) => value === undefined ? null
          : `${(index / Math.max(1, count - 1)) * width},${height - (value / scale) * (height - 6)}`).filter(Boolean).join(' ');
        const last = [...item.points].reverse().find(value => value !== undefined);
        return path ? <g key={item.name}>
          <polyline points={path} fill="none" stroke={item.color} strokeWidth="1.6" />
          <title>{`${item.name} 最新 ${last?.toFixed(4)}`}</title>
        </g> : null;
      })}
    </svg>
    <div className="training-chart-legend">{series.map(item => {
      const last = [...item.points].reverse().find(value => value !== undefined);
      return <span key={item.name}><i style={{ background: item.color }} />{item.name} {last === undefined ? '—' : last.toFixed(4)}</span>;
    })}</div>
  </figure>;
}

export function TrainingDetail({ jobId, live, onClose, onChanged }: {
  jobId: string; live: boolean; onClose: () => void; onChanged: () => void;
}) {
  const { notify } = useApp();
  const [job, setJob] = useState<TrainingJob | null>(null);
  const [epochs, setEpochs] = useState<TrainingEpoch[]>([]);
  const [log, setLog] = useState<TrainingLog | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [checkpoint, setCheckpoint] = useState<'best' | 'last'>('best');
  const [modelName, setModelName] = useState('');

  const load = useCallback(async () => {
    const [current, metrics, tail] = await Promise.all([
      request<TrainingJob>('training.job.get', { jobId }),
      request<TrainingMetricsListing>('training.job.metrics', { jobId, limit: 2000 }),
      request<TrainingLog>('training.job.log', { jobId, maxBytes: 16384 }),
    ]);
    setJob(current); setEpochs(metrics.items); setLog(tail);
    return current;
  }, [jobId]);

  useEffect(() => { void load().catch(e => setError(errorMessage(e))); }, [load]);
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => { void load().catch(() => undefined); }, 4000);
    return () => window.clearInterval(timer);
  }, [live, load]);

  async function act(action: 'cancel' | 'retry' | 'delete' | 'register') {
    setBusy(true); setError('');
    try {
      if (action === 'cancel') {
        await request('training.job.cancel', { jobId, graceful: true });
        notify('已请求取消，训练将在当前轮次结束后停止');
      } else if (action === 'retry') {
        const next = await request<TrainingJob>('training.job.retry', { jobId });
        notify('已创建新的训练任务');
        onChanged(); onClose();
        if (next?.id) return;
      } else if (action === 'delete') {
        await request('training.job.delete', { jobId, confirm: true });
        notify('训练任务已删除');
        onChanged(); onClose();
        return;
      } else {
        const name = modelName.trim() || `训练结果 ${new Date(job!.createdAt).toLocaleDateString()}`;
        await request('training.job.registerModel', { jobId, checkpoint, name });
        notify('已登记为本地模型，可在标注流程的本地步骤中加载');
      }
      await load();
      onChanged();
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }

  if (!job) return <Modal title="训练详情" wide onClose={onClose}>{error ? <p className="inline-error">{error}</p> : <Notice>正在读取任务…</Notice>}</Modal>;
  const active = activeTrainingJob(job.status);
  const hasArtifacts = job.artifacts.length > 0;
  const canRegister = job.status === 'succeeded' && job.artifacts.some(item => item.kind === 'best' || item.kind === 'last');

  return <Modal title={`训练详情 · ${TRAINING_JOB_STATUS[job.status]}`} wide onClose={onClose}>
    <div className="training-detail">
      <p className="muted tiny break-word">
        任务 {job.id.slice(0, 8)}… · {taskNames[job.taskType]} · 设备 {job.actualDevice ?? job.device ?? '未定'}
        {job.fallback ? `（由 ${job.fallback.requested} 回退：${job.fallback.reason}）` : ''}
        {` · 用时 ${formatDuration(job.elapsedMs)}`}
      </p>
      {job.error && <div className="issue error"><AlertTriangle size={13} />{job.error.code}：{job.error.message}</div>}
      {job.message && <p className="muted tiny">{job.message}</p>}
      {job.etaSeconds ? <p className="muted tiny">估算剩余 {formatDuration(job.etaSeconds * 1000)}（估算值，按已完成轮次均值推算）</p> : null}
      {job.progressKnown && <div className="training-progress large" aria-label="训练进度">
        <span style={{ width: `${Math.round(job.progress * 100)}%` }} /></div>}
      <p className="muted tiny">
        {job.progressKnown ? `已完成 ${job.completedEpochs ?? 0}/${job.epochs ?? 0} 轮` : '尚未产生训练轮次'}
        {job.bestEpoch ? ` · 最优轮次 ${job.bestEpoch}` : ''}
        {` · 快照 ${(job.snapshotHash ?? '').slice(0, 12)}…`}
      </p>

      {job.metricsPrunedAt && <div className="issue">
        <AlertTriangle size={13} />该任务的逐轮指标已按进度保留策略（{job.metricsRetentionDays ?? 0} 天）清理；权重、日志与 results.csv 仍保留在产物目录中。
      </div>}
      <MetricChart label="验证指标（mAP / 精确率 / 召回率，纵轴 0–1）" maximum={1}
        series={[
          { name: 'mAP50', color: '#2f80ed', points: epochs.map(row => row.metrics.mAP50) },
          { name: 'mAP50-95', color: '#9b51e0', points: epochs.map(row => row.metrics.mAP50_95) },
          { name: 'precision', color: '#27ae60', points: epochs.map(row => row.metrics.precision) },
          { name: 'recall', color: '#eb5757', points: epochs.map(row => row.metrics.recall) },
        ]} />
      <MetricChart label="训练损失" series={[
        { name: 'boxLoss', color: '#f2994a', points: epochs.map(row => row.metrics.boxLoss) },
        { name: 'clsLoss', color: '#2d9cdb', points: epochs.map(row => row.metrics.clsLoss) },
        { name: 'dflLoss', color: '#828282', points: epochs.map(row => row.metrics.dflLoss ?? row.metrics.loss) },
      ]} />
      <p className="muted tiny">指标来自 ultralytics 训练过程的真实输出，与 results.csv 逐轮一致；它不等于业务准确率。</p>

      {!!epochs.length && <details open><summary>逐轮数值</summary>
        <table className="training-epochs">
          <thead><tr><th>轮次</th><th>mAP50</th><th>mAP50-95</th><th>精确率</th><th>召回率</th><th>boxLoss</th><th>clsLoss</th><th>耗时</th></tr></thead>
          <tbody>{epochs.map(row => <tr key={row.epoch}>
            <td>{row.epoch}</td><td>{fmt(row.metrics.mAP50)}</td><td>{fmt(row.metrics.mAP50_95)}</td>
            <td>{fmt(row.metrics.precision)}</td><td>{fmt(row.metrics.recall)}</td><td>{fmt(row.metrics.boxLoss)}</td>
            <td>{fmt(row.metrics.clsLoss ?? row.metrics.loss)}</td><td>{formatDuration(row.elapsedMs)}</td>
          </tr>)}</tbody>
        </table>
      </details>}

      <div className="training-artifacts">
        <h3>产物</h3>
        {!hasArtifacts && <p className="muted tiny">训练结束后会列出 best.pt、last.pt、results.csv、args.yaml 与日志摘要。</p>}
        {job.artifacts.map(item => <p key={item.kind} className="muted tiny break-word">
          <strong>{ARTIFACT_NAMES[item.kind] ?? item.kind}</strong> · {formatBytes(item.size)} · {item.hash.slice(0, 16)}…</p>)}
      </div>

      {log?.available && <details><summary>训练日志摘要（末尾 {log.truncated ? '截断' : '完整'}）</summary>
        <pre className="training-log">{log.log}</pre></details>}

      <div className="actions">
        {active && <Button disabled={busy} onClick={() => void act('cancel')}>取消训练</Button>}
        {!active && <Button disabled={busy} onClick={() => void act('retry')}>重试为新任务</Button>}
        {!active && <Button disabled={busy} onClick={() => void act('delete')}>删除任务</Button>}
      </div>
      {canRegister && <div className="training-register">
        <Field label="登记为本地模型">
          <div className="field-grid">
            <select aria-label="产物选择" value={checkpoint} onChange={e => setCheckpoint(e.target.value as 'best' | 'last')}>
              <option value="best">best.pt</option><option value="last">last.pt</option>
            </select>
            <input aria-label="模型名称" placeholder="模型名称（可留空）" value={modelName} onChange={e => setModelName(e.target.value)} />
          </div>
          <Notice>登记后可在标注流程的本地步骤中加载该权重；权重文件仍在训练产物目录内，删除任务前会先阻止。</Notice>
        </Field>
        <Button className="primary" disabled={busy} onClick={() => void act('register')}>登记为本地模型</Button>
      </div>}
      {error && <p className="inline-error">{error}</p>}
    </div>
  </Modal>;
}
