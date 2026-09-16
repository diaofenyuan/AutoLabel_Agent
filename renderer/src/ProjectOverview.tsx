import { useCallback, useEffect, useState } from 'react';
import { Database, Download, FolderOpen, Layers, MessageSquare, MoreHorizontal, RefreshCw, ShieldCheck } from 'lucide-react';
import type { Asset } from '../../shared/protocol';
import type { LibraryResource } from '../../shared/resources';
import { useApp } from './context';
import { DatasetVersionDialog, type DatasetVersion } from './DatasetVersions';
import type { ExportRecord } from './ExportDialog';
import AssetActions from './AssetActions';
import ExportDialog from './ExportDialog';
import ResourceApply from './ResourceApply';
import ResultViewer from './ResultViewer';
import TemplateDialog from './TemplateDialog';
import { errorMessage, isDemo, request } from './bridge';
import { Button, Empty, IconButton, Loading, Modal, PageHeader } from './ui';
import { statusNames, taskNames } from './types';

/** 素材分页与结果卡片共用同一上限：asset.list 的 limit 最大 100。 */
const PAGE_SIZE = 100;
const versionStatusNames: Record<string, string> = { draft: '草稿', building: '生成中', ready: '已生成', failed: '生成失败', cancelled: '已取消' };

/**
 * 项目概览：一个项目的数据面（素材、数据集版本、导出记录）与只读抽查。
 * 这里不放任何编辑表单——标注修正、建版本、导出都在对话里发起；页面只聚合已经存在的结果。
 */
export default function ProjectOverview() {
  const { project, notify, navigate, assetTotal, openProject, selectedAssetIds, setSelectedAssetIds } = useApp();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<Asset | null>(null);
  const [versions, setVersions] = useState<DatasetVersion[]>([]);
  const [exports, setExports] = useState<ExportRecord[]>([]);
  const [dialog, setDialog] = useState<'versions' | 'export' | 'resources' | 'template' | null>(null);
  const [actions, setActions] = useState<Asset | null>(null);

  const loadAssets = useCallback(async (offset: number) => {
    if (!project) return;
    setLoading(true);
    try {
      const result = await request<{ items: Asset[]; total: number }>('asset.list', { projectId: project.id, offset, limit: PAGE_SIZE });
      setAssets(current => offset ? [...current, ...result.items.filter(item => !current.some(existing => existing.id === item.id))] : result.items);
      setTotal(result.total); setError('');
    } catch (e) { setError(errorMessage(e)); }
    finally { setLoading(false); }
  }, [project?.id]);
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
  /** 全选只合并当前已加载的素材，不清掉之前跨页选中的那些。 */
  function selectLoaded() {
    setSelectedAssetIds(list => [...new Set([...list, ...assets.map(item => item.id)])]);
  }
  const selectedCount = selectedAssetIds.length;

  const distribution = project.classes.map(label => ({ ...label,
    count: assets.reduce((sum, asset) => sum + asset.annotations.filter(annotation => annotation.classId === label.id).length, 0) })).filter(item => item.count > 0);
  const statusCounts = assets.reduce<Record<string, number>>((counts, asset) => ({ ...counts, [asset.status]: (counts[asset.status] ?? 0) + 1 }), {});
  const finishedExports = exports.filter(item => item.status === 'completed');

  return <div className="content overview-page">
    <PageHeader title={`项目概览 · ${project.name}`} description={`${taskNames[project.taskType]} · ${project.classes.length} 个类别 · 建自 ${new Date(project.createdAt).toLocaleDateString('zh-CN')}`}
      actions={<><Button onClick={() => void openProject(project)}><MessageSquare size={14} />进入对话</Button>
        <Button onClick={() => setDialog('template')}><ShieldCheck size={14} />类别与点位模板</Button>
        <Button onClick={() => setDialog('resources')}><FolderOpen size={14} />资源</Button>
        <Button onClick={() => setDialog('versions')}><Layers size={14} />数据集版本</Button>
        <Button className="primary" disabled={isDemo} onClick={() => setDialog('export')}><Download size={14} />导出</Button></>} />
    {error && <p role="alert" className="inline-error">{error}</p>}

    <section className="overview-grid">
      <article className="overview-card">
        <h2><Database size={15} />素材</h2>
        <p className="overview-figure">{project.assetCount}<small>张</small></p>
        <p className="muted tiny">已标注 {project.annotatedCount} · 已确认 {project.confirmedCount}</p>
        <dl className="overview-facts">{Object.entries(statusCounts).map(([status, count]) =>
          <div key={status}><dt>{statusNames[status] ?? status}</dt><dd>{count}</dd></div>)}
          {!Object.keys(statusCounts).length && <div><dt>还没有素材</dt><dd>0</dd></div>}</dl>
      </article>
      <article className="overview-card">
        <h2><Layers size={15} />数据集版本</h2>
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
          <p className="muted tiny">已加载 {assets.length} / 共 {assetTotal || total} 张 · 勾选想要的素材，再去对话里让助手只处理这些；点开图片可以看到框与类别，修改请在对话里说明。</p>
        </div>
        <div className="actions"><Button busy={loading} disabled={loading} onClick={() => void loadAssets(0)}><RefreshCw size={14} />刷新</Button></div>
      </div>
      {distribution.length > 0 && <div className="result-stats">{distribution.map(item => <span key={item.id}><i style={{ background: item.color }} />{item.name} <strong>{item.count}</strong></span>)}</div>}
      {loading && !assets.length ? <Loading label="正在读取素材…" />
        : assets.length ? <>
          <div className="asset-selection" role="region" aria-label="素材选择">
            <span className="asset-selection-count">{selectedCount ? `已选 ${selectedCount} 张` : '未选中素材'}</span>
            <div className="actions">
              <Button disabled={!loading && !assets.length} onClick={selectLoaded}>全选已加载</Button>
              <Button disabled={!selectedCount} onClick={() => setSelectedAssetIds([])}>清空选择</Button>
              {/* 勾完之后下一步就是到对话里说要标什么，直接把人送到那里，并在提示里说明范围该怎么选。 */}
              <Button className="primary" disabled={!selectedCount} onClick={() => void openProject(project)
                .then(() => notify('已进入对话：把助手处理范围改成「已勾选（跨页）」，再说明要标注的目标。'))
                .catch(e => notify(errorMessage(e), true))}><MessageSquare size={14} />在对话里处理这些素材</Button>
            </div>
          </div>
          <div className="result-grid">{assets.map(asset => <div className={`result-thumb-wrap ${selectedAssetIds.includes(asset.id) ? 'selected' : ''}`} key={asset.id}>
            <button className="result-thumb" title={`${asset.name} · ${statusNames[asset.status] ?? asset.status}`} onClick={() => setPreview(asset)}>
              <img loading="lazy" src={asset.thumbnailUrl || asset.mediaUrl} alt={asset.name} />
              <span className="truncate">{asset.name}</span>
              <small>{statusNames[asset.status] ?? asset.status} · {asset.annotations.length} 个</small>
            </button>
            {/* 勾选放在缩略图内部左侧，冒泡到外层 card 之上，点它不会误开预览。 */}
            <label className="result-thumb-check" aria-label={`选择 ${asset.name}`} onClick={event => event.stopPropagation()}>
              <input type="checkbox" checked={selectedAssetIds.includes(asset.id)} onChange={() => toggleAsset(asset.id)} />
            </label>
            {/* 版本记录、标签导入、效果图与文件位置这些命令不属于画布编辑，留在素材上，工作台退场后仍有入口。 */}
            <IconButton label={`${asset.name} 的素材与标注操作`} className="result-thumb-more" onClick={() => setActions(asset)}><MoreHorizontal size={14} /></IconButton>
          </div>)}</div></>
        : <p className="quiet-empty">这个项目还没有素材，先在对话里说明要导入什么。</p>}
      {assets.length < (assetTotal || total) && <Button busy={loading} onClick={() => void loadAssets(assets.length)}>加载更多（还有 {(assetTotal || total) - assets.length} 张）</Button>}
    </section>

    {preview && <Modal wide title={`抽查 · ${preview.name}`} onClose={() => setPreview(null)}>
      <ResultViewer asset={preview} classes={project.classes} connectionTemplate={project.settings?.keypointConnections as string[] | undefined} maxHeight="60vh" />
      <p className="muted tiny">只读预览。要改标注就在对话里说明，例如「把第 2 张图的第二个框改成行人」。</p>
    </Modal>}
    {dialog === 'versions' && <DatasetVersionDialog project={project} onClose={() => setDialog(null)}
      onOpenTemplate={() => setDialog('template')}
      onOpenExport={() => setDialog('export')}
      onOpenChat={() => { setDialog(null); void openProject(project).catch(e => notify(errorMessage(e), true)); }} />}
    {dialog === 'export' && <ExportDialog onClose={() => setDialog(null)} onOpenTemplate={() => setDialog('template')} />}
    {dialog === 'template' && <TemplateDialog onClose={() => setDialog(null)} />}
    {dialog === 'resources' && <ResourceHub onClose={() => setDialog(null)} />}
    {actions && <AssetActions asset={actions} onClose={() => setActions(null)}
      onApplied={updated => { setAssets(list => list.map(item => item.id === updated.id ? updated : item)); setActions(updated); }}
      onUseVersion={() => { setActions(null); notify('历史版本可以载入草稿，但没有画布可编辑；请在对话里说明要改成什么。'); }} />}
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
