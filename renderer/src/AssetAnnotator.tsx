import { useEffect, useState } from 'react';
import { Eye, PencilLine } from 'lucide-react';
import type { Asset, Annotation, LabelClass, Project, TaskType } from './types';
import { errorMessage, request } from './bridge';
import { confirmDialog } from './confirm';
import { useApp } from './context';
import { Button, Loading, Notice } from './ui';
import QualityCanvas from './QualityCanvas';
import ResultViewer from './ResultViewer';
import { readRegion, type AnnotationRegion } from './DirectRun';
import { annotationAttributeIssues } from './templateAttributes';
import type { VideoContinuityIssue } from './videoContinuity';

/** 候选框的几何问题留在人工复核入口展示，避免用户只看到框却漏掉风险原因。 */
function CandidateGeometryReview({ asset }: { asset: Asset }) {
  if (asset.status !== 'candidate' || asset.metadata?.requiresGeometryReview !== true) return null;
  const values = asset.metadata.geometryIssues;
  const issues = Array.isArray(values)
    ? values.filter((value): value is { message: string } => Boolean(value) && typeof value === 'object'
      && typeof (value as { message?: unknown }).message === 'string')
    : [];
  const visible = issues.slice(0, 5);
  return <section className="candidate-geometry-review" aria-label="候选框几何复核">
    <Notice>这是模型候选框，需要人工核对目标边界；系统没有自动裁剪或修补框。</Notice>
    {visible.length > 0 && <ul>{visible.map((issue, index) => <li key={index}>{issue.message}</li>)}</ul>}
    {issues.length > visible.length && <p className="muted tiny">另有 {issues.length - visible.length} 条复核提示，可在任务结果详情中查看。</p>}
  </section>;
}

function VideoContinuityReview({ issues }: { issues: VideoContinuityIssue[] }) {
  if (!issues.length) return null;
  return <section className="candidate-geometry-review" aria-label="视频帧连续性复核">
    <Notice>系统发现同一视频的相邻已加载帧可能存在连续性异常；以下内容只作人工复核提示，不会改动候选框或确认状态。</Notice>
    <ul>{issues.map(issue => <li key={issue.code}>{issue.message}</li>)}</ul>
  </section>;
}

/**
 * 素材标注编辑器：把画布接到真实的 `annotation.save` 上。
 * 默认停在只读预览，点「编辑标注」才进画布，避免用户误触就把正式标注改掉。
 *
 * 打开即以 `asset.get` 的结果为准，而不是列表里的快照：助手可能刚给这张图写过标注，
 * 用落后一版的 `baseVersion` 保存会直接被引擎拒绝，用户也会看不到真实内容。
 *
 * 保存走乐观锁，冲突时不静默重试覆盖——覆盖等于丢别人的结果；改为载入最新版本并提示核对，
 * 把决定权交回人。
 */
export default function AssetAnnotator({ asset, classes, taskType, templateSettings, connectionTemplate, maxHeight, initialAnnotations, continuityIssues = [], onClose, onSaved }: {
  asset: Asset; classes: LabelClass[]; taskType: TaskType; templateSettings?: Record<string, unknown>;
  connectionTemplate?: unknown; maxHeight?: string; initialAnnotations?: Annotation[]; continuityIssues?: VideoContinuityIssue[];
  onClose: () => void; onSaved: (asset: Asset) => void;
}) {
  const { notify, syncWindowDirtySource, project, setProject } = useApp();
  const [mode, setMode] = useState<'view' | 'edit'>(initialAnnotations ? 'edit' : 'view');
  // 只标注区域存在项目设置里：它属于「这个项目要标哪一块」，不是某一张素材的属性。
  const [region, setRegion] = useState<AnnotationRegion | null>(() => readRegion(project?.settings?.annotationRegion));
  const [regionBusy, setRegionBusy] = useState(false);
  const [current, setCurrent] = useState(asset);
  const [annotations, setAnnotations] = useState<Annotation[]>(() => structuredClone(initialAnnotations ?? asset.draft ?? asset.annotations));
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  // 带初始标注进来（历史版本载入）时就是脏的：没保存之前不能当成已落库的结果。
  const [dirty, setDirty] = useState(Boolean(initialAnnotations));
  const [error, setError] = useState('');
  const dirtySource = 'asset-annotate:' + asset.id;
  const unsaved = dirty || pending;
  // 未保存时阻止关窗：草稿不在引擎里，关掉就真丢了。
  useEffect(() => { syncWindowDirtySource(dirtySource, unsaved); return () => syncWindowDirtySource(dirtySource, false); }, [unsaved, dirtySource, syncWindowDirtySource]);
  useEffect(() => { setMode(initialAnnotations ? 'edit' : 'view'); }, [asset.id]);
  useEffect(() => {
    // 历史版本载入由调用方核对过版本，直接用它的内容，不再取一次。
    if (initialAnnotations) return;
    let live = true; setLoading(true);
    void request<Asset>('asset.get', { assetId: asset.id }).then(fresh => {
      if (!live) return;
      setCurrent(fresh); setAnnotations(structuredClone(fresh.draft ?? fresh.annotations)); setDirty(false); onSaved(fresh);
    }).catch(e => { if (live) setError(errorMessage(e)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [asset.id]);

  const hasClasses = classes.length > 0;

  function change(next: Annotation[]) { setAnnotations(next); setDirty(true); setError(''); }

  async function save(confirm: boolean) {
    if (busy || pending || !dirty) return;
    const issues = annotationAttributeIssues(annotations, templateSettings?.attributes);
    if (issues.length) { setError(issues.join('；')); return; }
    setBusy(true); setError('');
    try {
      // confirm 决定这次写入是「人工修改」还是「已确认」，沿用候选 → 正式标注的既有语义，不新造状态。
      const saved = await request<Asset>('annotation.save', { assetId: current.id, baseVersion: current.version, annotations, confirm });
      setCurrent(saved); setAnnotations(structuredClone(saved.annotations)); setDirty(false); onSaved(saved);
      notify(confirm ? `已保存并确认，版本 ${saved.version}。` : `已保存为版本 ${saved.version}。`);
    } catch (e) {
      const message = errorMessage(e);
      if (message.includes('annotation_version_conflict') || message.includes('标注版本已变化')) {
        try {
          const fresh = await request<Asset>('asset.get', { assetId: current.id });
          setCurrent(fresh); setAnnotations(structuredClone(fresh.draft ?? fresh.annotations)); setDirty(false); onSaved(fresh);
          setError('这张素材的标注已被改动（可能是助手刚写入的结果），已载入最新版本，请核对后重新编辑。');
        } catch (inner) { setError(errorMessage(inner)); }
      } else setError(message);
    } finally { setBusy(false); }
  }

  /**
   * 保存「只标注区域」：写进项目设置，下一次云端标注会带着它发送（引擎按比例裁剪并把坐标换算回整图）。
   * 区域改动不影响任何已保存的标注，也不会动别人正在跑的运行。
   */
  async function saveRegion(next: AnnotationRegion | null) {
    if (!project || regionBusy) return;
    setRegionBusy(true); setError('');
    try {
      const settings = { ...project.settings, annotationRegion: next ?? null };
      const updated = await request<Project>('project.update', { projectId: project.id, settings });
      setProject(updated); setRegion(next);
      notify(next ? '已设为「只标注这块区域」，之后的云端标注会按它裁剪后发送。' : '已清除标注区域，恢复整图标注。');
    } catch (e) { setError(errorMessage(e)); } finally { setRegionBusy(false); }
  }

  async function close() {
    if (busy) return;
    if (unsaved && !(await confirmDialog('还有未保存的标注改动，确定放弃并关闭？'))) return;
    onClose();
  }

  if (mode === 'view') return <div className="asset-annotator">
    {loading ? <Loading label="正在读取最新标注…" /> : <><CandidateGeometryReview asset={current}/><VideoContinuityReview issues={continuityIssues}/><ResultViewer asset={current} classes={classes} connectionTemplate={connectionTemplate} maxHeight={maxHeight} /></>}
    <p className="muted tiny">只读预览。要改标注就点下面的「编辑标注」直接改，也可以在对话里说明，例如「把第 2 个框改成行人」。</p>
    {error && <p role="alert" className="inline-error">{error}</p>}
    <div className="modal-actions">
      <Button onClick={close}>关闭</Button>
      <Button className="primary" disabled={!hasClasses || loading} title={hasClasses ? undefined : '项目还没有类别'} onClick={() => setMode('edit')}><PencilLine size={14} />编辑标注</Button>
    </div>
    {!hasClasses && <Notice>项目还没有类别。先到「类别与点位模板」添加类别，才能人工画框。</Notice>}
  </div>;

  return <div className="asset-annotator">
    <div className="asset-annotator-bar">
      <span className="muted tiny">{current.name} · 当前版本 {current.version} · {current.annotations.length} 个对象{dirty ? ' · 有未保存改动' : ''}</span>
      <Button disabled={busy} onClick={async () => { if (dirty && !(await confirmDialog('有未保存的改动，确定返回预览？'))) return; setDirty(false); setAnnotations(structuredClone(current.annotations)); setMode('view'); }}><Eye size={14} />返回预览</Button>
    </div>
    <CandidateGeometryReview asset={current}/>
    <VideoContinuityReview issues={continuityIssues}/>
    <QualityCanvas mediaUrl={current.mediaUrl ?? ''} width={current.width} height={current.height} annotations={annotations}
      classes={classes} taskType={taskType} purpose="asset" keypointNames={templateSettings?.keypointNames as string[] | undefined}
      keypointConnections={templateSettings?.keypointConnections} templateSettings={templateSettings}
      title="人工标注" disabled={busy} imageAlt={`${current.name} 的人工标注画布`}
      region={region} onRegionChange={project ? next => void saveRegion(next) : undefined}
      onPendingChange={setPending} onChange={change} />
    <Notice>保存会把这批结果写成这张素材的正式标注并计入「已标注」；保存不等于确认，核对完再点「保存并确认」。</Notice>
    {error && <p role="alert" className="inline-error">{error}</p>}
    <div className="modal-actions">
      <Button disabled={busy} onClick={close}>关闭</Button>
      <Button disabled={busy || !dirty} busy={busy} onClick={() => void save(false)}>保存</Button>
      <Button className="primary" disabled={busy || !dirty} busy={busy} onClick={() => void save(true)}>保存并确认</Button>
    </div>
  </div>;
}
