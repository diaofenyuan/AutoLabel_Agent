import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { Asset, Project } from './types';
import { errorMessage, request } from './bridge';
import { useApp } from './context';
import { Button, Loading, Modal, Notice } from './ui';
import AssetAnnotator from './AssetAnnotator';

/**
 * 人工标注参考示例：抽样 → 连续标注 → 交回已确认的素材 id。
 *
 * 队列放 sessionStorage 而不是组件 state：一次要标 5～10 张，必然跨刷新与误关，
 * 回来应该接着标，而不是重抽一批完全不同的图。key 带 projectId，换项目不会串队列。
 */
const QUEUE_KEY = 'manual-example-queue';
interface Queue { projectId: string; assetIds: string[] }

function readQueue(projectId: string): string[] {
  try {
    const raw = sessionStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Queue;
    return parsed.projectId === projectId && Array.isArray(parsed.assetIds) ? parsed.assetIds.filter(id => typeof id === 'string') : [];
  } catch { return []; }
}
function writeQueue(projectId: string, assetIds: string[]) {
  try { sessionStorage.setItem(QUEUE_KEY, JSON.stringify({ projectId, assetIds } satisfies Queue)); } catch { /* 隐私模式不可写：队列退化为本次会话内有效。 */ }
}
function clearQueue() { try { sessionStorage.removeItem(QUEUE_KEY); } catch { /* 同上。 */ } }

export interface ManualExampleFlowProps {
  project: Project;
  /** 抽样张数上限，已按接口图片数能力收窄。 */
  limit: number;
  onClose: () => void;
  /** 交回已确认的示例素材 id；为空表示用户中途放弃且没有任何成功标注。 */
  onDone: (assetIds: string[]) => void;
  /** 抽样失败：交回错误文案，由调用方决定降级还是留在提示层。 */
  onFailed: (message: string) => void;
}

export default function ManualExampleFlow({ project, limit, onClose, onDone, onFailed }: ManualExampleFlowProps) {
  const { notify } = useApp();
  const [queue, setQueue] = useState<string[]>([]);
  const [done, setDone] = useState<string[]>([]);
  const [asset, setAsset] = useState<Asset | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [phase, setPhase] = useState<'loading' | 'annotating' | 'finished'>('loading');
  const [resumed, setResumed] = useState(false);
  // AssetAnnotator 自带「保存并确认」，画布上的改动只存在它内部的状态里。
  // 流程按钮不能自己拼 annotations 再调 annotation.save——那样写进去的是打开时的旧内容，
  // 等于把用户刚画的框静默丢掉。这里改为驱动它自己的按钮，再由 onSaved 推进队列。
  const host = useRef<HTMLDivElement>(null);
  const index = done.length + 1;
  const total = done.length + queue.length;

  const load = useCallback((assetId: string) => {
    if (!assetId) { setAsset(null); return; }
    void request<Asset>('asset.get', { assetId }).then(setAsset).catch(() => setAsset(null));
  }, []);

  useEffect(() => {
    const pending = readQueue(project.id);
    if (pending.length) {
      // 续做：上一轮已经标完的这张直接结算，不让用户再点一次保存。
      // 这里不能用 advance —— 它闭包里的 queue 是挂载时的空数组，会把整条队列清掉。
      void request<Asset>('asset.get', { assetId: pending[0] })
        .then(found => {
          const rest = pending.slice(1);
          if (found.status === 'confirmed' || found.status === 'modified') {
            setDone([pending[0]]); setQueue(rest); writeQueue(project.id, rest); load(rest[0]);
          } else { setResumed(true); setQueue(pending); load(pending[0]); }
        })
        .catch(() => {
          const rest = pending.slice(1);
          setQueue(rest); writeQueue(project.id, rest); load(rest[0]);
        });
      setPhase('annotating');
      return;
    }
    void request<{ ids: string[] }>('asset.sample', { projectId: project.id, limit })
      .then(picked => {
        const ids = picked.ids.filter(id => typeof id === 'string' && id);
        if (!ids.length) { onFailed('这个项目里没有可抽的未标注图片。'); return; }
        setQueue(ids); writeQueue(project.id, ids); load(ids[0]); setPhase('annotating');
      })
      .catch(e => onFailed(errorMessage(e)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** 队列空了（跳过或续做时结算完最后一张）就收尾，否则界面停在空白弹窗上。 */
  useEffect(() => {
    if (phase === 'annotating' && !queue.length) { clearQueue(); setPhase('finished'); }
  }, [phase, queue.length]);

  /** 推进：确认成功后进入下一张；队列空则收尾。 */
  function advance(confirmed: string[]) {
    setDone(confirmed);
    if (queue.length > 1) {
      const rest = queue.slice(1);
      setQueue(rest); writeQueue(project.id, rest); load(rest[0]);
      notify(`已确认第 ${confirmed.length} 张示例。`);
    } else { clearQueue(); setQueue([]); setPhase('finished'); }
  }

  // AssetAnnotator 保存成功后回调；确认了就推进队列。
  function handleSaved(updated: Asset) {
    setAsset(updated);
    setBusy(false);
    if (updated.status === 'confirmed') advance([...done, updated.id]);
  }

  /** 点流程里的确认：转发到画布自己的「保存并确认」，由它来落库。 */
  function requestSave() {
    const root = host.current;
    if (!root || busy || !asset) return;
    const button = [...root.querySelectorAll('button')].find(item => item.innerText.includes('保存并确认')) as HTMLButtonElement | undefined;
    if (!button) { setError('当前这张的确认按钮不可用：若停在只读预览，请先点「编辑标注」。'); return; }
    if (button.disabled) { setError('还没有改动：请先在画布上画出目标，再保存并确认。'); return; }
    setError(''); setBusy(true);
    button.click();
  }

  /** 跳过这张：不写入示例，移出队列继续。 */
  function skip() {
    setBusy(false);
    const rest = queue.slice(1);
    setQueue(rest); writeQueue(project.id, rest);
    if (rest.length) load(rest[0]); else { clearQueue(); setPhase('finished'); }
  }

  if (phase === 'loading') return <Modal wide title="人工标注示例" onClose={onClose}><Loading label="正在抽取示例图片…" /></Modal>;

  if (phase === 'finished') return <Modal wide title="人工标注示例" onClose={() => onDone(done)}>
    <div className="form-stack">
      <Notice>{done.length
        ? `本轮确认了 ${done.length} 张示例，它们会作为参考一起发给 AI 模型。`
        : '这轮没有确认任何示例，本次标注将不使用参考。'}</Notice>
      <div className="modal-actions">
        <Button onClick={onClose}>返回标注设置</Button>
        <Button className="primary" onClick={() => onDone(done)}>返回标注设置并使用示例</Button>
      </div>
    </div>
  </Modal>;

  return <Modal wide title={`人工标注示例 · ${index}/${total}`} onClose={() => onDone(done)}>
    {resumed && <Notice>接着上次的进度继续，已确认 {done.length} 张。</Notice>}
    <div ref={host}>
      {asset
        ? <AssetAnnotator key={asset.id} asset={asset} classes={project.classes} taskType={project.taskType} templateSettings={project.settings}
            connectionTemplate={project.settings?.keypointConnections as string[] | undefined} maxHeight="52vh" startInEdit
            onClose={() => onDone(done)} onSaved={handleSaved} />
        : <div className="form-stack"><Loading label="正在读取图片…" /><Button disabled={busy} onClick={skip}>跳过这张</Button></div>}
    </div>
    <p className="muted tiny">点「保存并确认」后会直接进入下一张；如果画面停在只读预览，先点画布上方的「编辑标注」。确认后的图片不会再被本次标注。</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="modal-actions">
      <Button disabled={busy} onClick={() => onDone(done)}>退出</Button>
      <Button disabled={busy || !asset} onClick={skip}>跳过这张</Button>
      <Button className="primary" disabled={busy || !asset} busy={busy} onClick={requestSave}>
        {queue.length > 1 ? <><ChevronLeft size={14} />保存并确认，下一张<ChevronRight size={14} /></> : '保存并确认，结束示例'}
      </Button>
    </div>
  </Modal>;
}