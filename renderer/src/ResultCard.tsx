import { useEffect, useState } from 'react';
import { Download, Eye, PencilLine } from 'lucide-react';
import { useApp } from './context';
import { request, errorMessage, isDemo } from './bridge';
import { Button, Modal } from './ui';
import ExportDialog from './ExportDialog';
import AssetAnnotator from './AssetAnnotator';
import { statusNames, type Asset, type Project } from './types';

/** asset.list 的 limit 上限就是 100；超过一页用 total 翻页，避免一次渲染上千张缩略图。 */
const PAGE_SIZE = 100;

/**
 * 对话结果卡片：把这一轮之后的实际结果摊开给用户看。
 * 缩略图按页加载（每页 100 张 + 加载更多），统计只覆盖已加载部分并在文案里注明，
 * 抽查走只读预览，修正仍然回到对话。
 */
export default function ResultCard({ project }: { project: Project }) {
  const { notify, events } = useApp();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<Asset | null>(null);
  const [exporting, setExporting] = useState(false);
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
  useEffect(() => { setAssets([]); setTotal(0); void load(false); }, [project.id]);
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
  return <section className="result-card" aria-label="本轮结果">
    <div className="result-card-head">
      <div>
        <h3>结果 · {project.name}</h3>
        <p className="muted tiny">已加载 {assets.length} / 共 {total} 张 · {annotationCount} 个标注对象{candidateOnly ? `（其中 ${candidateOnly} 张是待确认的候选）` : ''}{confirmedOnly ? ` · 已确认 ${confirmedOnly} 张` : ''}{assets.length < total ? '（统计只覆盖已加载部分）' : ''}</p>
      </div>
      <div className="actions">
        <Button disabled={!assets.length} onClick={() => setPreview(assets[0])}><Eye size={14} />抽查</Button>
        <Button disabled={isDemo} onClick={() => setExporting(true)}><Download size={14} />导出</Button>
        <Button onClick={() => { const box = document.querySelector<HTMLTextAreaElement>('.chat-panel textarea'); box?.focus(); box?.scrollIntoView({ block: 'center' }); }}><PencilLine size={14} />继续修正</Button>
      </div>
    </div>
    {distribution.length > 0 && <div className="result-stats">{distribution.map(item => <span key={item.id}><i style={{ background: item.color }} />{item.name} <strong>{item.count}</strong></span>)}</div>}
    {assets.length
      ? <div className="result-grid">{assets.map(asset => <button key={asset.id} className="result-thumb" title={`${asset.name} · ${statusNames[asset.status] ?? asset.status}`} onClick={() => setPreview(asset)}>
        <img loading="lazy" src={`autolabel-media://thumb/${asset.id}`} alt={asset.name} />
        <span className="truncate">{asset.name}</span>
        <small>{statusNames[asset.status] ?? asset.status} · {asset.annotations.length} 个</small>
      </button>)}</div>
      : <p className="quiet-empty">{loading ? '正在读取素材…' : '这个项目还没有素材，先在对话里说明要导入什么。'}</p>}
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
