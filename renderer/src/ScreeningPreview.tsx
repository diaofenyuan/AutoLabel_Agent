import { useState } from 'react';
import type { MediaJob, ScreeningParameters as Parameters } from '../../shared/media';
import { request, errorMessage } from './bridge';
import { Button, Field, Modal, Notice } from './ui';
import { MediaError } from './mediaUi';
import { MediaJobDetail } from './MediaJobs';

export default function ScreeningPreview({ projectId, parameters, fixedAssetIds, excludeIds, selectedAssetIds, onApply, onClose }: { projectId: string; parameters: Parameters; fixedAssetIds?: string[]; excludeIds: string[]; selectedAssetIds: string[]; onApply: (ids: string[]) => void; onClose: () => void }) {
  const [scope, setScope] = useState<'all' | 'selected' | 'fixed'>(fixedAssetIds ? 'fixed' : 'all'), [jobId, setJobId] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function create() { setBusy(true); setError(''); try { if (parameters.blurEnabled && (parameters.blurThreshold === undefined || !Number.isFinite(parameters.blurThreshold) || parameters.blurThreshold < 0)) throw new Error('启用模糊检查时，请先填写非负的分析阈值。'); const assetIds = scope === 'fixed' ? fixedAssetIds : scope === 'selected' ? selectedAssetIds : undefined; if (assetIds && !assetIds.length) throw new Error('所选范围没有素材。'); const job = await request<MediaJob>('media.screening.create', { projectId, ...(assetIds ? { assetIds } : {}), parameters }); setJobId(job.id); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); } }
  return <Modal title="预览已有素材筛选" wide onClose={() => { if (!busy) onClose(); }}><div className="form-stack screening-preview"><Notice>分析范围是项目中已存在的基准父图，不预执行尚未运行的导入、图像处理或其他上游步骤。分析只生成提示，明确勾选后才会写入当前流程的排除列表。</Notice>{!jobId ? <><Field label="实际分析范围"><select aria-label="筛选预览范围" disabled={busy} value={scope} onChange={e => setScope(e.target.value as typeof scope)}><option value="all">全项目已有素材</option><option value="selected">工作台跨页已勾选 · {selectedAssetIds.length} 张</option>{fixedAssetIds && <option value="fixed">当前节点固定保留列表 · {fixedAssetIds.length} 张</option>}</select></Field><Button className="primary" busy={busy} onClick={() => void create()}>开始只读筛选分析</Button></> : <MediaJobDetail key={jobId} jobId={jobId} onRetry={setJobId} excludeIds={excludeIds} onApplyExclude={onApply}/>}<MediaError error={error}/></div></Modal>;
}
