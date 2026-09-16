import { useCallback, useEffect, useState } from 'react';
import { ListTodo, RefreshCw, Play, Pause, Square, RotateCcw, ArrowUpRight, Clock3, Activity, X, ChevronRight, FlaskConical, FolderInput, MessageSquare } from 'lucide-react';
import type { TrainingJob } from '../../shared/training';
import { TRAINING_JOB_STATUS, activeTrainingJob } from '../../shared/training';
import { useApp } from './context';
import { taskOrigin } from './AgentActivity';
import { useActiveTaskCount } from './activeTasks';
import { request, isDemo, errorMessage } from './bridge';
import { Button, Empty, IconButton, PageHeader, SearchField } from './ui';
import { statusNames, type Run } from './types';
import QualityCenter from './QualityCenter';
import { BudgetEditor } from './CostControls';
import FlowRuns from './FlowRuns';
import MediaJobs from './MediaJobs';
import VideoTimeline from './VideoTimeline';
import ReuseProvenance from './ReuseProvenance';
import InputReuseSource from './InputReuseSource';
import { eventName } from './eventNames';
import ModelInputResult, { InputProgressView } from './ModelInputResult';
import type { ExportRecord } from './ExportDialog';

const stageNames: Record<string,string> = { preparing:'准备输入',sending:'发送请求',waiting:'等待模型响应',parsing:'解析结果',validating:'校验标注',saving:'保存结果',retry_wait:'等待重试',...statusNames };
const exportStatusNames: Record<string,string> = { completed:'已完成', failed:'失败', cancelled:'已取消', running:'导出中' };
type TaskKind = 'flow' | 'annotation' | 'media' | 'training' | 'export' | 'tracks';
/**
 * 六类任务的职责边界。看板只负责「现在跑着什么、卡在哪里」；发起、改参数与重试都在对话里说，
 * 因此这里没有创建入口，只有状态、进度、失败原因与回到来源会话的跳转。
 */
const kindNotes: Record<TaskKind, string> = {
  flow: '自动流程：按对话里确认过的步骤自动跑标注；运行状态与实际事件在这里回看。',
  annotation: '标注任务：一次标注执行的状态、逐样本结果与已发送的请求数。',
  media: '素材任务：视频抽帧与素材筛选等原料加工；抽帧完成后即可开始标注。',
  training: '模型训练：在对话里说明用哪份数据、训练多少轮即可提交；这里回看数据集快照、设备与逐轮指标，失败与中断不会自动重跑。',
  export: '数据导出：已完成的导出副本与清单标识，复现导出请在对话里说明。',
  tracks: '轨迹标注：视频时间轴上的对象轨迹、关键帧与待复核候选。'
};
export default function Tasks() {
  const { events, engine, notify, navigate, assets, project, mediaTaskId, setActiveSessionId } = useApp();
  const [kind, setKind] = useState<TaskKind>(mediaTaskId ? 'media' : 'flow');
  useEffect(() => { if (mediaTaskId) setKind('media'); }, [mediaTaskId]);
  const [runs,setRuns]=useState<Run[]>([]);
  const [quality,setQuality]=useState(false);
  const [selected,setSelected]=useState<Run|null>(null);
  const [filter,setFilter]=useState('all'); const [search,setSearch]=useState('');
  const [busy,setBusy]=useState(false); const [loading,setLoading]=useState(true); const [error,setError]=useState('');
  const activeTasks = useActiveTaskCount();
  const refresh=useCallback(async()=>{setLoading(true);try{const result=await request<Run[]>('run.list');setRuns(result);setError('');}catch(e){setError(errorMessage(e));}finally{setLoading(false);}},[]);
  useEffect(()=>{void refresh();},[refresh]);
  useEffect(()=>{if(!events.length)return;const timer=setTimeout(()=>{void refresh();if(selected)void request<Run>('run.get',{runId:selected.id}).then(setSelected).catch(()=>{});},180);return()=>clearTimeout(timer);},[events.at(-1)?.sequence,selected?.id,refresh]);
  async function control(action:string){if(!selected)return;setBusy(true);try{const payload:Record<string,unknown>={runId:selected.id};if(action==='retry')payload.assetIds=(selected.samples??[]).filter(sample=>sample.status==='failed').map(sample=>sample.assetId);const run=await request<Run>(`run.${action}`,payload);setSelected(run);await refresh();notify(`操作已提交，任务状态：${stageNames[run.status]??run.status}。`);}catch(e){notify(errorMessage(e),true);}finally{setBusy(false);}}
  /** 回到发起这段任务的会话：任务记录里没有对话标识，靠发起时记下的对应关系跳转。 */
  async function backToSession(taskId:string){const sessionId=taskOrigin(taskId);if(!sessionId){notify('这段任务不是从对话发起的，没有可跳回的会话。');return;}setActiveSessionId(sessionId);await navigate('chat');}
  async function askInChat(){await navigate('chat');document.querySelector<HTMLTextAreaElement>('.chat-panel textarea, .chat-home textarea')?.focus();}
  const visible=runs.filter(run=>(filter==='all'||(filter==='active'?['running','queued','paused','needs_attention'].includes(run.status):['completed','completed_with_errors','succeeded','failed','cancelled','partial'].includes(run.status)))&&`${run.model} ${run.id}`.toLowerCase().includes(search.toLowerCase()));
  const recent=events.filter(e=>!selected||e.runId===selected.id).slice(-35).reverse();
  return <div className="content tasks-page">{quality&&<QualityCenter onClose={()=>setQuality(false)}/>}<PageHeader title="任务" description={engine.state==='ready'?`只读进度看板${activeTasks?` · ${activeTasks} 个任务进行中`:''}：状态、进度与失败原因都来自引擎记录，发起与改参数请在对话里说明。`:'本地引擎未就绪，暂时读不到任务状态。'} actions={<><Button onClick={()=>setQuality(true)}>评测与复核</Button>{kind==='annotation'&&<Button busy={loading} disabled={loading} onClick={()=>void refresh()}><RefreshCw size={14}/>刷新标注任务</Button>}<Button className="primary" onClick={()=>void askInChat()}><MessageSquare size={14}/>在对话里发起任务</Button></>}/>
    <div className="tabs task-kind-tabs"><button className={kind==='flow'?'selected':''} onClick={()=>setKind('flow')}>自动流程</button><button className={kind==='annotation'?'selected':''} onClick={()=>setKind('annotation')}>标注任务</button><button className={kind==='media'?'selected':''} onClick={()=>setKind('media')}>素材任务</button><button className={kind==='training'?'selected':''} onClick={()=>setKind('training')}>模型训练</button><button className={kind==='export'?'selected':''} onClick={()=>setKind('export')}>数据导出</button><button className={kind==='tracks'?'selected':''} disabled={!project||!['detect','pose'].includes(project.taskType)} onClick={()=>setKind('tracks')}>轨迹标注</button></div>
    <p className="muted tiny task-kind-note">{kindNotes[kind]}</p>
    {kind==='tracks'?project&&<VideoTimeline key={project.id} project={project} tasksOnly/>
      :kind==='flow'?<FlowRuns projectId={project?.id}/>
      :kind==='media'?<MediaJobs initialJobId={mediaTaskId}/>
      :kind==='training'?<TrainingBoard onBack={taskId=>void backToSession(taskId)}/>
      :kind==='export'?<ExportBoard onBack={taskId=>void backToSession(taskId)}/>
      :<><div className="section-toolbar"><div className="tabs">{[['all','全部任务'],['active','进行中'],['done','已结束']].map(([key,label])=><button key={key} className={filter===key?'selected':''} onClick={()=>setFilter(key)}>{label}</button>)}</div><SearchField placeholder="搜索模型或任务" value={search} onChange={setSearch}/></div>
    {error&&<p role="alert" className="inline-error">{error}</p>}
    <div className="tasks-layout"><div className="tasks-main">{loading?<div className="page-loading tasks-loading" role="status"><RefreshCw size={18} className="spin"/>正在读取标注任务…</div>:visible.length?<div className="run-list">{visible.map(run=>{const s=run.statistics??{};const total=s.total??run.total??0;const completed=s.completed??0;return <button key={run.id} data-status={run.status} className={`run-row ${selected?.id===run.id?'selected':''}`} onClick={()=>void request<Run>('run.get',{runId:run.id}).then(setSelected).catch(e=>notify(errorMessage(e),true))}><div className="run-icon"><Activity size={20}/></div><div className="run-summary"><strong>{String(run.name??run.model??'标注任务')}{run.kind==='local'&&' · 本地模型'}</strong><p>{run.createdAt?new Date(run.createdAt).toLocaleString('zh-CN'):'创建时间未知'}</p><div className="progress"><span style={{width:`${total?Math.min(100,completed/total*100):0}%`}}/></div><small>完成 {completed} / {total} · 成功 {s.succeeded??0}（含复用 {s.reused??0}）· 失败 {s.failed??0} · 已发送请求 {s.requestsUsed??'未知'}</small><InputProgressView statistics={s}/></div><span className="tiny-badge">{stageNames[run.status]??run.status}</span></button>;})}</div>:<Empty icon={<ListTodo size={28}/>} title="还没有运行任务" description={isDemo?'当前是浏览器演示，不生成模拟任务或进度。':'在对话里说明要标注哪些图片，助手会先预检再提交。'}><Button onClick={()=>void askInChat()}>去对话里发起<ArrowUpRight size={14}/></Button></Empty>}
      {selected&&<section className="run-detail" data-status={selected.status}><div className="section-toolbar"><h2>任务详情</h2><div className="actions">{taskOrigin(selected.id)&&<Button onClick={()=>void backToSession(selected.id)}><ChevronRight size={14}/>回到发起会话</Button>}<IconButton label="关闭任务详情" onClick={()=>setSelected(null)}><X size={15}/></IconButton></div></div><div className="run-control-strip"><div className="run-status-chip" role="status" aria-live="polite" data-active={['running','queued','paused'].includes(selected.status)}><span className={`status-dot ${selected.status==='running'? 'starting' : ''}`} /><span>{stageNames[selected.status] ?? selected.status}</span></div><div className="run-controls"><Button busy={busy} disabled={!['running','queued'].includes(selected.status)} onClick={()=>void control('pause')}><Pause size={13}/>暂停</Button><Button busy={busy} disabled={selected.status!=='paused'} onClick={()=>void control('resume')}><Play size={13}/>恢复</Button><Button busy={busy} disabled={!['running','paused','queued'].includes(selected.status)} onClick={()=>void control('cancel')}><Square size={12}/>取消</Button><Button busy={busy} disabled={!(selected.statistics?.failed)} onClick={()=>void control('retry')}><RotateCcw size={13}/>重试失败样本</Button></div></div><p className="muted">{selected.kind==='local'?'本地模型任务不发送云端标注请求；执行与停止状态以引擎返回为准。':'已发送请求不能保证在远端撤销。结果未知的请求不会通过“重试失败样本”自动重发。'}</p><InputProgressView statistics={selected.statistics}/>{selected.kind==='local'&&<p className="muted tiny">固定模型版本：{selected.modelVersion??'未报告'} · 请求设备：{selected.device??'未报告'}</p>}<div className="run-counts">{[['在途请求','inFlight'],['已发送请求','requestsUsed'],['成功中复用','reused'],['等待重试','retry_wait'],['结果未知','unknown']].map(([label,key])=><div key={key}><span>{label}</span><strong>{selected.statistics?.[key]??'未知'}</strong></div>)}</div>{typeof selected.budgetScopeId==='string'&&<BudgetEditor key={selected.id} scopeId={selected.budgetScopeId}/>}<div className="sample-table"><div className="sample-row table-head"><span>样本</span><span>当前状态</span></div>{selected.samples?.map((sample,index)=><div className="sample-row" key={sample.id??`${sample.assetId}-${sample.inputId??index}`}><span>{sample.name??assets.find(a=>a.id===sample.assetId)?.name??sample.assetId}{sample.inputId&&<small className="sample-input-label">模型输入 {index+1}</small>}</span><span>{stageNames[sample.status]??sample.status}{sample.reused && (sample.inputReusedFrom ? ' · 输入结果复用（0 次 API 请求）' : ' · 复用成功（本样本 0 请求）')}</span>{(sample.inputId||sample.resultId)&&<div className="sample-input-action"><ModelInputResult inputId={sample.inputId} resultId={sample.resultId} name={sample.name??assets.find(a=>a.id===sample.assetId)?.name??'模型输入'}/></div>}{sample.inputReusedFrom ? <InputReuseSource source={sample.inputReusedFrom}/> : sample.reused && <ReuseProvenance source={sample.reusedFrom}/>}</div>)}</div></section>}
    </div><aside className="event-panel"><div className="section-toolbar"><h2>最近事件</h2><Clock3 size={14}/></div><p className="event-connection"><span className={`status-dot ${engine.state}`}/>{isDemo?'演示模式 · 未连接事件流':engine.state==='ready'?'引擎已连接':'事件连接中断'}</p>{recent.length?<ol className="timeline">{recent.map(event=><li key={event.sequence}><span className="event-dot"/><div><strong>{eventName(event.type)}</strong><time>{new Date(event.timestamp).toLocaleTimeString('zh-CN')}</time><details><summary>查看事件内容</summary><p className="event-raw-type">原始类型：{event.type}</p><pre>{JSON.stringify(event.payload,null,2)}</pre></details></div></li>)}</ol>:<div className="quiet-empty">暂无引擎事件<p>执行后将记录真实状态变化。</p></div>}</aside></div>
  </>} </div>;
}

/** 训练任务：只看状态、进度、指标与失败原因；重试与登记权重在对话里说明。 */
function TrainingBoard({ onBack }: { onBack: (taskId: string) => void }) {
  const { events } = useApp();
  const [jobs, setJobs] = useState<TrainingJob[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    setLoading(true);
    try { const result = await request<{ items: TrainingJob[]; total: number }>('training.job.list', { limit: 100 }); setJobs(result.items); setTotal(result.total); setError(''); }
    catch (e) { setError(errorMessage(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { const timer = window.setTimeout(() => { void refresh(); }, 1200); return () => window.clearTimeout(timer); }, [events.at(-1)?.sequence, refresh]);
  if (error) return <p role="alert" className="inline-error">{error}</p>;
  if (loading && !jobs.length) return <div className="page-loading" role="status"><RefreshCw size={18} className="spin" />正在读取训练任务…</div>;
  if (!jobs.length) return <Empty icon={<FlaskConical size={28}/>} title="还没有训练任务" description="在对话里说明用哪份数据训练，助手会先预检再提交。" />;
  return <div className="board-list">
    {jobs.map(job => { const best = job.bestMetrics?.mAP50; const live = activeTrainingJob(job.status);
      return <article key={job.id} className="board-row" data-status={job.status}>
        <span className="board-icon"><FlaskConical size={18} /></span>
        <div className="board-main">
          <strong>{job.snapshotHash ? `快照 ${job.snapshotHash.slice(0, 12)}…` : '训练任务'} · {job.actualDevice ?? job.device ?? '未定设备'}</strong>
          <p className="muted tiny">
            {job.createdAt ? `${new Date(job.createdAt).toLocaleString('zh-CN')} · ` : ''}
            {job.progressKnown ? `已完成 ${job.completedEpochs ?? 0}/${job.epochs ?? 0} 轮` : '尚未产生训练轮次'}
            {best === undefined ? '' : ` · 最优 mAP50 ${best.toFixed(4)}`}
            {job.etaSeconds && live ? ` · 估算剩余 ${Math.round(job.etaSeconds / 60)} 分钟` : ''}
          </p>
          {job.progressKnown && <div className="training-progress" aria-label="训练进度"><span style={{ width: `${Math.round(job.progress * 100)}%` }} /></div>}
          {job.error && <p className="muted tiny">{job.error.code}：{job.error.message}</p>}
        </div>
        <span className={`training-badge ${job.status}`}>{TRAINING_JOB_STATUS[job.status]}</span>
        {taskOrigin(job.id) && <IconButton label="回到发起这段任务的会话" onClick={() => onBack(job.id)}><ChevronRight size={15} /></IconButton>}
      </article>; })}
    {total > jobs.length && <p className="muted tiny">还有 {total - jobs.length} 条更早的训练未显示。</p>}
  </div>;
}

/** 导出记录：只读清单标识与规模；复现导出需要用户在保存对话框里重新授权目录。 */
function ExportBoard({ onBack }: { onBack: (taskId: string) => void }) {
  const { project } = useApp();
  const [records, setRecords] = useState<ExportRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    if (!project) { setRecords([]); setLoading(false); return; }
    setLoading(true);
    try { setRecords(await request<ExportRecord[]>('export.list', { projectId: project.id })); setError(''); }
    catch (e) { setError(errorMessage(e)); }
    finally { setLoading(false); }
  }, [project?.id]);
  useEffect(() => { void refresh(); }, [refresh]);
  if (!project) return <Empty icon={<FolderInput size={28}/>} title="还没有打开项目" description="导出记录按项目保存，先打开一个项目或从对话开始。" />;
  if (error) return <p role="alert" className="inline-error">{error}</p>;
  if (loading && !records.length) return <div className="page-loading" role="status"><RefreshCw size={18} className="spin" />正在读取导出记录…</div>;
  if (!records.length) return <Empty icon={<FolderInput size={28}/>} title="这个项目还没有导出记录" description="在对话里说明导出范围与格式即可。" />;
  return <div className="board-list">
    {records.map(record => <article key={record.id} className="board-row" data-status={record.status}>
      <span className="board-icon"><FolderInput size={18} /></span>
      <div className="board-main">
        <strong>{record.taskType} · {record.assetCount ?? '?'} 张</strong>
        <p className="muted tiny">{record.createdAt ? new Date(record.createdAt).toLocaleString('zh-CN') : '时间未记录'}
          {record.manifestHash ? ` · 清单 ${record.manifestHash.slice(0, 12)}…` : ''}{record.sourceExportId ? ' · 复现自历史导出' : ''}</p>
      </div>
      <span className={`training-badge ${record.status}`}>{exportStatusNames[record.status] ?? record.status}</span>
      {taskOrigin(record.id) && <IconButton label="回到发起这段任务的会话" onClick={() => onBack(record.id)}><ChevronRight size={15} /></IconButton>}
    </article>)}
  </div>;
}
