import { useRef, useState } from 'react';
import { VIDEO_DENSITY_LABELS, VIDEO_DOWNSAMPLE_LONG_EDGE, VIDEO_MAX_RANGE_SECONDS, VIDEO_SCENE_MIN_INTERVAL_SECONDS, type MediaJob, type VideoDensity, type VideoInspection } from '../../shared/media';
import { request, errorMessage, isDemo } from './bridge';
import { Button, Field, Modal } from './ui';
import { baseName } from './projectNaming';
import { batchExtractionPlan, batchFailures, batchOutcome, remainingBatchItems, retryWhileMediaBusy, type BatchFailure } from './videoBatchPlan';

type BatchItemState = { kind: 'pending' } | { kind: 'working'; label: string } | { kind: 'queued'; note?: string } | { kind: 'failed'; error: string };
interface BatchItem { path: string; name: string; state: BatchItemState }

/**
 * 建完任务后的汇总：失败与中途停止都要如实上报，调用方的提示才不会只报喜。
 * failedItems 带上失败项路径与原因；unfinished 是还没建成任务的路径（失败 + 被停止的），
 * 面板收起后调用方仍能据此提示，并把这一批原样重开续跑——只重试这几个，不重复拖整批。
 */
export interface BatchVideoResult { jobs: MediaJob[]; failed: number; stopped: boolean; failedItems: BatchFailure[]; unfinished: string[] }

/**
 * 一键抽帧：整批共用同一采样策略，逐个「检查 → 建任务」（参数计算见 videoBatchPlan）。
 * 引擎的媒体任务本就是单线程排队执行（一次跑一个），这里也逐个串行发请求，
 * 检查或建任务失败只跳过该视频并如实记录，不中断其余视频。
 *
 * 面板只有在「全部排队、无失败、未中途停止」时才自动收起：一旦有失败或被停止就留在原地，
 * 把失败原因摆在眼前，用户可以直接「只重试失败项」或接着把没处理完的跑完——
 * 原先只要建成过一个任务就收起，失败明细随之消失，用户既看不到是哪几个视频，
 * 也没法只重试它们，只能重新拖一遍整批。
 */
export default function VideoBatchImport({ projectId, files, onClose, onCreated }: {
  projectId: string; files: string[]; onClose: () => void; onCreated: (result: BatchVideoResult) => void;
}) {
  const [items, setItems] = useState<BatchItem[]>(() => files.map(path => ({ path, name: baseName(path), state: { kind: 'pending' } })));
  const [running, setRunning] = useState(false), [stopped, setStopped] = useState(false);
  const [density, setDensity] = useState<VideoDensity>('standard');
  const [customMode, setCustomMode] = useState<'interval' | 'every_n' | 'fps'>('interval');
  const [customValue, setCustomValue] = useState('1');
  const cancelled = useRef(false);
  // 面板可能跑多轮（先失败、后重试），已建成的任务必须累计，不能只留最后一轮。
  const created = useRef<MediaJob[]>([]);
  const patch = (path: string, state: BatchItemState) => setItems(list => list.map(item => item.path === path ? { ...item, state } : item));
  async function start() {
    cancelled.current = false;
    setRunning(true); setStopped(false);
    const pending = remainingBatchItems(items);
    const failures: BatchFailure[] = [];
    let abandoned = 0;
    for (const item of pending) {
      if (cancelled.current) break;
      try {
        patch(item.path, { kind: 'working', label: '正在检查…' });
        const inspection = await retryWhileMediaBusy(
          () => request<VideoInspection>('media.video.inspect', { sourcePath: item.path }),
          { shouldStop: () => cancelled.current, onBusy: () => patch(item.path, { kind: 'working', label: '等待当前媒体任务结束，随后自动继续…' }) }
        );
        if (!inspection || cancelled.current) break;
        const plan = batchExtractionPlan(inspection, { density, customMode, customValue: Number(customValue) });
        if ('error' in plan) { patch(item.path, { kind: 'failed', error: plan.error }); failures.push({ path: item.path, name: item.name, error: plan.error }); continue; }
        patch(item.path, { kind: 'working', label: '正在创建任务…' });
        const job = await request<MediaJob>('media.video.create', { projectId, sourcePath: item.path, expectedSourceHash: inspection.sourceHash, parameters: plan.parameters });
        created.current.push(job);
        patch(item.path, { kind: 'queued', note: plan.note });
      } catch (e) {
        const message = errorMessage(e);
        patch(item.path, { kind: 'failed', error: message });
        failures.push({ path: item.path, name: item.name, error: message });
      }
      abandoned++;
    }
    setRunning(false);
    const halted = cancelled.current;
    if (halted) setStopped(true);
    // 收尾只在一切都如愿时发生：有任何失败或被停止就留在面板里（错误明细与「只重试失败项」就在这里）。
    const settled = !halted && !failures.length && abandoned === pending.length;
    if (created.current.length && settled) onCreated({ jobs: created.current, failed: 0, stopped: false, failedItems: [], unfinished: [] });
  }
  // 关闭与取消都走这里：已经建过任务就必须把结果（含失败明细）交给调用方，否则队列不会有人推进。
  function close() {
    if (running) return;
    if (created.current.length) onCreated({ jobs: created.current, failed: batchOutcome(items).failed, stopped, failedItems: batchFailures(items), unfinished: remainingBatchItems(items).map(item => item.path) });
    else onClose();
  }
  const { queued, failed, pending } = batchOutcome(items);
  // 已经建过任务的视频不再重复发起：全部排完队后只剩「关闭」。
  const remaining = remainingBatchItems(items);
  const retryOnly = failed > 0 && pending === 0;
  const summary = !running && (queued || failed)
    ? `已创建 ${queued} 个抽帧任务${failed ? `，${failed} 个未能创建（原因见各条目，可只重试这几个）` : ''}。${stopped ? '未处理的部分已停止，已创建的任务继续在后台执行。' : ''}`
    : '';
  return <Modal title={`一键抽帧（${items.length} 个视频）`} onClose={close}>
    <div className="form-stack">
      <p className="muted tiny">整批视频共用同一采样策略；超过单视频帧数上限的条目会显示失败原因。输出 PNG，超高清自动缩到长边 {VIDEO_DOWNSAMPLE_LONG_EDGE} 像素。任务在引擎里排队逐个执行，素材就绪后自动导入项目。</p>
      <div className="field-grid">
        <Field label="采样密度"><select aria-label="批量视频采样密度" disabled={running} value={density} onChange={e => setDensity(e.target.value as VideoDensity)}>{(Object.keys(VIDEO_DENSITY_LABELS) as VideoDensity[]).map(key => <option key={key} value={key}>{VIDEO_DENSITY_LABELS[key]}</option>)}</select></Field>
        {density === 'custom' && <Field label="采样方式"><select aria-label="批量视频采样方式" disabled={running} value={customMode} onChange={e => { const next = e.target.value as typeof customMode; setCustomMode(next); setCustomValue(next === 'every_n' ? '10' : '1'); }}><option value="interval">每隔指定秒数</option><option value="every_n">每 N 个源帧</option><option value="fps">按目标帧率</option></select></Field>}
      </div>
      {density === 'custom' && <Field label={customMode === 'interval' ? '间隔（秒）' : customMode === 'every_n' ? '源帧间隔 N' : '目标帧率（帧/秒）'}><input aria-label="批量视频采样值" type="number" min={customMode === 'every_n' ? 1 : 0.001} max={customMode === 'every_n' ? 1000000 : customMode === 'fps' ? 240 : VIDEO_MAX_RANGE_SECONDS} step={customMode === 'every_n' ? 1 : 'any'} disabled={running} value={customValue} onChange={e => setCustomValue(e.target.value)} /></Field>}
      {density === 'scene' && <p className="muted tiny">每 {VIDEO_SCENE_MIN_INTERVAL_SECONDS} 秒检查一个候选帧，仅保留与上一张保留帧差异明显的画面；静止或相似画面可能被跳过。</p>}
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
            <Button onClick={close}>{created.current.length ? '关闭' : '取消'}</Button>
            {remaining.length > 0 && <Button className="primary" disabled={isDemo} onClick={() => void start()}>
              {retryOnly ? `只重试这 ${failed} 个失败项` : `开始抽帧（${remaining.length} 个）`}
            </Button>}
          </>}
      </div>
    </div>
  </Modal>;
}
