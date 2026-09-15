import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Cpu, Database, FlaskConical, FolderOpen, Layers, ListChecks, RefreshCw, Sparkles } from 'lucide-react';
import type {
  TrainingDataset, TrainingDatasetListing, TrainingEpoch, TrainingJob, TrainingJobListing, TrainingLog,
  TrainingMetricsListing, TrainingPreflight, TrainingRuntimeState,
} from '../../shared/training';
import {
  activeTrainingJob, defaultTrainingParameters, TRAINING_JOB_STATUS, TRAINING_LIMITS, TRAINING_OPTIMIZERS,
  type TrainingParameters,
} from '../../shared/training';
import { getBridge, isDemo, request, errorMessage } from './bridge';
import { Button, Empty, Field, Modal, Notice } from './ui';
import { taskNames, type TaskType } from './types';
import type { DatasetVersion } from './DatasetVersions';
import { useApp } from './context';

interface ExportRecord {
  id: string; status: string; createdAt: string; taskType: TaskType;
  assetCount: number; trainCount?: number; valCount?: number; labelFormat?: string;
}

const originNames: Record<string, string> = { upload: '本地数据集', export: 'AI 标注结果' };

export default function Training() {
  const { project } = useApp();
  const [runtime, setRuntime] = useState<TrainingRuntimeState | null>(null);
  const [datasets, setDatasets] = useState<TrainingDataset[]>([]);
  const [jobs, setJobs] = useState<TrainingJob[]>([]);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [wizard, setWizard] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (isDemo) return;
    setBusy(true);
    const values = await Promise.allSettled([
      request<TrainingRuntimeState>('training.runtime.get'),
      request<TrainingDatasetListing>('training.dataset.list', { limit: 50 }),
      request<TrainingJobListing>('training.job.list', { limit: 50 }),
    ]);
    if (values[0].status === 'fulfilled') setRuntime(values[0].value);
    else { setRuntime(null); setError(errorMessage(values[0].reason)); }
    if (values[1].status === 'fulfilled') { setDatasets(values[1].value.items); setTotal(values[1].value.total); }
    else setError(errorMessage(values[1].reason));
    if (values[2].status === 'fulfilled') setJobs(values[2].value.items);
    else setError(errorMessage(values[2].reason));
    setBusy(false);
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  // 训练进度只来自引擎的真实轮次事件，界面按固定间隔读取，不自行推算。
  const live = jobs.some(job => activeTrainingJob(job.status));
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => { void refresh(); }, 4000);
    return () => window.clearInterval(timer);
  }, [live, refresh]);

  return <div className="training-page">
    <div className="section-toolbar">
      <h2><FlaskConical size={17} />模型训练</h2>
      <div className="actions">
        <Button disabled={isDemo} busy={busy} onClick={() => void refresh()}><RefreshCw size={14} />刷新</Button>
        <Button className="primary" disabled={isDemo} onClick={() => setWizard(true)}><Sparkles size={14} />新建训练</Button>
      </div>
    </div>
    {isDemo && <Notice>演示模式不含本地训练，请在桌面应用中使用。</Notice>}
    {error && <p className="inline-error">{error}</p>}
    <RuntimeCard runtime={runtime} />
    <div className="section-toolbar"><h3><ListChecks size={15} />训练任务<span className="count">{jobs.length}</span></h3></div>
    {!jobs.length
      ? <Empty icon={<FlaskConical size={22} />} title="尚无训练任务" description="创建数据集快照并完成参数预检后，即可提交训练任务。">
          <Button disabled={isDemo} className="primary" onClick={() => setWizard(true)}><Sparkles size={14} />新建训练</Button>
        </Empty>
      : <div className="training-jobs">{jobs.map(job => <JobRow key={job.id} job={job} onOpen={() => setDetail(job.id)} />)}</div>}
    {!datasets.length && !busy
      ? <Empty icon={<Database size={22} />} title="尚无训练数据集" description="创建一份不可变数据集快照后，即可配置参数并提交训练任务。" />
      : <>
          <div className="section-toolbar"><h3><Layers size={15} />数据集快照<span className="count">{total}</span></h3></div>
          <div className="training-cards">{datasets.map(item => <DatasetCard key={item.id} dataset={item} />)}</div>
        </>}
    {wizard && <TrainingWizard projectId={project?.id ?? null} taskType={project?.taskType ?? 'detect'}
      onClose={() => setWizard(false)} onCreated={() => void refresh()} onSubmitted={jobId => { void refresh(); setDetail(jobId); }} />}
    {detail && <TrainingDetail jobId={detail} live={live} onClose={() => setDetail(null)} onChanged={() => void refresh()} />}
  </div>;
}

function JobRow({ job, onOpen }: { job: TrainingJob; onOpen: () => void }) {
  const epochs = job.epochs ?? 0, completed = job.completedEpochs ?? 0;
  return <button className="training-job" onClick={onOpen}>
    <span className={`training-badge ${job.status}`}>{TRAINING_JOB_STATUS[job.status]}</span>
    <span className="training-job-main">
      <strong>{taskNames[job.taskType]}训练 · {job.actualDevice ?? job.device ?? '未定设备'}</strong>
      <span className="muted tiny">
        {job.progressKnown ? `第 ${completed}/${epochs} 轮` : '等待首个轮次'} · 用时 {formatDuration(job.elapsedMs)}
        {job.etaSeconds ? ` · 估算剩余 ${formatDuration(job.etaSeconds * 1000)}` : ''}
      </span>
    </span>
    {job.progressKnown && <span className="training-progress" aria-label="训练进度">
      <span style={{ width: `${Math.round(job.progress * 100)}%` }} /></span>}
  </button>;
}

function formatDuration(milliseconds?: number) {
  if (!milliseconds || milliseconds < 0) return '—';
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

function RuntimeCard({ runtime }: { runtime: TrainingRuntimeState | null }) {
  if (!runtime) return <Notice>正在读取训练环境…</Notice>;
  const gpu = runtime.devices.filter(device => device.id !== 'cpu');
  return <div className="preflight training-runtime">
    <h3><Cpu size={15} />训练环境</h3>
    <p>Python：{runtime.configured ? runtime.pythonVersion ?? '已配置' : '未配置'} · Ultralytics：{runtime.ultralyticsVersion ?? '未检测'} · PyTorch：{runtime.torchVersion ?? '未检测'}</p>
    <p>CUDA：{runtime.cudaAvailable ? '可用' : '不可用'} · 设备：{runtime.configured ? `${gpu.length} 个 GPU + CPU` : '未探测'} · 训练组件：{runtime.workerAvailable ? '已就位' : '缺失'}</p>
    {!!runtime.busyBy.length && <div className="issue"><AlertTriangle size={13} />设备 {runtime.busyBy.join('、')} 正被本地推理占用，训练提交后需等待其释放。</div>}
    {!!runtime.busyByTraining?.length && <div className="issue"><AlertTriangle size={13} />设备 {runtime.busyByTraining.join('、')} 正被训练任务占用，该设备上的本地推理会暂时被拒绝。</div>}
    {runtime.issue && <div className="issue"><AlertTriangle size={13} />{runtime.issue.message}</div>}
  </div>;
}

function DatasetCard({ dataset }: { dataset: TrainingDataset }) {
  const summary = dataset.inspection.summary;
  const errors = dataset.inspection.issues.filter(issue => issue.severity === 'error');
  return <article className="training-card">
    <header>
      <strong>{originNames[dataset.origin] ?? dataset.origin}</strong>
      <span className={`training-badge ${dataset.status}`}>{dataset.status === 'ready' ? '可训练' : '体检未通过'}</span>
    </header>
    <p className="muted">{taskNames[dataset.taskType]} · {summary.images} 张图片 · {summary.objects} 个目标 · {dataset.classes.length} 类</p>
    <p className="muted tiny">划分：{Object.entries(summary.splits).map(([split, count]) => `${split} ${count}`).join(' · ') || '无'}</p>
    <p className="muted tiny break-word">快照 {dataset.snapshotHash.slice(0, 12)}… · {new Date(dataset.createdAt).toLocaleString()}</p>
    {dataset.status !== 'ready' && <div className="issue"><AlertTriangle size={13} />{errors[0]?.message ?? '存在阻断问题，请重新创建快照。'}</div>}
  </article>;
}

function TrainingWizard({ projectId, taskType, onClose, onCreated, onSubmitted }: {
  projectId: string | null; taskType: TaskType; onClose: () => void; onCreated: () => void; onSubmitted: (jobId: string) => void;
}) {
  const { notify, prefs } = useApp();
  const [step, setStep] = useState(1);
  const [source, setSource] = useState<'upload' | 'export' | 'version'>('upload');
  const [trainDir, setTrainDir] = useState(''), [valDir, setValDir] = useState('');
  const [datasetTaskType, setDatasetTaskType] = useState<TaskType>(taskType);
  const [classNames, setClassNames] = useState('');
  const [exports, setExports] = useState<ExportRecord[]>([]), [exportId, setExportId] = useState('');
  const [versions, setVersions] = useState<DatasetVersion[]>([]), [versionId, setVersionId] = useState('');
  const [exportBusy, setExportBusy] = useState(false);
  const [annotationSelection, setAnnotationSelection] = useState<'protected' | 'candidate'>('protected');
  const [trainRatio, setTrainRatio] = useState(0.8);
  const [parameters, setParameters] = useState<TrainingParameters>(() => ({
    ...defaultTrainingParameters(),
    device: typeof prefs.trainingDevice === 'string' && prefs.trainingDevice ? prefs.trainingDevice : undefined,
    workers: typeof prefs.trainingWorkers === 'number' ? prefs.trainingWorkers : undefined,
  }));
  const [created, setCreated] = useState<TrainingDataset | null>(null);
  const [preflight, setPreflight] = useState<TrainingPreflight | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');

  useEffect(() => {
    if (source !== 'export' || !projectId) return;
    void request<ExportRecord[]>('export.list', { projectId })
      .then(list => setExports(list.filter(item => item.status === 'completed')))
      .catch(e => setError(errorMessage(e)));
  }, [source, projectId]);

  // 只列出 ready 版本：非 ready 版本不可被训练快照消费（I8）。
  useEffect(() => {
    if (source !== 'version' || !projectId) return;
    void request<{ items: DatasetVersion[] }>('dataset.version.list', { projectId })
      .then(page => setVersions(page.items.filter(item => item.status === 'ready')))
      .catch(e => setError(errorMessage(e)));
  }, [source, projectId]);

  const parsedClassNames = useMemo(() => classNames.split(/[\n,]/).map(value => value.trim()).filter(Boolean), [classNames]);
  const directoryReady = !!trainDir && !!valDir;

  async function choose(field: 'train' | 'val') {
    try {
      const files = await (await getBridge()).chooseFiles({ kind: 'directory' });
      if (!files[0]) return;
      if (field === 'train') setTrainDir(files[0]); else setValDir(files[0]);
      setCreated(null); setPreflight(null);
    } catch (e) { setError(errorMessage(e)); }
  }

  /** 复用既有导出链路生成一份 YOLO 训练数据，再作为固定导出版本引用。 */
  async function exportCurrentProject() {
    if (!projectId) return;
    try {
      const files = await (await getBridge()).chooseFiles({ kind: 'directory' });
      if (!files[0]) return;
      setExportBusy(true); setError('');
      const record = await request<ExportRecord>('export.create', {
        projectId, outputDir: files[0], trainRatio, annotationSelection,
        format: { labelFormat: 'yolo', includeDataYaml: true },
      });
      setExports(list => [record, ...list]);
      setExportId(record.id);
      notify('已生成导出版本，可选择作为训练数据来源');
    } catch (e) { setError(errorMessage(e)); }
    finally { setExportBusy(false); }
  }

  async function createDataset() {
    setBusy(true); setError(''); setPreflight(null);
    try {
      const payload: Record<string, unknown> = source === 'upload'
        ? { source, trainDir, valDir, taskType: datasetTaskType, ...(projectId ? { projectId } : {}), ...(parsedClassNames.length ? { classNames: parsedClassNames } : {}) }
        : source === 'export'
          ? { source, exportId, ...(projectId ? { projectId } : {}) }
          : { source, versionId, ...(projectId ? { projectId } : {}) };
      const dataset = await request<TrainingDataset>('training.dataset.create', payload);
      setCreated(dataset);
      onCreated();
      if (dataset.status !== 'ready') notify('数据集体检未通过，请按提示修复后重新创建', true);
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }

  async function runPreflight() {
    if (!created) return;
    setBusy(true); setError('');
    try { setPreflight(await request<TrainingPreflight>('training.job.preflight', { datasetId: created.id, parameters })); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }

  /** 提交必须带显式确认：引擎会二次校验预检，界面不代替引擎做放行判断。 */
  async function submit() {
    if (!created) return;
    setBusy(true); setError('');
    try {
      const report = preflight ?? await request<TrainingPreflight>('training.job.preflight', { datasetId: created.id, parameters });
      setPreflight(report);
      if (!report.ok) { setError('预检未通过，请先修复下方阻断问题。'); return; }
      const job = await request<TrainingJob>('training.job.create', { datasetId: created.id, parameters, confirm: true });
      notify('训练任务已提交');
      onSubmitted(job.id);
      onClose();
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }

  const patches = (values: Partial<TrainingParameters>) => setParameters(current => ({ ...current, ...values }));
  const ready = !!created && created.status === 'ready';

  return <Modal title="新建训练" wide onClose={() => { if (!busy) onClose(); }}>
    <div className="training-wizard">
      <div className="tabs" role="tablist">
        {[['数据源', 1], ['训练参数', 2], ['确认提交', 3]].map(([label, index]) => <button key={index as number} role="tab"
          className={step === index ? 'selected' : ''} disabled={index === 3 || (index === 2 && !created)}
          aria-selected={step === index} onClick={() => setStep(index as number)}>{String(index)}. {label}</button>)}
      </div>
      <div className="training-wizard-body">
        {step === 1 && <>
          <div className="training-sources">
            <button className={source === 'upload' ? 'selected' : ''} onClick={() => setSource('upload')}>
              <FolderOpen size={17} /><strong>本地已标注数据集</strong><small>分别选择训练集与验证集目录</small>
            </button>
            <button className={source === 'export' ? 'selected' : ''} onClick={() => setSource('export')}>
              <Sparkles size={17} /><strong>AI 标注结果</strong><small>引用已完成的导出版本</small>
            </button>
            <button className={source === 'version' ? 'selected' : ''} onClick={() => setSource('version')}>
              <Layers size={17} /><strong>数据集版本</strong><small>引用不可变版本，内容可逐项复核</small>
            </button>
          </div>
          {source === 'upload' && <div className="form-stack">
            <Field label="训练集目录"><div className="actions"><Button disabled={busy} onClick={() => void choose('train')}><FolderOpen size={13} />选择目录</Button></div>
              <p className="muted tiny break-word">{trainDir || '未选择'}</p></Field>
            <Field label="验证集目录"><div className="actions"><Button disabled={busy} onClick={() => void choose('val')}><FolderOpen size={13} />选择目录</Button></div>
              <p className="muted tiny break-word">{valDir || '未选择'}</p></Field>
            <Field label="任务类型"><select aria-label="训练任务类型" disabled={busy} value={datasetTaskType}
              onChange={e => setDatasetTaskType(e.target.value as TaskType)}>
              {Object.entries(taskNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
            <Field label="类别名称" hint="目录内有 data.yaml 时可留空，由 data.yaml 的 names 决定；否则按序号每行填写一个。">
              <textarea aria-label="训练类别名称" rows={3} disabled={busy} value={classNames} onChange={e => setClassNames(e.target.value)} placeholder={'cat\ndog'} /></Field>
            <Notice>目录支持 images/labels 并列或直接混放；图片与同名标签必须一一对应，缺标签不会被当作无目标图。</Notice>
          </div>}
          {source === 'export' && <div className="form-stack">
            {!projectId && <Notice>请先在顶部打开一个项目，再选择 AI 标注导出版本。</Notice>}
            <Field label="已完成导出版本"><select aria-label="导出版本" disabled={busy || !projectId} value={exportId} onChange={e => setExportId(e.target.value)}>
              <option value="">请选择</option>
              {exports.map(item => <option key={item.id} value={item.id}>
                {new Date(item.createdAt).toLocaleString()} · {taskNames[item.taskType]} · {item.assetCount} 张{item.labelFormat ? ` · ${item.labelFormat}` : ''}</option>)}
            </select></Field>
            <div className="field-grid">
              <Field label="标注来源"><select aria-label="标注来源" disabled={busy} value={annotationSelection}
                onChange={e => setAnnotationSelection(e.target.value as 'protected' | 'candidate')}>
                <option value="protected">人工确认版本</option><option value="candidate">AI 候选版本</option></select></Field>
              <Field label="训练集比例"><input aria-label="训练集比例" type="number" min={0.05} max={0.95} step={0.05} disabled={busy}
                value={trainRatio} onChange={e => setTrainRatio(Number(e.target.value))} /></Field>
            </div>
            <Button disabled={busy || exportBusy || !projectId} busy={exportBusy} onClick={() => void exportCurrentProject()}>
              <FolderOpen size={14} />按当前项目标注生成导出版本</Button>
            <Notice>引用导出版本时会按固定清单逐文件校验哈希后复制，导出的图片不含叠加框线。</Notice>
          </div>}
          {source === 'version' && <div className="form-stack">
            {!projectId && <Notice>请先在顶部打开一个项目，再选择数据集版本。</Notice>}
            <Field label="数据集版本"><select aria-label="数据集版本" disabled={busy || !projectId} value={versionId} onChange={e => setVersionId(e.target.value)}>
              <option value="">请选择</option>
              {versions.map(item => <option key={item.id} value={item.id}>
                v{item.number}{item.name ? ` · ${item.name}` : ''} · {taskNames[item.taskType as TaskType]} · {item.summary?.images ?? '—'} 张
              </option>)}
            </select></Field>
            {!!projectId && !versions.length && <Notice>当前项目还没有就绪的数据集版本，可在项目入口中先生成一个版本。</Notice>}
            <Notice>版本内容不可变更：训练快照会按版本清单逐文件校验哈希后冻结，需要调整数据请重新生成版本。</Notice>
          </div>}
          {created && <DatasetReport dataset={created} />}
          <div className="modal-actions">
            <Button disabled={busy} onClick={onClose}>取消</Button>
            <Button className="primary" disabled={busy || (source === 'upload' ? !directoryReady : source === 'export' ? !exportId : !versionId)} busy={busy} onClick={() => void createDataset()}>
              创建数据集快照</Button>
            {ready && <Button onClick={() => setStep(2)}>下一步：训练参数</Button>}
          </div>
        </>}
        {step === 2 && created && <>
          <div className="training-parameters">
            <div className="form-stack">
              <div className="field-grid">
                <Field label="训练轮数"><input aria-label="训练轮数" type="number" min={TRAINING_LIMITS.epochs.min} max={TRAINING_LIMITS.epochs.max}
                  value={parameters.epochs ?? ''} onChange={e => patches({ epochs: Number(e.target.value) })} /></Field>
                <Field label="初始学习率"><input aria-label="初始学习率" type="number" min={TRAINING_LIMITS.learningRate.min} max={TRAINING_LIMITS.learningRate.max} step={1e-6}
                  value={parameters.learningRate ?? ''} onChange={e => patches({ learningRate: Number(e.target.value) })} /></Field>
                <Field label="批次大小"><input aria-label="批次大小" type="number" min={TRAINING_LIMITS.batch.min} max={TRAINING_LIMITS.batch.max}
                  value={typeof parameters.batch === 'number' ? parameters.batch : ''} onChange={e => patches({ batch: Number(e.target.value) })} /></Field>
                <Field label="输入尺寸"><input aria-label="输入尺寸" type="number" min={TRAINING_LIMITS.imgsz.min} max={TRAINING_LIMITS.imgsz.max} step={32}
                  value={parameters.imgsz ?? ''} onChange={e => patches({ imgsz: Number(e.target.value) })} /></Field>
              </div>
              <Field label="执行设备" hint="gpu-auto 会在启动前优先选择 GPU，不可用时回退 CPU 并如实记录。">
                <select aria-label="执行设备" value={parameters.device ?? 'gpu-auto'} onChange={e => patches({ device: e.target.value })}>
                  <option value="gpu-auto">自动（优先 GPU）</option><option value="cpu">CPU</option></select></Field>
              <details><summary>高级参数</summary><div className="form-stack">
                <div className="field-grid">
                  <Field label="优化器"><select aria-label="优化器" value={parameters.optimizer ?? 'auto'}
                    onChange={e => patches({ optimizer: e.target.value as TrainingParameters['optimizer'] })}>
                    {TRAINING_OPTIMIZERS.map(item => <option key={item} value={item}>{item}</option>)}</select></Field>
                  <Field label="早停轮数"><input aria-label="早停轮数" type="number" min={TRAINING_LIMITS.patience.min} max={TRAINING_LIMITS.patience.max}
                    value={parameters.patience ?? ''} onChange={e => patches({ patience: Number(e.target.value) })} /></Field>
                  <Field label="数据加载进程"><input aria-label="数据加载进程" type="number" min={TRAINING_LIMITS.workers.min} max={TRAINING_LIMITS.workers.max}
                    value={parameters.workers ?? ''} onChange={e => patches({ workers: Number(e.target.value) })} /></Field>
                  <Field label="随机种子"><input aria-label="随机种子" type="number" min={0} max={2147483647}
                    value={parameters.seed ?? ''} onChange={e => patches({ seed: Number(e.target.value) })} /></Field>
                </div>
                <label className="checkbox-row"><input type="checkbox" checked={!!parameters.cosLr} onChange={e => patches({ cosLr: e.target.checked })} />余弦学习率</label>
                <label className="checkbox-row"><input type="checkbox" checked={parameters.augment !== false} onChange={e => patches({ augment: e.target.checked })} />启用数据增强</label>
              </div></details>
            </div>
            <aside className="training-summary">
              <h3>生效参数摘要</h3>
              <p className="muted tiny">数据集：{taskNames[created.taskType]} · {created.classes.length} 类 · {created.inspection.summary.images} 张</p>
              <p className="muted tiny">轮数：{parameters.epochs ?? '-'} · 学习率：{parameters.learningRate ?? '-'} · 批次：{parameters.batch ?? '-'}</p>
              <p className="muted tiny">设备：{parameters.device ?? '-'}{preflight ? ` → 实际 ${preflight.resolvedParameters.actualDevice}` : ''}</p>
              <p className="muted tiny">基础权重：{parameters.baseModel ? parameters.baseModel.modelId : '从零开始训练'}</p>
              {!parameters.baseModel && <div className="issue"><AlertTriangle size={13} />从零训练在极小数据集上指标不可用。</div>}
              {preflight && <ul className="training-preflight-issues">
                {preflight.issues.map((issue, index) => <li key={index} className={issue.severity}>
                  {issue.severity === 'error' ? <AlertTriangle size={12} /> : <Check size={12} />}{issue.message}</li>)}
              </ul>}
              <div className="actions"><Button disabled={busy} onClick={() => void runPreflight()}>运行预检</Button></div>
            </aside>
          </div>
          <div className="modal-actions">
            <Button disabled={busy} onClick={() => setStep(1)}>上一步</Button>
            <Button onClick={() => void runPreflight()} disabled={busy}>运行预检</Button>
            <Button className="primary" disabled={busy || !ready || (preflight ? !preflight.ok : false)} busy={busy} onClick={() => void submit()}>
              提交训练</Button>
          </div>
        </>}
      </div>
      {error && <p className="inline-error">{error}</p>}
    </div>
  </Modal>;
}

function DatasetReport({ dataset }: { dataset: TrainingDataset }) {
  const issues = dataset.inspection.issues;
  return <div className="preflight">
    <h3>体检结果</h3>
    <p className="muted tiny">快照 {dataset.snapshotHash.slice(0, 16)}… · 状态：{dataset.status === 'ready' ? '可训练' : '存在阻断问题'}</p>
    {!issues.length && <div className="issue"><Check size={13} />未发现问题。</div>}
    {!!issues.length && <ul className="training-preflight-issues">{issues.slice(0, 12).map((issue, index) => <li key={index} className={issue.severity}>
      {issue.severity === 'error' ? <AlertTriangle size={12} /> : <Check size={12} />}
      {issue.message}{issue.file ? `（${issue.file}${issue.line ? ` 第 ${issue.line} 行` : ''}）` : ''}</li>)}
    </ul>}
  </div>;
}

/** 指标折线：只画引擎真实上报的点，界面不做平滑也不补点。 */
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

const ARTIFACT_NAMES: Record<string, string> = { best: 'best.pt（最优权重）', last: 'last.pt（最后一轮）', results: 'results.csv', args: 'args.yaml', log: 'train.log' };

function TrainingDetail({ jobId, live, onClose, onChanged }: {
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

function fmt(value?: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(4) : '—';
}

function formatBytes(bytes?: number) {
  if (!bytes || bytes < 1) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}
