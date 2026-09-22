import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ListTodo, RefreshCw, Play, Pause, Square, RotateCcw, ArrowUpRight, Clock3, Activity, X, ChevronRight, FlaskConical, FolderInput, MessageSquare } from 'lucide-react';
import type { TrainingJob } from '../../shared/training';
import { TRAINING_JOB_STATUS, activeTrainingJob } from '../../shared/training';
import { useApp } from './context';
import { taskOrigin } from './AgentActivity';
import { useActiveTaskCount } from './activeTasks';
import { request, isDemo, errorMessage, getBridge } from './bridge';
import { Button, Empty, IconButton, Modal, Notice, PageHeader, SearchField } from './ui';
import { statusNames, type Run } from './types';
import QualityCenter from './QualityCenter';
import { BudgetEditor } from './CostControls';
import FlowRuns from './FlowRuns';
import { Term } from './Term';
import MediaJobs from './MediaJobs';
import VideoTimeline from './VideoTimeline';
import ReuseProvenance from './ReuseProvenance';
import InputReuseSource from './InputReuseSource';
import { eventName } from './eventNames';
import ModelInputResult, { InputProgressView } from './ModelInputResult';
import { formatModelBytes } from '../../shared/model-library';
import type { ExportRecord } from './ExportDialog';

const stageNames: Record<string,string> = { preparing:'准备输入',sending:'发送请求',waiting:'等待模型响应',parsing:'解析结果',validating:'校验标注',saving:'保存结果',retry_wait:'等待重试',...statusNames };
/**
 * 实发尺寸与体积：同一张 4K 帧按原图发是 3 MB 级、按长边 1920 发是 0.3 MB 级，
 * 这一行是「为什么快 / 为什么超时」最直接的依据，也是发送副本真的生效的证据。
 */
const payloadNote=(run:Run)=>{const value=run.payloadActual as {width?:number;height?:number;bytes?:number;sourceBytes?:number;derived?:boolean}|undefined;
  if(!value?.width||!value?.height)return '';
  return value.derived?` · 实发 ${value.width}×${value.height} JPEG ${formatModelBytes(value.bytes??0)}（原始 ${formatModelBytes(value.sourceBytes??0)}）`
    :` · 实发原图 ${value.width}×${value.height}（${formatModelBytes(value.bytes??0)}）`;};
const exportStatusNames: Record<string,string> = { completed:'已完成', failed:'失败', cancelled:'已取消', running:'导出中' };
type TaskKind = 'flow' | 'annotation' | 'media' | 'training' | 'export' | 'tracks';
/**
 * 六类任务的职责边界。看板只负责「现在跑着什么、卡在哪里」；发起、改参数与重试都在对话里说，
 * 因此这里没有创建入口，只有状态、进度、失败原因与回到来源会话的跳转。
 */
const kindNotes: Record<TaskKind, ReactNode> = {
  flow: <>自动流程：按对话里确认过的步骤自动跑标注；本次<Term name="run" />的状态与实际事件在这里回看。</>,
  annotation: '标注任务：一次标注执行的状态、逐样本结果与已发送的请求数。',
  media: <>素材任务：<Term name="frameExtract" />与素材筛选等原料加工；视频拆成图片后就能像普通素材一样标注。</>,
  training: <>模型训练：在对话里说明用哪份数据、训练多少轮即可提交；这里回看冻结的数据快照、设备与逐轮指标，失败与中断不会自动重跑。</>,
  export: '数据导出：已完成的导出副本与清单标识，复现导出请在对话里说明。',
  tracks: <>轨迹标注：视频时间轴上的<Term name="tracks" />、关键帧与待复核候选。</>
};
export default function Tasks() {
  const { events, engine, notify, navigate, assets, project, mediaTaskId, setActiveSessionId } = useApp();
  const [kind, setKind] = useState<TaskKind>(mediaTaskId ? 'media' : 'flow');
  useEffect(() => { if (mediaTaskId) setKind('media'); }, [mediaTaskId]);
  const [runs,setRuns]=useState<Run[]>([]);
  const [quality,setQuality]=useState(false);
  const [selected,setSelected]=useState<Run|null>(null);
  const [filter,setFilter]=useState('all'); const [search,setSearch]=useState('');
  const [busy,setBusy]=useState(false); const [loading,setLoading]=useState(true); const [error,setError]=useState(''); const [reconnecting,setReconnecting]=useState(false);
  /** 「重试未知样本」的二次确认：未知名义上结果不明，重发可能重复计费，必须由用户明确点过才算授权。 */
  const [retryingUnknown,setRetryingUnknown]=useState(false);
  const activeTasks = useActiveTaskCount();
  const refresh=useCallback(async()=>{if(isDemo||engine.state!=='ready'){setRuns([]);setError('');setLoading(false);return;}setLoading(true);try{const result=await request<Run[]>('run.list');setRuns(result);setError('');}catch(e){setError(errorMessage(e));}finally{setLoading(false);}},[engine.state]);
  useEffect(()=>{void refresh();},[refresh]);
  useEffect(()=>{if(!events.length||isDemo||engine.state!=='ready')return;const timer=setTimeout(()=>{void refresh();if(selected)void request<Run>('run.get',{runId:selected.id,sampleLimit:200}).then(setSelected).catch(()=>{});},180);return()=>clearTimeout(timer);},[events.at(-1)?.sequence,selected?.id,refresh,engine.state]);
  /**
   * 运行控制。重试的样本集合按状态显式挑选：
   * 引擎默认只重发 failed，结果未知的样本必须带 `retryUnknown: true` 才会被重新发送——
   * 原请求可能已在服务商那边处理或计费，所以这条路径只由用户点过二次确认的入口触发。
   */
  async function control(action:string,options:{retryUnknown?:boolean}={}){if(!selected)return;setBusy(true);try{
    const payload:Record<string,unknown>={runId:selected.id};
    if(action==='retry'){
      const statuses=options.retryUnknown?['failed','unknown']:['failed'];
      // 重试要的是全量失败/未知样本的身份：按大页签单独取一次，不用把详情页常驻在 5000 条上。
      const full=await request<Run>('run.get',{runId:selected.id,sampleLimit:5000});
      payload.assetIds=(full.samples??[]).filter(sample=>statuses.includes(sample.status)).map(sample=>sample.assetId);
      if(options.retryUnknown)payload.retryUnknown=true;
    }
    const run=await request<Run>(`run.${action}`,payload);setSelected(run);setRetryingUnknown(false);await refresh();notify(`操作已提交，任务状态：${stageNames[run.status]??run.status}。`);}catch(e){notify(errorMessage(e),true);}finally{setBusy(false);}}
  /** 回到发起这段任务的会话：任务记录里没有对话标识，靠发起时记下的对应关系跳转。 */
  async function backToSession(taskId:string){const sessionId=taskOrigin(taskId);if(!sessionId){notify('这段任务不是从对话发起的，没有可跳回的会话。');return;}setActiveSessionId(sessionId);await navigate('chat');}
  async function askInChat(){await navigate('chat');document.querySelector<HTMLTextAreaElement>('.chat-panel textarea, .chat-home textarea')?.focus();}
  async function reconnect(){if(isDemo||reconnecting)return;setReconnecting(true);try{const status=await (await getBridge()).restartEngine();notify(status.message??(status.state==='ready'?'引擎已连接。':'引擎尚未就绪。'),status.state!=='ready');}catch(e){notify(errorMessage(e),true);}finally{setReconnecting(false);}}
  const visible=runs.filter(run=>(filter==='all'||(filter==='active'?['running','queued','paused','needs_attention'].includes(run.status):['completed','completed_with_errors','succeeded','failed','cancelled','partial'].includes(run.status)))&&`${run.model} ${run.id}`.toLowerCase().includes(search.toLowerCase()));
  const recent=events.filter(e=>!selected||e.runId===selected.id).slice(-35).reverse();
  // 失败与未知分开计数：界面上「重试失败样本」按失败数启用，未知结果走独立入口，避免 both>0 时按钮语义含混。
  const failedCount=selected?.statistics?.failed??0;
  const unknownCount=selected?.statistics?.unknown??0;
  const engineUnavailable=isDemo||engine.state!=='ready';
  return <div className="content tasks-page">{quality&&<QualityCenter onClose={()=>setQuality(false)}/>}<PageHeader title="任务" description={engineUnavailable?'本地引擎未就绪，暂时读不到任务状态。':`只读进度看板${activeTasks?` · ${activeTasks} 个任务进行中`:''}：状态、进度与失败原因都来自引擎记录，发起与改参数请在对话里说明。`} actions={<><Button onClick={()=>setQuality(true)}>评测与复核</Button>{!engineUnavailable&&kind==='annotation'&&<Button busy={loading} disabled={loading} onClick={()=>void refresh()}><RefreshCw size={14}/>刷新标注任务</Button>}<Button className="primary" onClick={()=>void askInChat()}><MessageSquare size={14}/>在对话里发起任务</Button></>}/>
    {engineUnavailable?<section className="engine-gate tasks-engine-gate" role="status" aria-live="polite"><div className={`engine-gate-icon ${engine.state==='starting'?'is-checking':'is-error'}`}><RefreshCw size={20}/></div><div className="engine-gate-copy"><strong>{isDemo?'浏览器演示不会连接本地引擎':engine.state==='starting'?'正在连接本地引擎':'任务状态暂时不可用'}</strong><p>{isDemo?'这里展示真实桌面版的任务看板结构；要执行任务，请在桌面版打开项目。':engine.message??'本地引擎没有返回可用状态，任务不会在后台悄悄失败。'}</p></div><div className="engine-gate-actions">{!isDemo&&<Button className="primary" busy={reconnecting} onClick={()=>void reconnect()}><RefreshCw size={14}/>重新连接</Button>}<Button onClick={()=>void navigate('settings','diagnostics')}>打开诊断</Button><Button onClick={()=>void askInChat()}>回到对话</Button></div></section>:<><div className="tabs task-kind-tabs"><button className={kind==='flow'?'selected':''} onClick={()=>setKind('flow')}>自动流程</button><button className={kind==='annotation'?'selected':''} onClick={()=>setKind('annotation')}>标注任务</button><button className={kind==='media'?'selected':''} onClick={()=>setKind('media')}>素材任务</button><button className={kind==='training'?'selected':''} onClick={()=>setKind('training')}>模型训练</button><button className={kind==='export'?'selected':''} onClick={()=>setKind('export')}>数据导出</button><button className={kind==='tracks'?'selected':''} disabled={!project||!['detect','pose'].includes(project.taskType)} title={!project?'先打开一个项目后可用':!['detect','pose'].includes(project.taskType)?'仅检测框与关键点项目支持轨迹标注':''} onClick={()=>setKind('tracks')}>轨迹标注{!project||!['detect','pose'].includes(project.taskType)?'（仅检测/关键点项目）':''}</button></div>
    <p className="muted tiny task-kind-note">{kindNotes[kind]}</p>
    {kind==='tracks'?project&&<VideoTimeline key={project.id} project={project} tasksOnly/>
      :kind==='flow'?<FlowRuns projectId={project?.id}/>
      :kind==='media'?<MediaJobs initialJobId={mediaTaskId}/>
      :kind==='training'?<TrainingBoard onBack={taskId=>void backToSession(taskId)}/>
      :kind==='export'?<ExportBoard onBack={taskId=>void backToSession(taskId)}/>
      :<><div className="section-toolbar"><div className="tabs">{[['all','全部任务'],['active','进行中'],['done','已结束']].map(([key,label])=><button key={key} className={filter===key?'selected':''} onClick={()=>setFilter(key)}>{label}</button>)}</div><SearchField placeholder="搜索模型或任务" value={search} onChange={setSearch}/></div>
    {error&&<p role="alert" className="inline-error">{error}</p>}
    <div className="tasks-layout"><div className="tasks-main">{loading?<div className="page-loading tasks-loading" role="status"><RefreshCw size={18} className="spin"/>正在读取标注任务…</div>:visible.length?<div className="run-list">{visible.map(run=>{const s=run.statistics??{};const total=s.total??run.total??0;const completed=s.completed??0;return <button key={run.id} data-status={run.status} className={`run-row ${selected?.id===run.id?'selected':''}`} onClick={()=>void request<Run>('run.get',{runId:run.id,sampleLimit:200}).then(setSelected).catch(e=>notify(errorMessage(e),true))}><div className="run-icon"><Activity size={20}/></div><div className="run-summary"><strong>{String(run.name??run.model??'标注任务')}{run.kind==='local'&&' · 本地模型'}</strong><p>{run.createdAt?new Date(run.createdAt).toLocaleString('zh-CN'):'创建时间未知'}</p><div className="progress"><span style={{width:`${total?Math.min(100,completed/total*100):0}%`}}/></div><small>完成 {completed} / {total} · 成功 {s.succeeded??0}（含复用 {s.reused??0}）· 失败 {s.failed??0} · 已发送请求 {s.requestsUsed??'未知'}{payloadNote(run)}</small><InputProgressView statistics={s}/></div><span className="tiny-badge">{stageNames[run.status]??run.status}</span></button>;})}</div>:<Empty icon={<ListTodo size={28}/>} title="还没有运行任务" description={isDemo?'当前是浏览器演示，不生成模拟任务或进度。':'在对话里说明要标注哪些图片，助手会先预检再提交。'}><Button onClick={()=>void askInChat()}>去对话里发起<ArrowUpRight size={14}/></Button></Empty>}
      {selected&&<section className="run-detail" data-status={selected.status}><div className="section-toolbar"><h2>任务详情</h2><div className="actions">{taskOrigin(selected.id)&&<Button onClick={()=>void backToSession(selected.id)}><ChevronRight size={14}/>回到发起会话</Button>}<IconButton label="关闭任务详情" onClick={()=>setSelected(null)}><X size={15}/></IconButton></div></div><div className="run-control-strip"><div className="run-status-chip" role="status" aria-live="polite" data-active={['running','queued','paused'].includes(selected.status)}><span className={`status-dot ${selected.status==='running'? 'starting' : ''}`} /><span>{stageNames[selected.status] ?? selected.status}</span></div><div className="run-controls"><Button busy={busy} disabled={!['running','queued'].includes(selected.status)} onClick={()=>void control('pause')}><Pause size={13}/>暂停</Button><Button busy={busy} disabled={selected.status!=='paused'} onClick={()=>void control('resume')}><Play size={13}/>恢复</Button><Button busy={busy} disabled={!['running','paused','queued'].includes(selected.status)} onClick={()=>void control('cancel')}><Square size={12}/>取消</Button><Button busy={busy} disabled={!failedCount} onClick={()=>void control('retry')}><RotateCcw size={13}/>重试失败样本</Button><Button busy={busy} disabled={!unknownCount} onClick={()=>setRetryingUnknown(true)}><RotateCcw size={13}/>重试未知样本（{unknownCount}）</Button></div></div>{selected.status==='needs_attention'&&<section className="run-next-steps"><h3>这一步需要你决定</h3><div className="actions">{unknownCount>0&&<Button className="primary" onClick={()=>setRetryingUnknown(true)}>重试未知样本（{unknownCount}）</Button>}<Button onClick={()=>{if(!project){notify('先打开一个项目，导出按项目进行。',true);return;}void navigate('overview').then(()=>notify('未完成的样本保持「结果未知」；在概览里点「导出」，未标注的素材可以在导出面板一键剔除。'));}}>先不管未完成的，去导出</Button><Button onClick={()=>void askInChat()}>在对话里说明怎么处理</Button></div><p className="muted tiny">未完成的样本不会按「无目标图片」处理，也不会自动重发。要让助手把源图缩小后再跑一遍，就在对话里说明。</p></section>}{unknownCount>0&&<p className="muted">结果未知的 {unknownCount} 个样本默认不重发：请求可能已在远端处理或计费。确认要重发时点「重试未知样本」，会再次发出真实请求。</p>}<p className="muted">{selected.kind==='local'?'本地模型任务不发送云端标注请求；执行与停止状态以引擎返回为准。':'已发送请求不能保证在远端撤销；暂停与取消都不会自动补发已经发出去的请求。'}</p><InputProgressView statistics={selected.statistics}/>{selected.kind==='local'&&<p className="muted tiny">固定模型版本：{selected.modelVersion??'未报告'} · 请求设备：{selected.device??'未报告'}</p>}<div className="run-counts">{[['在途请求','inFlight'],['已发送请求','requestsUsed'],['成功中复用','reused'],['等待重试','retry_wait'],['结果未知','unknown']].map(([label,key])=><div key={key}><span>{label}</span><strong>{selected.statistics?.[key]??'未知'}</strong></div>)}</div>{typeof selected.budgetScopeId==='string'&&<BudgetEditor key={selected.id} scopeId={selected.budgetScopeId}/>}<div className="sample-table"><div className="sample-row table-head"><span>样本</span><span>当前状态</span></div>{selected.samples?.map((sample,index)=><div className="sample-row" key={sample.id??`${sample.assetId}-${sample.inputId??index}`}><span>{sample.name??assets.find(a=>a.id===sample.assetId)?.name??sample.assetId}{sample.inputId&&<small className="sample-input-label">模型输入 {index+1}</small>}</span><span>{stageNames[sample.status]??sample.status}{sample.reused && (sample.inputReusedFrom ? ' · 输入结果复用（0 次 API 请求）' : ' · 复用成功（本样本 0 请求）')}</span>{(sample.inputId||sample.resultId)&&<div className="sample-input-action"><ModelInputResult inputId={sample.inputId} resultId={sample.resultId} name={sample.name??assets.find(a=>a.id===sample.assetId)?.name??'模型输入'}/></div>}{sample.inputReusedFrom ? <InputReuseSource source={sample.inputReusedFrom}/> : sample.reused && <ReuseProvenance source={sample.reusedFrom}/>}</div>)}</div></section>}
    </div><aside className="event-panel"><div className="section-toolbar"><h2>最近事件</h2><Clock3 size={14}/></div><p className="event-connection"><span className={`status-dot ${engine.state}`}/>{isDemo?'演示模式 · 未连接事件流':engine.state==='ready'?'引擎已连接':'事件连接中断'}</p>{recent.length?<ol className="timeline">{recent.map(event=><li key={event.sequence}><span className="event-dot"/><div><strong>{eventName(event.type)}</strong><time>{new Date(event.timestamp).toLocaleTimeString('zh-CN')}</time><details><summary>查看事件内容</summary><p className="event-raw-type">原始类型：{event.type}</p><pre>{JSON.stringify(event.payload,null,2)}</pre></details></div></li>)}</ol>:<div className="quiet-empty">暂无引擎事件<p>执行后将记录真实状态变化。</p></div>}</aside></div>
    {retryingUnknown&&selected&&<Modal title="重试结果未知的样本" onClose={()=>{if(!busy)setRetryingUnknown(false);}}><div className="form-stack"><Notice>这 {unknownCount} 个样本的结果未知。{selected.kind==='local'?'本地计算的完成状态尚未确认，重发可能重复计算。':'原请求可能已在服务商那边处理或计费，重发会产生新的真实调用。'}本次同时会带上该任务的失败样本，成功样本保持不变。</Notice><div className="modal-actions"><Button disabled={busy} onClick={()=>setRetryingUnknown(false)}>取消</Button><Button busy={busy} className="primary" onClick={()=>void control('retry',{retryUnknown:true})}>{selected.kind==='local'?'重发本地未知输入':'发送重试请求（含未知）'}</Button></div></div></Modal>}
  </>}</>} </div>;
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
