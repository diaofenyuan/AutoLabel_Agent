import { useCallback, useEffect, useRef, useState } from 'react';
import { Database, Download, FolderOpen, Layers, MessageSquare, MoreHorizontal, RefreshCw, ShieldCheck, ClipboardCheck } from 'lucide-react';
import type { Annotation, Asset } from '../../shared/protocol';
import type { LibraryResource } from '../../shared/resources';
import { useApp } from './context';
import { DatasetVersionDialog, type DatasetVersion } from './DatasetVersions';
import type { ExportRecord } from './ExportDialog';
import AssetActions from './AssetActions';
import ExportDialog from './ExportDialog';
import ResourceApply from './ResourceApply';
import AssetAnnotator from './AssetAnnotator';
import { inspectVideoContinuity } from './videoContinuity';
import TemplateDialog from './TemplateDialog';
import TruthSets from './TruthSets';
import { errorMessage, isDemo, request } from './bridge';
import { confirmDialog } from './confirm';
import { Button, Empty, IconButton, Loading, Modal, PageHeader } from './ui';
import { statusNames, taskNames } from './types';
import { Term } from './Term';

/** 概览素材按需分页读取；完整选择 ID 通过 asset.listIds 分批拉取。 */
const PAGE_SIZE = 100;
const versionStatusNames: Record<string, string> = { draft: '草稿', building: '生成中', ready: '已生成', failed: '生成失败', cancelled: '已取消' };

/** 结果筛选：审核批量结果时先按状态把「要处理的」筛出来，再勾选一次确认。 */
type ResultFilter = 'all' | 'candidate' | 'empty' | 'failed' | 'confirmed' | 'unlabeled';
const filterNames: Record<ResultFilter, string> = { all: '全部', candidate: '有候选', empty: '无目标', failed: '失败', confirmed: '已确认', unlabeled: '未处理' };
const filterOrder: ResultFilter[] = ['all', 'candidate', 'empty', 'failed', 'confirmed', 'unlabeled'];
const filterHints: Record<ResultFilter, string> = {
  all: '项目中的全部素材（含人工修改中、异常等其它状态）',
  candidate: '模型给了候选结果、还没有人工确认的素材',
  empty: '模型成功返回但没有找到目标的素材：确认后记为已确认无目标',
  failed: '最近一次标注运行失败或结果未知、且还没有人工确认的素材，需要重跑或人工补标',
  confirmed: '已经人工确认的素材',
  unlabeled: '还没有任何标注结果的素材',
};

/**
 * 项目概览：一个项目的数据面（素材、数据集版本、导出记录）与只读抽查。
 * 这里不放任何编辑表单——标注修正、建版本、导出都在对话里发起；页面只聚合已经存在的结果。
 */
export default function ProjectOverview() {
  const { project, notify, navigate, openProject, selectedAssetIds, setSelectedAssetIds } = useApp();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [total, setTotal] = useState(0);
  const [filterCounts, setFilterCounts] = useState<Record<ResultFilter, number>>({ all: 0, candidate: 0, empty: 0, failed: 0, confirmed: 0, unlabeled: 0 });
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<Asset | null>(null);
  const [versions, setVersions] = useState<DatasetVersion[]>([]);
  const [exports, setExports] = useState<ExportRecord[]>([]);
  const [dialog, setDialog] = useState<'versions' | 'export' | 'resources' | 'template' | 'truth' | null>(null);
  const [actions, setActions] = useState<Asset | null>(null);
  /** 「将选中版本载入草稿」的落点：载入后直接打开这张图的画布，历史版本才有实际去处。 */
  const [loadInto, setLoadInto] = useState<{ assetId: string; annotations: Annotation[] } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);
  const [filter, setFilter] = useState<ResultFilter>('all');
  const requestSequence = useRef(0);

  /**
   * 接受候选并确认：勾选多张，一次把当前结果写成正式标注并确认。
   *
   * 逐张点开「编辑标注 → 保存并确认」在视频帧这种批量场景里不成立（23 帧就是 46 次点击），
   * 但确认的语义不能放宽：已经人工确认过的素材跳过，版本冲突或草稿在身的由引擎拒绝并计入跳过，
   * 不做任何静默覆盖；「无目标」的帧会明说，确认后记成已确认无目标。
   */
  async function confirmSelectedCandidates() {
    if (confirming || !project) return;
    setConfirming(true);
    let confirmed = 0;
    const skipped: string[] = [];
    try {
      const targets: Asset[] = [];
      for (let offset = 0; offset < selectedAssetIds.length; offset += 500) {
        const result = await request<{ items: Asset[] }>('asset.list', { projectId: project.id, assetIds: selectedAssetIds.slice(offset, offset + 500), limit: 500 });
        targets.push(...result.items);
      }
      const pending = targets.filter(asset => asset.status !== 'confirmed');
      if (!pending.length) { notify('选中的素材要么已经确认过，要么没有可确认的结果。', true); return; }
      const empty = pending.filter(asset => !asset.annotations.length).length;
      const warning = `将把选中的 ${pending.length} 张当前结果写成正式标注并确认${empty ? `，其中 ${empty} 张是「模型没有找到目标」，确认后记为已确认无目标` : ''}。`
        + '人工确认过的素材不会被改动；有未保存草稿或版本已变化的会跳过并单独报出。';
      if (!(await confirmDialog(warning))) return;
      for (const asset of pending) {
        try {
          const saved = await request<Asset>('annotation.save', { assetId: asset.id, baseVersion: asset.version, annotations: asset.annotations, confirm: true });
          setAssets(list => list.map(item => item.id === saved.id ? saved : item));
          confirmed++;
        } catch (e) { skipped.push(`${asset.name}：${errorMessage(e)}`); }
      }
      await loadAssets(0);
      notify(confirmed
        ? `已确认 ${confirmed} 张${skipped.length ? `；${skipped.length} 张跳过（${skipped.slice(0, 2).join('；')}${skipped.length > 2 ? ' 等' : ''}）` : ''}。`
        : `没有确认任何素材：${skipped.slice(0, 2).join('；')}`, !confirmed);
    } catch (e) {
      notify(`批量确认失败：${errorMessage(e)}`, true);
    } finally { setConfirming(false); }
  }

  const loadAssets = useCallback(async (offset: number) => {
    if (!project) return;
    const sequence = ++requestSequence.current;
    setLoading(true);
    try {
      const result = await request<{ items: Asset[]; total: number; filterCounts: Record<ResultFilter, number>; statusCounts: Record<string, number> }>('asset.list', { projectId: project.id, offset, limit: PAGE_SIZE, resultFilter: filter });
      if (sequence !== requestSequence.current) return;
      setAssets(current => offset ? [...current, ...result.items.filter(item => !current.some(existing => existing.id === item.id))] : result.items);
      setTotal(result.total); setFilterCounts(result.filterCounts); setStatusCounts(result.statusCounts); setError('');
    } catch (e) { if (sequence === requestSequence.current) setError(errorMessage(e)); }
    finally { if (sequence === requestSequence.current) setLoading(false); }
  }, [project?.id, filter]);
  useEffect(() => { setAssets([]); setTotal(0); void loadAssets(0); }, [loadAssets]);
  useEffect(() => {
    if (!project || isDemo) return;
    let live = true;
    void request<{ items: DatasetVersion[] }>('dataset.version.list', { projectId: project.id, limit: 100 })
      .then(result => { if (live) setVersions(result.items); }).catch(() => undefined);
    void request<ExportRecord[]>('export.list', { projectId: project.id })
      .then(list => { if (live) setExports(list); }).catch(() => undefined);
    return () => { live = false; };
  }, [project?.id]);

  if (!project) return <div className="content"><Empty icon={<FolderOpen size={28} />} title="还没有打开项目"
    description="从对话开始描述要标注什么，助手会建好项目；也可以直接打开侧栏里的项目。">
    <Button onClick={() => void navigate('chat')}><MessageSquare size={14} />去对话</Button></Empty></div>;

  /**
   * 勾选是「这次要让助手处理哪些素材」的唯一入口：工作台退场后，对话里的「已勾选（跨页）」
   * 只能靠这里填充。改成未按住多选 keys，保持逐个点选足够。
   */
  function toggleAsset(id: string) {
    setSelectedAssetIds(list => list.includes(id) ? list.filter(item => item !== id) : [...list, id]);
  }
  /** 全选拉取服务端完整筛选 ID，选择跨页累积且不覆盖既有选择。 */
  async function selectFiltered() {
    if (!project || selectingAll || !filterCounts[filter]) return;
    setSelectingAll(true);
    try {
      const ids: string[] = [];
      for (let offset = 0; offset < filterCounts[filter]; offset += 500) {
        const page = await request<{ ids: string[] }>('asset.listIds', { projectId: project.id, resultFilter: filter, offset, limit: 500 });
        ids.push(...page.ids);
      }
      setSelectedAssetIds(list => [...new Set([...list, ...ids])]);
    } catch (e) { notify(errorMessage(e), true); }
    finally { setSelectingAll(false); }
  }
  const selectedCount = selectedAssetIds.length;

  const visible = assets;
  // 视频帧按来源组聚合：同一段视频抽出的帧同属一个来源组，逐帧之外还要能整组看待。
  const frameGroups = new Map<string, Asset[]>();
  for (const asset of assets) {
    const meta = asset.metadata ?? {};
    const group = String(meta.groupId ?? meta.sourceVideoId ?? meta.mediaJobId ?? '');
    if (!group) continue;
    const list = frameGroups.get(group) ?? [];
    list.push(asset);
    frameGroups.set(group, list);
  }
  const continuityIssues = new Map<string, ReturnType<typeof inspectVideoContinuity>>();
  if (filter === 'all') {
    for (const list of frameGroups.values()) {
      for (const issue of inspectVideoContinuity(list)) {
        const existing = continuityIssues.get(issue.assetId) ?? [];
        existing.push(issue);
        continuityIssues.set(issue.assetId, existing);
      }
    }
  }

  const distribution = project.classes.map(label => ({ ...label,
    count: assets.reduce((sum, asset) => sum + asset.annotations.filter(annotation => annotation.classId === label.id).length, 0) })).filter(item => item.count > 0);
  const finishedExports = exports.filter(item => item.status === 'completed');

  return <div className="content overview-page">
    <PageHeader title={`项目概览 · ${project.name}`} description={`${taskNames[project.taskType]} · ${project.classes.length} 个类别 · 建自 ${new Date(project.createdAt).toLocaleDateString('zh-CN')}`}
      actions={<><Button onClick={() => void openProject(project)}><MessageSquare size={14} />进入对话</Button>
        <Button onClick={() => setDialog('template')}><ShieldCheck size={14} />类别与点位模板</Button>
        <Button onClick={() => setDialog('resources')}><FolderOpen size={14} />资源</Button>
        <Button onClick={() => setDialog('versions')}><Layers size={14} />数据集版本</Button>
        {/* 标准答案集的人工答案与固定版本入口：界面重构移除旧页面后，它一直没有新落点，评测因此没法为新项目建真值。 */}
        <Button onClick={() => setDialog('truth')}><ClipboardCheck size={14} />标准答案集</Button>
        <Button className="primary" disabled={isDemo} onClick={() => setDialog('export')}><Download size={14} />导出</Button></>} />
    {error && <p role="alert" className="inline-error">{error}</p>}

    <section className="overview-grid">
      <article className="overview-card">
        <h2><Database size={15} />素材</h2>
        <p className="overview-figure">{project.assetCount}<small>张</small></p>
        <p className="muted tiny">已标注 {project.annotatedCount} · 已确认 {project.confirmedCount}</p>
        <dl className="overview-facts">{Object.entries(statusCounts).filter(([, count]) => count > 0).map(([status, count]) =>
          <div key={status}><dt>{statusNames[status] ?? status}</dt><dd>{count}</dd></div>)}
          {!Object.values(statusCounts).some(count => count > 0) && <div><dt>还没有素材</dt><dd>0</dd></div>}</dl>
      </article>
      <article className="overview-card">
        <h2><Layers size={15} /><Term name="datasetVersion">数据集版本</Term></h2>
        <p className="overview-figure">{versions.length}<small>个</small></p>
        <p className="muted tiny">版本不可变，训练与导出都从这里取数据。</p>
        <ul className="overview-list">{versions.slice(0, 3).map(version => <li key={version.id}>
          <strong>{version.name || `版本 ${version.number}`}</strong>
          <span>{versionStatusNames[version.status] ?? version.status}
            {version.summary?.images !== undefined ? ` · ${version.summary.images} 张` : ''}
            {version.summary?.objects !== undefined ? ` · ${version.summary.objects} 个目标` : ''}</span>
        </li>)}{!versions.length && <li className="muted tiny">还没有数据集版本。</li>}</ul>
      </article>
      <article className="overview-card">
        <h2><Download size={15} />导出</h2>
        <p className="overview-figure">{finishedExports.length}<small>次已完成</small></p>
        <p className="muted tiny">导出记录保留清单标识，可复现比较。</p>
        <ul className="overview-list">{exports.slice(0, 3).map(record => <li key={record.id}>
          <strong>{record.taskType} · {record.assetCount ?? '?'} 张</strong>
          <span>{record.createdAt ? new Date(record.createdAt).toLocaleString('zh-CN') : '时间未记录'}{record.manifestHash ? ' · 有清单' : ''}</span>
        </li>)}{!exports.length && <li className="muted tiny">还没有导出记录。</li>}</ul>
      </article>
    </section>

    <section className="result-card">
      <div className="result-card-head">
        <div>
          <h3>只读抽查</h3>
          <p className="muted tiny">当前筛选已加载 {assets.length} / {total} 张 · 项目共 {filterCounts.all} 张。勾选想要的素材，再去对话里让助手只处理这些；点开图片可以查看框与类别，也可以直接人工编辑标注。</p>
        </div>
        <div className="actions"><Button busy={loading} disabled={loading} onClick={() => void loadAssets(0)}><RefreshCw size={14} />刷新</Button></div>
      </div>
      {distribution.length > 0 && <div className="result-stats"><span className="muted tiny">已加载页标注数</span>{distribution.map(item => <span key={item.id}><i style={{ background: item.color }} />{item.name} <strong>{item.count}</strong></span>)}</div>}
      {filterCounts.all > 0 && <div className="result-filters" role="group" aria-label="结果筛选">
        {filterOrder.map(key => <button key={key} type="button" className="result-filter" data-result-filter={key} aria-pressed={filter === key}
          title={filterHints[key]} onClick={() => setFilter(key)}>{filterNames[key]} <strong>{filterCounts[key]}</strong></button>)}
      </div>}
      {frameGroups.size > 0 && <div className="result-groups" role="note" aria-label="视频帧来源组小结">
        <p>连续性检查只覆盖当前已加载的同组帧；需要检查完整视频时，请切换到「全部」并加载完整帧组。</p>
        {[...frameGroups].map(([group, list]) => <p key={group} data-result-group={group.slice(0, 8)}>来源组 {group.slice(0, 8)} · {list.length} 帧 ·
          {filter === 'all' ? `连续性需复核 ${list.filter(item => (continuityIssues.get(item.id)?.length ?? 0) > 0).length}` : '连续性提示请切换「全部」查看'} ·
          {(['candidate', 'empty', 'failed', 'confirmed', 'unlabeled'] as const).map(key => `${filterNames[key]} ${list.filter(item => item.resultState === key).length}`).join(' · ')}</p>)}
      </div>}
      {loading && !assets.length ? <Loading label="正在读取素材…" />
        : filterCounts.all > 0 ? <>
          <div className="asset-selection" role="region" aria-label="素材选择">
            <span className="asset-selection-count">{selectedCount ? `已选 ${selectedCount} 张` : '未选中素材'} · 筛选「{filterNames[filter]}」共 {total} 张</span>
            <div className="actions">
              <Button busy={selectingAll} disabled={!filterCounts[filter] || selectingAll || loading} onClick={() => void selectFiltered()}>{filter === 'all' ? `全选项目素材（${filterCounts.all}）` : `全选筛选结果（${filterCounts[filter]}）`}</Button>
              <Button disabled={!selectedCount} onClick={() => setSelectedAssetIds([])}>清空选择</Button>
              {/* 批量确认：视频帧这类批量场景不用再逐张点开确认；语义与单张「保存并确认」一致。 */}
              <Button busy={confirming} disabled={!selectedCount || confirming} onClick={() => void confirmSelectedCandidates()}>接受候选并确认</Button>
              {/* 勾完之后下一步就是到对话里说要标什么，直接把人送到那里，并在提示里说明范围该怎么选。 */}
              <Button className="primary" disabled={!selectedCount} onClick={() => void openProject(project)
                .then(() => notify('已进入对话：把助手处理范围改成「已勾选（跨页）」，再说明要标注的目标。'))
                .catch(e => notify(errorMessage(e), true))}><MessageSquare size={14} />在对话里处理这些素材</Button>
            </div>
          </div>
          {visible.length
            ? <div className="result-grid">{visible.map(asset => <div className={`result-thumb-wrap ${selectedAssetIds.includes(asset.id) ? 'selected' : ''}`} key={asset.id}>
            <button className="result-thumb" title={`${asset.name} · ${statusNames[asset.status] ?? asset.status}`} onClick={() => setPreview(asset)}>
              <img loading="lazy" src={`autolabel-media://thumb/${asset.id}`} alt={asset.name} />
              <span className="truncate">{asset.name}</span>
              <small>{statusNames[asset.status] ?? asset.status} · {asset.annotations.length} 个
                {Boolean(asset.metadata?.requiresGeometryReview) && <span className="text-error"> · 需几何复核</span>}
                {continuityIssues.has(asset.id) && <span className="text-error"> · 连续性需复核</span>}
              </small>
            </button>
            {/* 勾选放在缩略图内部左侧，冒泡到外层 card 之上，点它不会误开预览。 */}
            <label className="result-thumb-check" aria-label={`选择 ${asset.name}`} onClick={event => event.stopPropagation()}>
              <input type="checkbox" checked={selectedAssetIds.includes(asset.id)} onChange={() => toggleAsset(asset.id)} />
            </label>
            {/* 版本记录、标签导入、效果图与文件位置这些命令不属于画布编辑，留在素材上，工作台退场后仍有入口。 */}
            <IconButton label={`${asset.name} 的素材与标注操作`} className="result-thumb-more" onClick={() => setActions(asset)}><MoreHorizontal size={14} /></IconButton>
          </div>)}</div>
            : <p className="quiet-empty">当前筛选「{filterNames[filter]}」没有素材。<Button onClick={() => setFilter('all')}>看全部</Button></p>}</>
        : <p className="quiet-empty">这个项目还没有素材，先在对话里说明要导入什么。</p>}
      {assets.length < total && <Button busy={loading} disabled={loading} onClick={() => void loadAssets(assets.length)}>加载更多（还有 {total - assets.length} 张）</Button>}
    </section>

    {preview && <Modal wide title={`素材 · ${preview.name}`} onClose={() => { setPreview(null); setLoadInto(null); }}>
      {/* 预览与人工画布同一个弹窗：默认只读，点「编辑标注」才切到可写画布。 */}
      <AssetAnnotator asset={preview} classes={project.classes} taskType={project.taskType} templateSettings={project.settings}
        connectionTemplate={project.settings?.keypointConnections as string[] | undefined} maxHeight="60vh"
        continuityIssues={continuityIssues.get(preview.id) ?? []}
        initialAnnotations={loadInto?.assetId === preview.id ? loadInto.annotations : undefined}
        onClose={() => { setPreview(null); setLoadInto(null); }}
        onSaved={updated => { setAssets(list => list.map(item => item.id === updated.id ? updated : item)); void loadAssets(0); }} />
    </Modal>}
    {dialog === 'truth' && <TruthSets onClose={() => setDialog(null)} />}
    {dialog === 'versions' && <DatasetVersionDialog project={project} onClose={() => setDialog(null)}
      onOpenTemplate={() => setDialog('template')}
      onOpenExport={() => setDialog('export')}
      onOpenChat={() => { setDialog(null); void openProject(project).catch(e => notify(errorMessage(e), true)); }} />}
    {dialog === 'export' && <ExportDialog onClose={() => setDialog(null)} onOpenTemplate={() => setDialog('template')} />}
    {dialog === 'template' && <TemplateDialog onClose={() => setDialog(null)} />}
    {dialog === 'resources' && <ResourceHub onClose={() => setDialog(null)} />}
    {actions && <AssetActions asset={actions} onClose={() => setActions(null)}
      onApplied={updated => { setAssets(list => list.map(item => item.id === updated.id ? updated : item)); setActions(updated); void loadAssets(0); }}
      onUseVersion={annotations => { const target = actions; setActions(null); setLoadInto({ assetId: target.id, annotations }); setPreview(target); }} />}
  </div>;
}

const resourceKindNames: Record<string, string> = { prompt: '提示词', template: '模板', flow: '流程', reference: '人工参考', evaluation_comparison: '评测比较' };

/** 资源入口：读已保存的提示词、模板与流程资源，应用到当前项目；新建人工参考走对话里的引用面板。 */
function ResourceHub({ onClose }: { onClose: () => void }) {
  const { project } = useApp();
  const [kind, setKind] = useState('prompt');
  const [items, setItems] = useState<LibraryResource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [applying, setApplying] = useState<LibraryResource | null>(null);
  useEffect(() => {
    let live = true; setLoading(true); setError('');
    void request<LibraryResource[]>('resource.list', { kind, query: '', offset: 0, limit: 500 })
      .then(list => { if (live) setItems(list); }).catch(e => { if (live) setError(errorMessage(e)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [kind]);
  return <Modal wide title="资源" onClose={onClose}>
    <div className="form-stack">
      <div className="tabs">{Object.entries(resourceKindNames).map(([key, label]) =>
        <button key={key} className={kind === key ? 'selected' : ''} onClick={() => setKind(key)}>{label}</button>)}</div>
      <p className="muted tiny">资源是独立于项目的固定版本；应用到项目只覆盖你勾选的字段。新建人工参考请在对话的引用面板里完成。</p>
      {error && <p role="alert" className="inline-error">{error}</p>}
      {loading ? <Loading label="正在读取资源…" /> : items.length ? <div className="board-list">{items.map(item => <article key={item.id} className="board-row">
        <div className="board-main"><strong>{item.name}</strong><span className="muted tiny">版本 {item.version} · 更新 {new Date(item.updatedAt).toLocaleString('zh-CN')}{item.category ? ` · ${item.category}` : ''}</span></div>
        {project && item.kind !== 'reference'
          ? <Button onClick={() => setApplying(item)}>应用到本项目</Button>
          : <span className="muted tiny">在对话里引用</span>}
      </article>)}</div> : <p className="quiet-empty">这一类还没有资源。</p>}
    </div>
    {applying && <ResourceApply resource={applying} onClose={() => setApplying(null)} />}
  </Modal>;
}
