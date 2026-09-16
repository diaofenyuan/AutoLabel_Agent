import { useEffect, useState } from 'react';
import { Download, FolderOpen, AlertCircle, CheckCircle2, RefreshCw, GitCompareArrows } from 'lucide-react';
import { useApp } from './context';
import { request, getBridge, isDemo, errorMessage } from './bridge';
import { Button, Field, Loading, Modal, Notice } from './ui';
import { statusNames, taskNames, type TaskType } from './types';
import AssetScopeField, { useAssetScope, type AssetScope } from './AssetScope';
import ExportFormatPicker, { type ExportFormatSelection, type ExportFormatSpec } from './ExportFormatPicker';

interface Preflight { issues: Array<{ message?: string; severity?: string; code?: string } | string>; summary: unknown; format?: ExportFormatSpec }
export interface ExportRecord {id:string;path:string;status:string;taskType:TaskType;createdAt?:string;assetCount?:number;manifestHash?:string;sourceExportId?:string}
interface ExportDifference {added:string[];removed:string[];changed:Array<{assetId:string;fields:string[]}>;unchanged:number;classesChanged:boolean;formatChanged?:boolean}
/** 只把用户明确选定的格式发给引擎：优先已保存/内置标识，其次内联布局；都不传时引擎沿用内置 YOLO 默认布局。 */
const formatPayload=(selection:ExportFormatSelection)=>({
  ...(selection.format?{format:selection.format as unknown as Record<string,unknown>}:{}),
  ...(!selection.format&&selection.formatId?{formatId:selection.formatId, ...(selection.formatVersion!=null?{formatVersion:selection.formatVersion}:{})}:{})});
const formatSummary=(format?:ExportFormatSpec)=>format?`${format.labelFormat.toUpperCase()} · ${format.layout.index||format.layout.label||format.layout.image}`:'';
const fieldNames:Record<string,string>={contentHash:'图片内容',version:'标注版本',status:'确认状态',source:'标注来源',annotations:'对象标注',split:'数据划分',normalization:'归正变换',classesOrTemplate:'类别或点位模板'};
export default function ExportDialog({ onClose, initialScope = 'project' }: { onClose: () => void; initialScope?: AssetScope }) {
  const { project, assets, notify } = useApp();
  const [scope, setScope] = useState<AssetScope>(initialScope);
  const range = useAssetScope(scope);
  const rangeKey = JSON.stringify(range.assetIds);
  const [tab,setTab]=useState<'create'|'history'>('create');
  const [records,setRecords]=useState<ExportRecord[]>([]);const [historyLoading,setHistoryLoading]=useState(false);
  const [selected,setSelected]=useState('');const [other,setOther]=useState('');const [difference,setDifference]=useState<ExportDifference|null>(null);
  const [reproduceDir,setReproduceDir]=useState('');
  const [taskType, setTaskType] = useState<TaskType>(project?.taskType ?? 'detect');
  const [onlyConfirmed, setOnlyConfirmed] = useState(false);
  const [trainRatio, setTrainRatio] = useState(0.8);
  const [format, setFormat] = useState<ExportFormatSelection>({});
  const formatKey = JSON.stringify(format);
  // 自定义布局是逐字符输入：预检去抖，避免每个按键都打一次引擎。
  const [settledFormatKey, setSettledFormatKey] = useState(formatKey);
  useEffect(() => { const timer = setTimeout(() => setSettledFormatKey(formatKey), 350); return () => clearTimeout(timer); }, [formatKey]);
  // 默认落点由主进程在缺省时注入；这里只读取实际生效目录用于提示，不做路径拼接判断。
  useEffect(() => {
    if (isDemo) return;
    let active = true;
    void request<{ entries: Array<{ kind: string; path: string }> }>('storage.paths.get')
      .then(state => { if (active) setDatasetsRoot(state.entries.find(entry => entry.kind === 'datasets')?.path ?? ''); })
      .catch(() => { if (active) setDatasetsRoot(''); });
    return () => { active = false; };
  }, []);
  const [outputDir, setOutputDir] = useState('');
  const [datasetsRoot, setDatasetsRoot] = useState('');
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ path: string; status: string } | null>(null);
  const record=records.find(r=>r.id===selected);const otherRecord=records.find(r=>r.id===other);
  const usable=(item?:ExportRecord)=>Boolean(item?.status==='completed'&&item.manifestHash);
  const recordLabel=(item:ExportRecord)=>`${item.createdAt?new Date(item.createdAt).toLocaleString('zh-CN'):'时间未记录'} · ${item.assetCount??'?'} 张 · ${item.id.slice(0,8)}${item.sourceExportId?' · 复现':''}`;
  async function loadHistory(){setHistoryLoading(true);setError('');try{setRecords(await request<ExportRecord[]>('export.list',{projectId:project!.id}));}catch(e){setError(errorMessage(e));}finally{setHistoryLoading(false);}}
  useEffect(()=>{if(tab==='history'&&!isDemo)void loadHistory();},[tab]);
  useEffect(() => {
    let active = true; setLoading(true); setError(''); setPreflight(null); setResult(null);
    if (!range.count) { setError('当前范围为空，请选择有素材的范围。'); setLoading(false); return; }
    request<Preflight>('export.preflight', { projectId: project!.id, taskType, ...formatPayload(format), ...(range.assetIds ? { assetIds: range.assetIds } : {}) }).then(data => { if (active) setPreflight(data); }).catch(e => { if (active) setError(errorMessage(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [project?.id, taskType, rangeKey, range.count, settledFormatKey]);
  async function exportData() {
    setBusy(true); setError('');
    try {
      if (!range.count) throw new Error('当前范围为空，无法导出。');
      const data = await request<{ path: string; status: string }>('export.create', { projectId: project!.id, ...(outputDir ? { outputDir } : {}), taskType, onlyConfirmed, trainRatio, ...formatPayload(format), ...(range.assetIds ? { assetIds: range.assetIds } : {}) });
      setResult(data); notify(data.status === 'demo_download' ? '已发起演示 JSON 下载。' : `导出任务状态：${statusNames[data.status]??data.status}。`);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  async function compare(){setBusy(true);setError('');setDifference(null);try{setDifference(await request<ExportDifference>('export.compare',{exportId:selected,otherExportId:other}));}catch(e){setError(errorMessage(e));}finally{setBusy(false);}}
  async function reproduce(){setBusy(true);setError('');try{const data=await request<ExportRecord>('export.reproduce',{exportId:selected,outputDir:reproduceDir});setResult(data);await loadHistory();notify(`固定副本复现状态：${statusNames[data.status]??data.status}。`);}catch(e){setError(errorMessage(e));}finally{setBusy(false);}}
  const assetName=(id:string)=>assets.find(a=>a.id===id)?.name??id;
  return <Modal title="导出数据集" onClose={()=>{if(!busy)onClose();}}><div className="tabs export-tabs"><button disabled={busy} className={tab==='create'?'selected':''} onClick={()=>{setTab('create');setError('');setResult(null);}}>新建导出</button><button disabled={busy} className={tab==='history'?'selected':''} onClick={()=>{setTab('history');setError('');setResult(null);}}>历史与复现</button></div><div className="form-stack">
    {tab==='create'?<>
    {isDemo && <Notice>浏览器演示仅下载内部 JSON。正式 YOLO 标签、图片划分与数据集体检由桌面引擎完成。</Notice>}
    <AssetScopeField label="导出范围" value={scope} onChange={setScope} disabled={busy}/>
    <div className="field-grid"><Field label="导出任务"><select value={taskType} onChange={e => setTaskType(e.target.value as TaskType)}>{Object.entries(taskNames).map(([key,value]) => <option key={key} value={key}>{key.toUpperCase()} · {value}</option>)}</select></Field><Field label="训练集比例"><input type="number" min={0.01} max={0.99} step={0.05} value={trainRatio} onChange={e => setTrainRatio(Number(e.target.value))} /></Field></div>
    <label className="checkbox-row"><input type="checkbox" checked={onlyConfirmed} onChange={e => setOnlyConfirmed(e.target.checked)} />仅导出人工确认的图片</label>
    <ExportFormatPicker taskType={taskType} disabled={busy} selection={format} onChange={setFormat}/>
    {!isDemo && <Field label="输出目录" hint="留空时保存到受管训练集落点（划分好的训练集目录）下的「项目名-时间戳」子目录。"><div className="input-action"><input readOnly value={outputDir} placeholder={datasetsRoot ? `${datasetsRoot}\\${project?.name ?? '项目'}-时间戳` : '默认落点（读取中）'} /><Button onClick={() => void getBridge().then(b => b.chooseFiles({ kind: 'directory' })).then(paths => { if (paths[0]) setOutputDir(paths[0]); }).catch(e => setError(errorMessage(e)))}><FolderOpen size={15} />选择</Button>{outputDir && <Button onClick={() => setOutputDir('')}>用默认落点</Button>}</div></Field>}
    <div className="preflight"><h3>导出前检查</h3>{loading ? <Loading compact label="正在读取项目与标注…" /> : preflight && <><p className="muted">{preflight.issues.length ? `发现 ${preflight.issues.length} 项提示` : '本次检查未返回问题'}</p>{preflight.format && <p className="muted break-word">生效格式：{preflight.format.name||'自定义'} · {formatSummary(preflight.format)}</p>}{preflight.issues.map((issue,i) => <div className="issue" key={i}><AlertCircle size={14} />{typeof issue === 'string' ? issue : issue.message || issue.code}</div>)}<details><summary>检查详情</summary><pre>{JSON.stringify(preflight.summary, null, 2)}</pre></details></>}</div>
    </>:isDemo?<Notice>固定导出历史由桌面引擎保存。浏览器演示 JSON 下载不属于可校验的数据集副本。</Notice>:<><Notice>对比与复现读取历史固定清单。之后对项目的编辑不进入旧副本；复现前会核对图片、标签与配置文件。</Notice><div className="section-toolbar"><h3>已保存导出</h3><Button busy={historyLoading} disabled={busy} onClick={()=>void loadHistory()}><RefreshCw size={13}/>刷新</Button></div>{historyLoading?<Loading compact label="正在读取导出记录…" />:!records.length?<p className="quiet-empty">还没有导出记录。</p>:<><Field label="基准导出"><select value={selected} disabled={busy} onChange={e=>{setSelected(e.target.value);setDifference(null);setResult(null);}}><option value="">选择历史导出</option>{records.map(item=><option key={item.id} value={item.id}>{recordLabel(item)}</option>)}</select></Field>{record&&<div className="export-record"><strong>{record.status==='writing'?'写入中':statusNames[record.status]??record.status}</strong><p className="break-word muted">{record.path}</p>{record.sourceExportId&&<small>复现来源：{record.sourceExportId}</small>}{record.status==='completed'&&!record.manifestHash&&<p className="inline-error">legacy_export_unverified：早期记录缺少清单校验值，无法证明副本未被修改。请保留旧副本并新建导出。</p>}</div>}<section className="operation-section"><h3>比较两个固定副本</h3><Field label="对比导出"><select value={other} disabled={busy} onChange={e=>{setOther(e.target.value);setDifference(null);}}><option value="">选择另一次导出</option>{records.filter(item=>item.id!==selected).map(item=><option key={item.id} value={item.id}>{recordLabel(item)}</option>)}</select></Field>{otherRecord?.status==='completed'&&!otherRecord.manifestHash&&<p className="inline-error">legacy_export_unverified：对比记录没有清单校验值。</p>}<Button disabled={!usable(record)||!usable(otherRecord)||selected===other} busy={busy} onClick={()=>void compare()}><GitCompareArrows size={14}/>比较固定清单</Button>{difference&&<div className="export-difference"><p>从基准导出到对比导出：新增 {difference.added.length} · 移除 {difference.removed.length} · 变化 {difference.changed.length} · 不变 {difference.unchanged}</p>{difference.classesChanged&&<p>类别或点位模板有变化。</p>}{difference.added.map(id=><p key={`a-${id}`}>新增 · {assetName(id)}</p>)}{difference.removed.map(id=><p key={`r-${id}`}>移除 · {assetName(id)}</p>)}{difference.changed.map(item=><p key={item.assetId}>{assetName(item.assetId)}：{item.fields.map(f=>fieldNames[f]??f).join('、')}</p>)}</div>}</section><section className="operation-section"><h3>复现基准导出</h3><Field label="新副本保存目录"><div className="input-action"><input readOnly value={reproduceDir} placeholder="请选择新副本所在目录"/><Button disabled={busy} onClick={()=>void getBridge().then(b=>b.chooseFiles({kind:'directory'})).then(paths=>{if(paths[0])setReproduceDir(paths[0]);}).catch(e=>setError(errorMessage(e)))}><FolderOpen size={14}/>选择</Button></div></Field><Button className="primary" disabled={!usable(record)||!reproduceDir} busy={busy} onClick={()=>void reproduce()}><Download size={14}/>校验并生成新副本</Button></section></>}</>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {result && <div className="notice"><CheckCircle2 size={18} /><div>{result.status === 'demo_download' ? '演示 JSON 下载已发起，请查看浏览器下载列表。' : <><strong>导出状态：{statusNames[result.status]??result.status}</strong><p className="break-word">{result.path}</p>{result.path && <button className="text-button" onClick={() => void getBridge().then(b => b.openPath(result.path)).catch(e => setError(errorMessage(e)))}>打开导出位置</button>}</>}</div></div>}
    <div className="modal-actions"><Button disabled={busy} onClick={onClose}>关闭</Button>{tab==='create'&&<Button className="primary" disabled={loading || !preflight || (!isDemo && !outputDir) || trainRatio <= 0 || trainRatio >= 1} busy={busy} onClick={() => void exportData()}><Download size={15} />{isDemo ? '下载演示 JSON' : '导出数据集'}</Button>}</div>
  </div></Modal>;
}
