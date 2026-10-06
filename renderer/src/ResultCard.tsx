import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Download, Eye, PencilLine } from 'lucide-react';
import { useApp } from './context';
import { request, errorMessage, isDemo } from './bridge';
import { thumbnailUrlForAsset } from './thumbnailUrl';
import AssetThumbnail from './AssetThumbnail';
import { Button, Modal } from './ui';
import ExportDialog from './ExportDialog';
import AssetAnnotator from './AssetAnnotator';
import { statusNames, type Asset, type Project } from './types';

/** asset.list 的 limit 上限就是 100；超过一页用 total 翻页，避免一次渲染上千张缩略图。 */
const PAGE_SIZE = 100;
const annotationSourceNames: Record<string, string> = {
  import: '导入素材', api: '云端候选', local: '本地候选', manual: '人工编辑',
  imported_yolo: '导入标注', preset_manual: '人工示例', track: '轨迹候选',
};

/**
 * 对话里的项目素材概况：项目素材不是单次运行快照，文案明确提示不限于本轮。
 * 缩略图按页加载（每页 100 张 + 加载更多），统计只覆盖已加载部分并在文案里注明，
 * 抽查走只读预览，修正仍然回到对话。
 * 默认只铺两排：项目动辄上千张，卡片被拉长会把对话流和输入框一起顶出视野。
 */
export default function ResultCard({ project }: { project: Project }) {
  const { notify, events } = useApp();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<Asset | null>(null);
  const [exporting, setExporting] = useState(false);
  const [failedThumbnails, setFailedThumbnails] = useState<Record<string, boolean>>({});
  const [thumbnailRetryKeys, setThumbnailRetryKeys] = useState<Record<string, number>>({});
  const [expanded, setExpanded] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  // 两排封顶需要按当前列数换算张数：网格是 auto-fill，列数随窗口宽度变，写死张数会在窄窗口下多露一排。
  const [columns, setColumns] = useState(0);
  useEffect(() => {
    const node = gridRef.current;
    if (!node) return;
    const measure = () => setColumns(getComputedStyle(node).gridTemplateColumns.split(' ').filter(Boolean).length);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [assets.length]);
  async function load(more: boolean) {
    setLoading(true);
    try {
      const offset = more ? assets.length : 0;
      const result = await request<{ items: Asset[]; total: number }>('asset.list', { projectId: project.id, offset, limit: PAGE_SIZE });
      setAssets(current => more ? [...current, ...result.items.filter(item => !current.some(existing => existing.id === item.id))] : result.items);
      setTotal(result.total);
    } catch (e) { notify(errorMessage(e), true); }
    finally { setLoading(false); }
  }
  useEffect(() => { setAssets([]); setTotal(0); setExpanded(false); void load(false); }, [project.id]);
  /**
   * 标注结果是异步写入的：助手提交任务时这张卡片已经渲染出来了，只在挂载时读一次，
   * 运行结束后卡片就停在旧状态——走查里「明明有候选框，列表却显示未标注 · 0 个」正是这么来的。
   * 这里按真实事件重新读取，事件类型只认会改变素材标注的那几种。
   */
  const refreshedEvent = events.at(-1)?.type ?? '';
  useEffect(() => {
    if (!['annotation.candidate', 'annotation.saved', 'asset.imported', 'sample.succeeded', 'run.completed', 'run.completed_with_errors', 'run.needs_attention'].includes(refreshedEvent)) return;
    const timer = window.setTimeout(() => void load(false), 400);
    return () => window.clearTimeout(timer);
  }, [events.at(-1)?.sequence, refreshedEvent]);
  const annotationCount = assets.reduce((sum, asset) => sum + asset.annotations.length, 0);
  // 候选与正式分开报数：把「有候选框」说成「未标注」，用户会以为助手什么都没做。
  const candidateOnly = assets.filter(asset => asset.status === 'candidate').length;
  const confirmedOnly = assets.filter(asset => asset.status === 'confirmed').length;
  const distribution = project.classes
    .map(label => ({ id: label.id, name: label.name, color: label.color,
      count: assets.reduce((sum, asset) => sum + asset.annotations.filter(annotation => annotation.classId === label.id).length, 0) }))
    .filter(item => item.count > 0);
  // 折叠上限按实测列数取两排；列数尚未测出时先按 2 列估一版，避免首屏把 100 张全铺出来。
  const collapsedLimit = Math.max(columns, 2) * 2;
  const visible = expanded ? assets : assets.slice(0, collapsedLimit);
  return <section className="result-card" aria-label="项目素材概况">
    <div className="result-card-head">
      <div>
        <h3>项目素材 · {project.name}</h3>
        <p className="muted tiny">当前项目素材概况（不限于本轮）· 已加载 {assets.length} / 共 {total} 张 · {annotationCount} 个标注对象{candidateOnly ? `（其中 ${candidateOnly} 张是待确认的候选）` : ''}{confirmedOnly ? ` · 已确认 ${confirmedOnly} 张` : ''}{assets.length < total ? '（统计只覆盖已加载部分）' : ''}</p>
      </div>
      <div className="actions">
        <Button disabled={!assets.length} onClick={() => setPreview(assets[0])}><Eye size={14} />抽查</Button>
        <Button disabled={isDemo} onClick={() => setExporting(true)}><Download size={14} />导出</Button>
        <Button onClick={() => { const box = document.querySelector<HTMLTextAreaElement>('.chat-panel textarea'); box?.focus(); box?.scrollIntoView({ block: 'center' }); }}><PencilLine size={14} />继续修正</Button>
      </div>
    </div>
    {distribution.length > 0 && <div className="result-stats">{distribution.map(item => <span key={item.id}><i style={{ background: item.color }} />{item.name} <strong>{item.count}</strong></span>)}</div>}
    {assets.length
      ? <div className="result-grid" ref={gridRef}>{visible.map(asset => <div className="result-thumb-wrap" key={asset.id}><button className="result-thumb" title={`${asset.name} · ${statusNames[asset.status] ?? asset.status}`} onClick={() => setPreview(asset)}>
        <AssetThumbnail key={`${asset.id}:${thumbnailRetryKeys[asset.id] ?? 0}`} src={thumbnailUrlForAsset(asset, isDemo)} alt={asset.name}
          retryKey={thumbnailRetryKeys[asset.id] ?? 0} onFailureChange={failed => setFailedThumbnails(current => ({ ...current, [asset.id]: failed }))} />
        <span className="truncate">{asset.name}</span>
        <small>{annotationSourceNames[asset.source] ?? '其他来源'} · {statusNames[asset.status] ?? asset.status} · {asset.annotations.length} 个</small>
      </button>{failedThumbnails[asset.id] && <button type="button" className="result-thumb-retry" aria-label={`重试加载 ${asset.name} 缩略图`}
        onClick={event => { event.stopPropagation(); setFailedThumbnails(current => ({ ...current, [asset.id]: false }));
          setThumbnailRetryKeys(current => ({ ...current, [asset.id]: (current[asset.id] ?? 0) + 1 })); }}>重试缩略图</button>}</div>)}</div>
      : <p className="quiet-empty">{loading ? '正在读取素材…' : '这个项目还没有素材，先在对话里说明要导入什么。'}</p>}
    {/* 折叠与分页是两层：先展开本轮已加载的全部，再考虑去服务端取下一页。文案写「已加载」避免与分页张数混淆。 */}
    {assets.length > visible.length && <Button onClick={() => setExpanded(true)}><ChevronDown size={14} />展开已加载的 {assets.length} 张</Button>}
    {expanded && <Button onClick={() => setExpanded(false)}><ChevronUp size={14} />收起</Button>}
    {assets.length < total && <Button busy={loading} onClick={() => void load(true)}>加载更多（还有 {total - assets.length} 张）</Button>}
    {preview && <Modal wide title={`素材 · ${preview.name}`} onClose={() => setPreview(null)}>
      {/* 结果卡片与项目概览共用同一个标注编辑器：默认只读，点「编辑标注」才进画布。 */}
      <AssetAnnotator asset={preview} classes={project.classes} taskType={project.taskType} templateSettings={project.settings}
        connectionTemplate={project.settings?.keypointConnections} maxHeight="60vh"
        onClose={() => setPreview(null)}
        onSaved={updated => { setAssets(list => list.map(item => item.id === updated.id ? updated : item)); setPreview(updated); }} />
    </Modal>}
    {exporting && <ExportDialog onClose={() => setExporting(false)} />}
  </section>;
}
