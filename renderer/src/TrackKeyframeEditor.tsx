import { useEffect, useState } from 'react';
import type { Track, TrackFrame, TrackKeyframeState, TrackMutation, TrackTimelineDetail } from '../../shared/tracks';
import type { Annotation, Asset } from './types';
import { errorMessage, request } from './bridge';
import { Button, Field, Modal, Notice } from './ui';
import QualityCanvas from './QualityCanvas';
import { annotationAttributeIssues } from './templateAttributes';
import { keyframeStates, TrackError, trackRequest } from './trackUi';
import { useApp } from './context';

export default function TrackKeyframeEditor({ timeline, track, frame, onClose, onSaved }: { timeline: TrackTimelineDetail; track: Track; frame: TrackFrame; onClose: () => void; onSaved: (result: TrackMutation) => void }) {
  const { syncWindowDirtySource } = useApp();
  const [asset, setAsset] = useState<Asset | null>(null), [annotations, setAnnotations] = useState<Annotation[]>([]), [selected, setSelected] = useState('');
  const [state, setState] = useState<TrackKeyframeState>(frame.keyframe?.state ?? 'located'), [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false), [pending, setPending] = useState(false), [exit, setExit] = useState(false), [error, setError] = useState(''), [savedVersion, setSavedVersion] = useState<number | null>(null);
  const [undo, setUndo] = useState<Annotation[][]>([]);
  const dirtySource = 'track-keyframe:' + frame.frameId;
  useEffect(() => { syncWindowDirtySource(dirtySource, dirty || pending); return () => syncWindowDirtySource(dirtySource, false); }, [dirty, pending, dirtySource, syncWindowDirtySource]);
  const current = annotations.find(a => a.id === selected), template = timeline.template;
  useEffect(() => { let live = true; void request<Asset>('asset.get', { assetId: frame.assetId }).then(value => {
    if (value.contentHash !== frame.contentHash || value.width !== frame.width || value.height !== frame.height || value.version !== frame.annotationVersion) throw new Error('track_frame_stale：帧内容或标注版本已变化，请刷新时间轴。');
    if (value.draft && value.metadata?.draftBaseVersion !== undefined && value.metadata.draftBaseVersion !== value.version) throw new Error('track_draft_conflict：此帧含旧版本草稿，请先在图片标注中核对。');
    if (live) { setAsset(value); setAnnotations(structuredClone(value.draft ?? value.annotations)); const keyId = frame.keyframe?.annotation?.id; setSelected(keyId && (value.draft ?? value.annotations).some(a => a.id === keyId) ? keyId : ''); }
  }).catch(e => { if (live) setError(errorMessage(e)); }); return () => { live = false; }; }, [frame.assetId, frame.annotationVersion]);
  function change(next: Annotation[]) { setUndo(list => [...list.slice(-29), structuredClone(annotations)]); setAnnotations(next); setDirty(true); setSavedVersion(null); }
  async function save() {
    if (!asset || pending || busy) return;
    if (state !== 'unlocatable' && (!current || current.classId !== track.classId || current.type !== timeline.taskType)) { setError('请选择与轨迹类别一致的单个对象。'); return; }
    const issues = state === 'unlocatable' ? [] : annotationAttributeIssues([current!], template.settings.attributes);
    if (issues.length) { setError(issues.join('；')); return; }
    setBusy(true); setError(''); let committed: Asset | null = null;
    try {
      const fresh = await request<Asset>('asset.get', { assetId: asset.id });
      if (fresh.version !== asset.version || fresh.contentHash !== asset.contentHash || JSON.stringify(fresh.draft ?? null) !== JSON.stringify(asset.draft ?? null)) throw new Error('track_frame_stale：编辑期间标注或草稿已变化。');
      let version = fresh.version, draftSavedAt = frame.draftSavedAt;
      if (state !== 'unlocatable') {
        // 保存完整帧，其他对象随原数组保留；关键帧绑定失败也不能撤销这次人工保存。
        committed = !asset.draft && JSON.stringify(annotations) === JSON.stringify(asset.annotations) ? fresh : await request<Asset>('annotation.save', { assetId: asset.id, baseVersion: fresh.version, annotations, confirm: false });
        version = committed.version; draftSavedAt = null; setAsset(committed); setAnnotations(structuredClone(committed.annotations)); setSavedVersion(version); setDirty(false);
      }
      const result = await trackRequest('track.keyframe.save', { trackId: track.id, baseVersion: track.version, timelineVersion: timeline.version, ...(frame.keyframe ? { keyframeId: frame.keyframe.keyframeId } : {}), frameId: frame.frameId, state, annotation: state === 'unlocatable' ? null : committed!.annotations.find(a => a.id === selected)!, baseAnnotationVersion: version, baseDraftSavedAt: draftSavedAt });
      onSaved(result);
    } catch (e) { setError(`${committed ? `标注版本 ${committed.version} 已保存，但关键帧未更新。` : ''}${errorMessage(e)}`); } finally { setBusy(false); }
  }
  return <Modal wide title="编辑轨迹关键帧" onClose={() => { if (busy) return; if (dirty || pending) setExit(true); else onClose(); }}><div className="form-stack track-keyframe-editor"><p><strong>{track.name}</strong> · {frame.timeSeconds.toFixed(3)} 秒 · 源帧 {frame.sourcePresentationIndex}</p><Notice>保存时先保存此帧的完整人工标注，再绑定关键帧；不会继承“人工已确认”。{asset?.draft ? '已载入当前草稿。' : ''}</Notice><Field label="关键帧状态"><select aria-label="关键帧状态" disabled={busy || pending} value={state} onChange={e => { setState(e.target.value as TrackKeyframeState); setDirty(true); }}>{Object.entries(keyframeStates).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
    {state === 'unlocatable' ? <p className="muted">不可定位只记录边界状态，不提交对象几何，也不改写此帧的标注。</p> : asset && <><Field label="绑定此帧对象" hint={`完整帧另有 ${annotations.filter(a => a.id !== selected).length} 个对象，保存时继续保留。`}><select aria-label="关键帧选中对象" disabled={busy || pending} value={selected} onChange={e => setSelected(e.target.value)}><option value="">选择已有对象，或在下方绘制新对象</option>{annotations.map((a, i) => <option disabled={a.classId !== track.classId || a.type !== timeline.taskType} key={a.id} value={a.id}>{i + 1} · {template.classes.find(c => c.id === a.classId)?.name ?? a.classId}</option>)}</select></Field><QualityCanvas key={selected || 'new'} purpose="keyframe" maxObjects={1} mediaUrl={asset.mediaUrl ?? ''} width={frame.width} height={frame.height} annotations={current ? [current] : []} classes={template.classes.filter(c => c.id === track.classId)} taskType={timeline.taskType} keypointNames={template.settings.keypointNames} keypointConnections={template.settings.keypointConnections} templateSettings={template.settings} title="关键帧人工对象" disabled={busy} onPendingChange={setPending} onChange={next => {
      if (next.length > 1) return; const others = annotations.filter(a => a.id !== selected); change([...others, ...next]); setSelected(next[0]?.id ?? '');
    }}/><Button disabled={busy || pending || !undo.length} onClick={() => { const previous = undo.at(-1)!; setAnnotations(previous); setUndo(list => list.slice(0, -1)); setSelected(previous.some(a => a.id === selected) ? selected : ''); setDirty(true); }}>撤销本次编辑</Button></>}
    {savedVersion !== null && <p className="muted">本次人工标注已保存为版本 {savedVersion}。{error && <strong className="text-error">关键帧尚未更新，请刷新时间轴后重新绑定；已保存的人工标注继续保留。</strong>}</p>}<TrackError error={error}/><div className="modal-actions"><Button disabled={busy} onClick={() => { if (dirty || pending) setExit(true); else onClose(); }}>返回时间轴</Button><Button className="primary" disabled={!asset || pending} busy={busy} onClick={() => void save()}>保存关键帧</Button></div>{exit && <div className="exit-confirm"><p>还有未提交的关键帧编辑。</p><div className="actions"><Button onClick={() => setExit(false)}>继续编辑</Button><Button onClick={onClose}>放弃未提交编辑并返回</Button></div></div>}</div></Modal>;
}
