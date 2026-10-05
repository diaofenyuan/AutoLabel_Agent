import { useRef, useState } from 'react';
import { VIDEO_DOWNSAMPLE_LONG_EDGE, type MediaJob, type VideoInspection } from '../../shared/media';
import { request, errorMessage, isDemo } from './bridge';
import { Button, Modal } from './ui';
import { baseName } from './projectNaming';
import { batchExtractionPlan, remainingBatchItems } from './videoBatchPlan';

type BatchItemState = { kind: 'pending' } | { kind: 'working'; label: string } | { kind: 'queued'; note?: string } | { kind: 'failed'; error: string };
interface BatchItem { path: string; name: string; state: BatchItemState }

/** 建完任务后的汇总：失败与中途停止都要如实上报，调用方的提示才不会只报喜。 */
export interface BatchVideoResult { jobs: MediaJob[]; failed: number; stopped: boolean }

/**
 * 一键抽帧：对整批候选视频逐个「检查 → 按默认参数建任务」（参数计算见 videoBatchPlan）。
 * 引擎的媒体任务本就是单线程排队执行（一次跑一个），这里也逐个串行发请求，
 * 检查或建任务失败只跳过该视频并如实记录，不中断其余视频。
 */
export default function VideoBatchImport({ projectId, files, onClose, onCreated }: {
  projectId: string; files: string[]; onClose: () => void; onCreated: (result: BatchVideoResult) => void;
}) {
  const [items, setItems] = useState<BatchItem[]>(() => files.map(path => ({ path, name: baseName(path), state: { kind: 'pending' } })));
  const [running, setRunning] = useState(false), [stopped, setStopped] = useState(false);
  const cancelled = useRef(false);
  const patch = (path: string, state: BatchItemState) => setItems(list => list.map(item => item.path === path ? { ...item, state } : item));
  async function start() {
    cancelled.current = false;
    setRunning(true); setStopped(false);
    const jobs: MediaJob[] = []; let failed = 0;
    for (const item of remainingBatchItems(items)) {
      if (cancelled.current) break;
      try {
        patch(item.path, { kind: 'working', label: '正在检查…' });
        const inspection = await request<VideoInspection>('media.video.inspect', { sourcePath: item.path });
        if (cancelled.current) break;
        const plan = batchExtractionPlan(inspection);
        if ('error' in plan) { patch(item.path, { kind: 'failed', error: plan.error }); failed++; continue; }
        patch(item.path, { kind: 'working', label: '正在创建任务…' });
        const job = await request<MediaJob>('media.video.create', { projectId, sourcePath: item.path, expectedSourceHash: inspection.sourceHash, parameters: plan.parameters });
        jobs.push(job);
        patch(item.path, { kind: 'queued', note: plan.note });
      } catch (e) {
        patch(item.path, { kind: 'failed', error: errorMessage(e) });
        failed++;
      }
    }
    setRunning(false);
    if (cancelled.current) setStopped(true);
    // 一个任务都没建成时留在弹窗里：错误明细就在眼前，直接关掉用户只会觉得「点了没反应」。
    if (!jobs.length) return;
    onCreated({ jobs, failed, stopped: cancelled.current });
  }
  const queued = items.filter(item => item.state.kind === 'queued').length;
  const failed = items.filter(item => item.state.kind === 'failed').length;
  // 已经建过任务的视频不再重复发起：全部排完队后只剩「关闭」。
  const remaining = remainingBatchItems(items);
  const summary = !running && (queued || failed)
    ? `本次已创建 ${queued} 个抽帧任务${failed ? `，${failed} 个未能创建（原因见各条目）` : ''}。${stopped ? '未处理的部分已按要求停止，已创建的任务继续在后台执行。' : ''}`
    : '';
  return <Modal title={`一键抽帧（${items.length} 个视频）`} onClose={() => { if (!running) onClose(); }}>
    <div className="form-stack">
      <p className="muted tiny">全部按默认参数抽帧：场景变化采样、输出 PNG、超高清自动缩到长边 {VIDEO_DOWNSAMPLE_LONG_EDGE} 像素。任务在引擎里排队逐个执行，素材就绪后自动导入项目；想单独调某个视频的参数，回到清单逐个点「抽帧」。</p>
      <div className="board-list video-pick-list">{items.map(item => <article className="board-row" key={item.path}>
        <div className="board-main">
          <strong>{item.name}</strong>
          {item.state.kind === 'pending' && <span className="muted tiny">待处理</span>}
          {item.state.kind === 'working' && <span className="muted tiny">{item.state.label}</span>}
          {item.state.kind === 'queued' && <span className="tiny">已排队，素材就绪后自动导入</span>}
          {item.state.kind === 'failed' && <span className="text-error tiny break-word">{item.state.error}</span>}
          {item.state.kind === 'queued' && item.state.note && <span className="muted tiny break-word">{item.state.note}</span>}
        </div>
      </article>)}</div>
      {summary && <p className="muted tiny" aria-live="polite">{summary}</p>}
      <div className="modal-actions">
        {running
          ? <Button onClick={() => { cancelled.current = true; }}>停止</Button>
          : <>
            <Button onClick={onClose}>{queued ? '关闭' : '取消'}</Button>
            {remaining.length > 0 && <Button className="primary" disabled={isDemo} onClick={() => void start()}>开始抽帧（{remaining.length} 个）</Button>}
          </>}
      </div>
    </div>
  </Modal>;
}
