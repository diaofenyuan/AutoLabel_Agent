import { useEffect, useState } from 'react';
import type { Track, TrackAffectedScope, TrackFrame, TrackGeneration, TrackGenerationParameters, TrackGenerationPreview, TrackLocalSequenceCandidate, TrackLocalSequenceResult, TrackTimelineDetail } from '../../shared/tracks';
import { Button, Field, Modal, Notice } from './ui';
import { errorMessage, request } from './bridge';
import { confirmDialog } from './confirm';
import type { LocalRuntimeState } from '../../shared/inference';
import { TrackError, TrackIssues, trackRequest } from './trackUi';

export interface TrackToolResult { trackId: string; affected?: TrackAffectedScope; generation?: TrackGeneration }
export default function TrackTools({ timeline, track, frame, tracks, onChanged }: { timeline: TrackTimelineDetail; track: Track; frame?: TrackFrame; tracks: Track[]; onChanged: (result: TrackToolResult) => void }) {
  const [name, setName] = useState(track.name), [operation, setOperation] = useState<'split' | 'merge' | 'delete' | null>(null), [otherId, setOtherId] = useState(''), [sameObject, setSameObject] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [preview, setPreview] = useState<TrackGenerationPreview | null>(null);
  const [localSequence, setLocalSequence] = useState<{ state: 'idle' | 'running' | 'submitted' | 'unavailable'; result?: TrackLocalSequenceResult; message?: string }>({ state: 'idle' });
  const [localCandidates, setLocalCandidates] = useState<TrackLocalSequenceCandidate[]>([]), [confirmingCandidate, setConfirmingCandidate] = useState(''), [promotingCandidate, setPromotingCandidate] = useState('');
  const [scope, setScope] = useState<'affected' | 'all'>('affected'), [parameters, setParameters] = useState<Record<string, string>>({});
  const base = { trackId: track.id, baseVersion: track.version, timelineVersion: timeline.version };
  function selectedParameters(): TrackGenerationParameters {
    const result: TrackGenerationParameters = {};
    for (const [key, value] of Object.entries(parameters)) if (value !== '') { const n = Number(value); if (!Number.isFinite(n) || n > 1e12 || (key === 'maxScaleFactor' ? n < 1 : n <= 0)) throw new Error('生成阈值需要为有效正数；尺寸变化倍数不得小于 1。'); result[key as keyof TrackGenerationParameters] = n; }
    return result;
  }
  async function run(action: 'preview' | 'generate' | 'rename' | 'split' | 'merge' | 'delete') {
    setBusy(true); setError('');
    try {
      if (action === 'preview') { setPreview(await trackRequest('track.generate.preview', { ...base, scope, parameters: selectedParameters() })); return; }
      if (action === 'generate') { if (!preview?.canGenerate) return; const generation = await trackRequest('track.generate', { ...base, scope, parameters: preview.parameters, expectedPlanHash: preview.planHash }); setPreview(null); onChanged({ trackId: track.id, generation }); return; }
      if (action === 'merge') { const other = tracks.find(t => t.id === otherId); if (!other) throw new Error('请选择另一条轨迹。'); const result = await trackRequest('track.merge', { leftTrackId: track.id, leftVersion: track.version, rightTrackId: other.id, rightVersion: other.version, timelineVersion: timeline.version, name: name.trim() || track.name, confirmSameObject: sameObject }); onChanged({ trackId: result.track.id, affected: result.affected, generation: result.generation }); }
      else if (action === 'split') { if (!frame) throw new Error('请先选择拆分位置。'); const result = await trackRequest('track.split', { ...base, splitFrameId: frame.frameId, leftName: `${track.name} · 前段`, rightName: `${track.name} · 后段` }); onChanged({ trackId: result.leftTrack.id, affected: result.affected, generation: result.generation }); }
      else { const result = action === 'delete' ? await trackRequest('track.delete', base) : await trackRequest('track.update', { trackId: track.id, baseVersion: track.version, name: name.trim() }); onChanged({ trackId: result.track.id, affected: result.affected, generation: result.generation }); }
      setOperation(null); setPreview(null);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  async function runLocalSequence() {
    if (timeline.taskType !== 'detect' || disabled) return;
    setLocalSequence({ state: 'running' }); setError('');
    try {
      // 只把设置里已加载且空闲的本地模型槽位交给引擎；路径、模型摘要和帧文件由引擎从固定时间轴重新组装。
      const runtime = await request<LocalRuntimeState>('local.runtime.get');
      const slot = runtime.slots.find(value => !value.busy && value.modelId && value.classes?.length);
      if (!slot?.modelId || !slot.classes?.length) throw new Error('请先在设置 · 软件 AI 配置里加载 Detect 模型并读取类别。');
      const targets = timeline.template.classes;
      const classMap: Record<string, string | null> = {};
      for (const source of slot.classes) {
        const target = targets.find(value => value.id === source.id) ?? targets.find(value => value.name === source.name);
        if (!target) throw new Error(`模型类别“${source.name}”没有与当前时间轴模板唯一匹配的项目类别，请先完成类别映射。`);
        classMap[source.id] = target.id;
      }
      const result = await trackRequest('track.local.sequence', {
        timelineId: timeline.id, timelineVersion: timeline.version, modelId: slot.modelId,
        ...(slot.modelVersion === undefined ? {} : { modelVersion: slot.modelVersion }), device: slot.device,
        timeoutMs: 600000, classMap, detector: 'detect', scope,
      });
      setLocalSequence({ state: 'submitted', result });
      void refreshLocalCandidates();
    } catch (e) {
      const message = errorMessage(e);
      setLocalSequence({ state: 'unavailable', message: /not_implemented|unknown_command|INVALID_COMMAND/i.test(message) ? '当前引擎尚未支持本地 Detect 自动跟踪；未生成任何候选。' : message });
    }
  }
  const disabled = busy || track.status !== 'active';
  async function refreshLocalCandidates() {
    if (timeline.taskType !== 'detect') return;
    try { const page = await trackRequest('track.local.sequence.list', { timelineId: timeline.id, limit: 5 }); setLocalCandidates(page.items); } catch { /* 演示模式或旧引擎没有历史候选时保持空态。 */ }
  }
  async function confirmLocalCandidate(candidate: TrackLocalSequenceCandidate) {
    if (candidate.confirmation || confirmingCandidate) return;
    if (!(await confirmDialog('确认已阅读该本地跟踪候选并提交人工复核？此操作不会自动写入正式轨迹。'))) return;
    setConfirmingCandidate(candidate.candidateId); setError('');
    try {
      const result = await trackRequest('track.local.sequence.confirm', { candidateId: candidate.candidateId, timelineId: timeline.id, timelineVersion: timeline.version, confirm: true });
      setLocalCandidates(previous => previous.map(item => item.candidateId === candidate.candidateId ? { ...item, confirmation: result.confirmation } : item));
    } catch (e) { setError(errorMessage(e)); } finally { setConfirmingCandidate(''); }
  }
  // 只有已经过用户显式确认、且尚未建立生成任务的候选才出现在提升入口。
  const promotableCandidates = localCandidates.filter(candidate => candidate.confirmation && !candidate.promotion);
  async function promoteLocalCandidate(candidate: TrackLocalSequenceCandidate) {
    if (candidate.promotion || promotingCandidate) return;
    if (!(await confirmDialog('把该本地跟踪候选写入正式轨迹与生成任务？会建立真实轨迹并按逐帧真实检测生成待复核候选贡献，人工修订并保存前不会导出。'))) return;
    setPromotingCandidate(candidate.candidateId); setError('');
    try {
      const result = await trackRequest('track.local.sequence.promote', { candidateId: candidate.candidateId, timelineId: timeline.id, timelineVersion: timeline.version, confirm: true });
      setLocalCandidates(previous => previous.map(item => item.candidateId === candidate.candidateId ? {
        ...item,
        promotion: { generationId: result.generationId, promotedAt: new Date().toISOString(), timelineVersion: timeline.version, trackCount: result.trackCount, frameCount: result.frameCount, candidateAnnotationCount: result.candidateAnnotationCount, skippedTrackCount: result.skippedTrackCount, skippedFrameCount: result.skippedFrameCount, formalContributionPending: true, requiresManualReview: true },
      } : item));
      const created = result.tracks[0]?.trackId;
      if (created) onChanged({ trackId: created });
    } catch (e) { setError(errorMessage(e)); } finally { setPromotingCandidate(''); }
  }
  useEffect(() => { setLocalCandidates([]); void refreshLocalCandidates(); }, [timeline.id, timeline.version]);
  return <section className="track-tools"><p className="muted tiny">关键帧 {track.keyframeCount} · {track.needsRecompute ? `待重算 ${track.pendingFrameCount} 帧` : '没有待重算范围'} · 版本 {track.version}</p><div className="actions"><Button className="primary" disabled={disabled} onClick={() => void run('preview')}>预览候选生成</Button></div><details className="track-options"><summary>生成范围与阈值</summary><Field label="生成范围"><select disabled={disabled} value={scope} onChange={e => { setScope(e.target.value as 'affected' | 'all'); setPreview(null); }}><option value="affected">仅受影响区间</option><option value="all">整条轨迹</option></select></Field><p className="muted tiny">留空采用引擎默认值，预览中会列出实际阈值。</p><div className="field-grid">{[['maxGapSeconds', '最大间隔（秒）'], ['maxCenterSpeedPixelsPerSecond', '中心速度上限（像素/秒）'], ['maxKeypointSpeedPixelsPerSecond', '点位速度上限（像素/秒）'], ['maxScaleFactor', '尺寸变化倍数上限']].map(([key, label]) => <Field key={key} label={label}><input aria-label={label} type="number" step="any" min={key === 'maxScaleFactor' ? 1 : 0} max={1e12} disabled={disabled} value={parameters[key] ?? ''} placeholder="引擎默认" onChange={e => { setParameters(previous => ({ ...previous, [key]: e.target.value })); setPreview(null); }}/></Field>)}</div></details>
    {preview && <div className="track-generation-preview"><strong>{preview.canGenerate ? '预览已就绪' : '当前不能生成'}</strong><p>范围 {preview.frameCount} 帧 · 受影响 {preview.affectedCount} 帧 · 保护 {preview.protectedCount} 帧</p><TrackIssues issues={preview.issues}/>{preview.issueCount > preview.issues.length && <p className="text-error">仅显示前 {preview.issues.length} / {preview.issueCount} 条问题。</p>}<details><summary>实际区间检查与阈值</summary><p>已显示 {preview.intervals.length} / {preview.intervalsTotal} 个区间{preview.intervalsTruncated ? '，预览已截断' : ''}</p><pre>{JSON.stringify(preview.parameters, null, 2)}</pre>{preview.intervals.map(interval => <article key={interval.intervalId}><strong>{interval.leftFrameId} → {interval.rightFrameId}</strong><p>{interval.blocked ? '区间被阻断' : interval.requiresReview ? '需人工复核' : '可生成候选'}</p><TrackIssues issues={interval.reviewIssues}/></article>)}</details><Notice>提交后生成待复核候选。跨时间段、场景未检查及速度异常的处理，以实际区间检查为准。</Notice><Button className="primary" disabled={disabled || !preview.canGenerate} onClick={() => void run('generate')}>按本次预览生成候选</Button></div>}
    <details className="track-options"><summary>轨迹名称与管理</summary><div className="track-name-edit"><input aria-label="轨迹名称" maxLength={200} value={name} disabled={disabled} onChange={e => setName(e.target.value)}/><Button disabled={disabled || !name.trim()} onClick={() => void run('rename')}>保存名称</Button></div><div className="actions"><Button disabled={disabled || !frame} onClick={() => setOperation('split')}>在当前帧拆分…</Button><Button disabled={disabled || tracks.filter(t => t.status === 'active').length < 2} onClick={() => { setSameObject(false); setOtherId(''); setOperation('merge'); }}>合并轨迹…</Button><Button disabled={disabled} onClick={() => setOperation('delete')}>删除轨迹…</Button></div></details><TrackError error={error}/>
    {operation && <Modal title={operation === 'split' ? '拆分轨迹' : operation === 'merge' ? '合并轨迹' : '删除轨迹'} onClose={() => { if (!busy) setOperation(null); }}><div className="form-stack"><p>{track.name}{operation === 'split' && frame ? ` · 在 ${frame.timeSeconds.toFixed(3)} 秒（${frame.frameId}）拆分` : ''}</p><Notice>原轨迹历史继续保留。候选贡献由后台任务更新，人工标注和草稿受到保护；完成状态以实际任务结果为准。</Notice>{operation === 'merge' && <><Field label="另一条轨迹"><select aria-label="待合并轨迹" value={otherId} disabled={busy} onChange={e => { setOtherId(e.target.value); setSameObject(false); }}><option value="">请选择</option>{tracks.filter(t => t.id !== track.id && t.status === 'active').map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field><label className="checkbox-row"><input type="checkbox" aria-label="确认同一对象" checked={sameObject} onChange={e => setSameObject(e.target.checked)} disabled={busy}/>确认两条轨迹对应同一个实际对象</label></>}<TrackError error={error}/><div className="modal-actions"><Button disabled={busy} onClick={() => setOperation(null)}>取消</Button><Button className="primary" busy={busy} disabled={operation === 'merge' && (!otherId || !sameObject)} onClick={() => void run(operation)}>{operation === 'split' ? '拆分并更新候选' : operation === 'merge' ? '合并并更新候选' : '删除并更新候选'}</Button></div></div></Modal>}
    <div className="track-local-actions"><Button disabled={disabled || timeline.taskType !== 'detect'} busy={localSequence.state === 'running'} onClick={() => void runLocalSequence()}>生成本地待复核候选（Detect）</Button>{timeline.taskType !== 'detect' && <span className="muted tiny">仅适用于 Detect 时间轴</span>}</div>{localSequence.state === 'submitted' && localSequence.result && <div className="track-local-status" role="status"><strong>{localSequence.result.status === 'completed' ? '本地候选已生成' : localSequence.result.status === 'running' ? '本地候选生成中' : '本地候选已排队'}</strong><p>{localSequence.result.candidateCount === undefined ? '候选数量由引擎完成后报告。' : `已发现 ${localSequence.result.candidateCount} 个候选。`} 所有结果均标记为待复核候选，已保存到候选历史。</p>{localSequence.result.candidateId && <p className="tiny muted">候选 ID：<span className="code">{localSequence.result.candidateId}</span></p>}{localSequence.result.provenance && <details><summary>查看跟踪来源</summary><pre>{JSON.stringify(localSequence.result.provenance, null, 2)}</pre></details>}</div>}{localSequence.state === 'unavailable' && <div className="track-local-status error" role="alert"><strong>本地候选生成暂不可用</strong><p>{localSequence.message}</p></div>}{localCandidates.length > 0 && <div className="track-local-history"><div className="section-toolbar"><strong>候选历史</strong><button className="text-button" onClick={() => void refreshLocalCandidates()}>刷新</button></div><Notice>历史记录只读，不会自动写入正式轨迹。请先在时间轴逐帧核对，再用关键帧编辑保存人工对象；需要生成正式轨迹候选时，请从关键帧重新预览并提交，人工标注和草稿会继续受到保护。</Notice>{localCandidates.map(candidate => <details key={candidate.candidateId}><summary>{new Date(candidate.createdAt).toLocaleString('zh-CN')} · {candidate.candidateCount ?? 0} 个候选 · {candidate.reviewRequired ? '需要复核' : '规则检查通过，仍待确认'}</summary><p className="tiny muted">来源模型 {candidate.modelHash ? `${candidate.modelHash.slice(0, 12)}…` : '未记录'} · worker {candidate.workerHash ? `${candidate.workerHash.slice(0, 12)}…` : '未记录'}</p><p className="tiny muted">后续动作：逐帧核对候选，确认后再通过关键帧与候选生成流程处理；此记录本身不会应用到正式轨迹。</p>{candidate.confirmation ? <p className="tiny muted">已提交人工复核：{new Date(candidate.confirmation.confirmedAt).toLocaleString('zh-CN')} · 正式轨迹未改写</p> : <Button disabled={disabled || Boolean(confirmingCandidate)} busy={confirmingCandidate === candidate.candidateId} onClick={() => void confirmLocalCandidate(candidate)}>确认并提交人工复核</Button>}</details>)}</div>}
    {promotableCandidates.length > 0 && <div className="track-local-history" role="group" aria-label="可写入正式轨迹的本地候选"><div className="section-toolbar"><strong>可写入正式轨迹的候选</strong></div><Notice>这些候选已由你确认并登记人工复核。写入会建立真实轨迹，并按逐帧真实关联检测生成待复核候选贡献；预测位置不会被当作人工确认标注，人工标注与草稿继续受到保护。</Notice>{promotableCandidates.map(candidate => <div key={candidate.candidateId} className="track-local-promotion"><p className="tiny muted">候选 <span className="code">{candidate.candidateId.slice(0, 8)}…</span> · {candidate.candidateCount ?? 0} 个候选{candidate.confirmation ? ` · 确认于 ${new Date(candidate.confirmation.confirmedAt).toLocaleString('zh-CN')}` : ''}</p><Button className="primary" disabled={disabled} busy={promotingCandidate === candidate.candidateId} onClick={() => void promoteLocalCandidate(candidate)}>写入正式轨迹生成</Button></div>)}</div>}
    {localCandidates.filter(candidate => candidate.promotion).map(candidate => <div key={candidate.candidateId} className="track-local-status" role="status"><strong>已提交正式轨迹生成</strong><p>候选 {candidate.candidateId.slice(0, 8)}… 已建立 {candidate.promotion?.trackCount ?? 0} 条轨迹并冻结 {candidate.promotion?.frameCount ?? 0} 帧，逐帧候选贡献由后台任务产出。请在任务中心查看进度并在时间轴逐帧核对。</p><p className="tiny muted">生成 ID：<span className="code">{candidate.promotion?.generationId}</span></p></div>)}
  </section>;
}
