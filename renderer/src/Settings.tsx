import { useCallback, useEffect, useRef, useState } from 'react';
import { Save, RefreshCw, Monitor, Sun, Moon, Check, Clipboard, ShieldCheck } from 'lucide-react';
import { useApp, type SettingsSection } from './context';
import { request, getBridge, isDemo, errorMessage } from './bridge';
import { Button, PageHeader, Notice } from './ui';
import { thinkingDepthNames, type Preferences } from './types';
import UpdateSettings from './UpdateSettings';
import StorageSettings from './StorageSettings';
import StoragePathsSection from './StoragePathsSection';
import ChatHistorySection from './ChatHistorySection';
import LocalRuntimeSettings from './LocalRuntimeSettings';
import MediaRuntimeSettings from './MediaRuntimeSettings';
import TrainingStorageSection from './TrainingStorageSection';
import SamplesSection from './SamplesSection';
import AiSettings from './AiSettings';

/**
 * 设置页区块清单。显式标注为 `SettingsSection` 的元组表，让标签栏与深链落点共用同一份键：
 * 少写一个键、或键名拼错，这里就会直接报类型错误，而不是让深链悄悄落到默认区块。
 *
 * 常用区块是第一次进来就要能找到的六项；其余六项按频率低得多，收在「高级设置」后面，
 * 不是藏起来——点一下就展开，深链落到高级区块时也会自动展开。
 */
const BASIC_TABS: ReadonlyArray<readonly [SettingsSection, string]> = [
  ['appearance','外观'],['ai','软件 AI 配置'],['storage','存储位置'],['local','本地推理'],['shortcuts','快捷键'],['updates','应用更新']
];
const ADVANCED_TABS: ReadonlyArray<readonly [SettingsSection, string]> = [
  ['workspace','工作空间'],['chats','对话记录'],['execution','执行与预算'],['media','视频工具'],['samples','示例'],['diagnostics','诊断']
];
const ADVANCED_KEYS = new Set<SettingsSection>(ADVANCED_TABS.map(([key]) => key));
const ADVANCED_STORAGE_KEY = 'autolabel.settingsAdvanced';
function readAdvancedOpen(): boolean { try { return localStorage.getItem(ADVANCED_STORAGE_KEY) === '1'; } catch { return false; } }
export default function Settings(){
  const {prefs,setPrefs,savePrefs,engine,notify,guard,syncWindowDirtySource,settingsSection}=useApp();
  const [storageBusy,setStorageBusy]=useState(false);
  const [pathsBusy,setPathsBusy]=useState(false);
  const [chatsBusy,setChatsBusy]=useState(false);
  const [trainingBusy,setTrainingBusy]=useState(false);
  // 存储位置、对话记录与训练产物区块有自己的保存动作，进行中同样要阻止离开设置页。
  const settingsBusy=storageBusy||pathsBusy||chatsBusy||trainingBusy;
  const dirty=useRef(false);const updateDirty=useRef(false);
  const syncDirty=useCallback((value:boolean,part:'settings'|'update'='settings')=>{if(part==='settings')dirty.current=value;else updateDirty.current=value;syncWindowDirtySource(part,value);},[syncWindowDirtySource]);
  const syncUpdateDirty=useCallback((value:boolean)=>syncDirty(value,'update'),[syncDirty]);
  // 初值来自应用层的落点：从媒体错误点「打开媒体运行时设置」直接落到视频工具，而不是让用户再找一层。
  const [section,setSection]=useState<SettingsSection>(settingsSection);const [busy,setBusy]=useState(false);const [diagnostics,setDiagnostics]=useState<Record<string,unknown>|null>(null);
  // 深链直接落到高级区块（例如媒体错误的「打开媒体运行时设置」）时必须已经展开，否则用户看不到自己被送到了哪里。
  const [advancedTabs,setAdvancedTabs]=useState(()=>ADVANCED_KEYS.has(settingsSection)||readAdvancedOpen());
  const visibleTabs=advancedTabs?[...BASIC_TABS,...ADVANCED_TABS]:BASIC_TABS;
  function toggleAdvanced(next:boolean){setAdvancedTabs(next);try{localStorage.setItem(ADVANCED_STORAGE_KEY,next?'1':'0');}catch{/* 存不下只影响下次进来是否展开 */}if(!next&&ADVANCED_KEYS.has(section))setSection('appearance');}
  const set=<K extends keyof Preferences>(key:K,value:Preferences[K])=>{if(busy||settingsBusy)return;syncDirty(true);setPrefs(p=>({...p,[key]:value}));};
  useEffect(()=>{const beforeLeave=async()=>{if(settingsBusy)throw new Error('设置操作正在进行，请等待完成。');if(dirty.current||updateDirty.current)throw new Error('设置尚未保存，请先点击“保存设置”。');};guard.current=beforeLeave;return()=>{if(guard.current===beforeLeave)guard.current=null;};},[guard,settingsBusy]);
  useEffect(()=>()=>{syncDirty(false);syncDirty(false,'update');},[syncDirty]);
  async function save(){setBusy(true);try{await savePrefs({...prefs,globalConcurrency:prefs.concurrency});syncDirty(false);notify('设置已保存。');}catch(e){notify(errorMessage(e),true);}finally{setBusy(false);}}
  async function diagnose(){setBusy(true);try{setDiagnostics(await request<Record<string,unknown>>('diagnostics.get'));}catch(e){notify(errorMessage(e),true);}finally{setBusy(false);}}
  const appearance=<section className="settings-section"><h2>外观</h2><div className="setting-row"><div><h3>主题</h3><p>选择工作空间的明暗外观</p></div><div className="segmented">{([['light','浅色',Sun],['dark','深色',Moon],['system','跟随系统',Monitor]] as const).map(([key,label,Icon])=><button disabled={busy} key={key} className={prefs.theme===key?'selected':''} aria-pressed={prefs.theme===key} onClick={()=>set('theme',key)}><Icon size={14}/>{label}</button>)}</div></div><div className="setting-row"><div><h3>减少动画</h3><p>减少页面与面板的过渡，也遵循系统偏好</p></div><button disabled={busy} role="switch" aria-checked={prefs.reducedMotion} aria-label="减少动画" className={`switch ${prefs.reducedMotion?'on':''}`} onClick={()=>set('reducedMotion',!prefs.reducedMotion)}><span/></button></div><div className="setting-row"><div><h3>画布背景</h3><p>只影响画布外观，不改变训练图片</p></div><div className="swatches">{[['#eef0f3','浅灰画布'],['#24262a','深灰画布'],['#ffffff','白色画布']].map(([color,label])=><button disabled={busy} key={color} style={{background:color}} className={prefs.canvasBackground===color?'selected':''} aria-label={label} aria-pressed={prefs.canvasBackground===color} onClick={()=>set('canvasBackground',color)}>{prefs.canvasBackground===color&&<Check size={14}/>}</button>)}</div></div><div className="setting-row"><div><h3>关闭窗口行为</h3><p>点击窗口关闭按钮时的默认动作；“询问”会保留保存与取消选项</p></div><div className="segmented">{([['ask','询问'],['tray','最小化到托盘'],['quit','退出应用']] as const).map(([key,label])=><button disabled={busy} key={key} className={prefs.closeBehavior===key?'selected':''} aria-pressed={prefs.closeBehavior===key} onClick={()=>set('closeBehavior',key)}>{label}</button>)}</div></div></section>;
  const execution=<section className="settings-section"><h2>执行与预算</h2>{([['concurrency','默认并发数','新建标注任务的默认并发；引擎全局上限在重启后应用',1,32],['maxRequests','默认请求上限','覆盖调用尝试与重试；留空表示不设置',1,1000000],['timeout','默认超时（秒）','新接口配置的默认超时，已有接口在模型中心调整',1,600],['retries','默认重试次数','新接口的有限重试次数，失败不视为免费调用',0,6],['trainingWorkers','训练数据加载进程数','传给训练进程的 dataloader 工作进程数，0 表示在主进程加载',0,32],['trainingConcurrency','训练并发上限','同时执行的训练任务数（1–2）；超出的任务保持排队，引擎重启后应用',1,2],
      // 训练不消耗 API 预算，保留策略只作用于已结束任务的逐轮指标记录。
      ['trainingRetentionDays','训练进度保留（天）','已结束任务的逐轮指标保留天数，0 表示永久保留；权重、日志与结果文件不受影响',0,3650]] as const).map(([key,label,hint,min,max])=><div className="setting-row" key={key}><div><h3>{label}</h3><p>{hint}</p></div><input disabled={busy} aria-label={label} type="number" min={min} max={max} value={prefs[key]??''} placeholder="未设置" onChange={e=>set(key,e.target.value?Number(e.target.value):key==='maxRequests'?null:min)}/></div>)}
    <div className="setting-row"><div><h3>默认思考深度</h3><p>新对话的初始档位；会话里切换只影响当前会话。接口没有统一的推理参数，档位调整的是助手自身的投入：快速档少轮次、不额外自检，深入档多轮次并在结束后做结构化自检。</p></div><div className="segmented">{(['fast','standard','deep'] as const).map(key=><button disabled={busy} key={key} className={prefs.chatThinkingDepth===key?'selected':''} aria-pressed={prefs.chatThinkingDepth===key} onClick={()=>set('chatThinkingDepth',key)}>{thinkingDepthNames[key]}</button>)}</div></div>
    <div className="setting-row"><div><h3>训练默认设备</h3><p>新建训练的默认执行设备；自动会在启动前优先选择 GPU，不可用时回退 CPU 并如实记录</p></div><div className="segmented">{([['gpu-auto','自动（优先 GPU）'],['cpu','CPU']] as const).map(([key,label])=><button disabled={busy} key={key} className={prefs.trainingDevice===key?'selected':''} aria-pressed={prefs.trainingDevice===key} onClick={()=>set('trainingDevice',key)}>{label}</button>)}</div></div></section>;
  return <div className="content settings-page"><div className="settings-head"><PageHeader title="设置" actions={<Button disabled={settingsBusy} busy={busy} className="primary" onClick={()=>void save()}><Save size={14}/>保存设置</Button>}/><div className="tabs settings-tabs">{visibleTabs.map(([key,label])=><button disabled={busy||settingsBusy} key={key} className={section===key||key==='ai'&&section==='ai-library'?'selected':''} onClick={()=>setSection(key)}>{label}</button>)}<button className={`settings-advanced-toggle ${advancedTabs?'selected':''}`} aria-pressed={advancedTabs} disabled={busy||settingsBusy} onClick={()=>toggleAdvanced(!advancedTabs)}>{advancedTabs?'收起高级设置':'高级设置'}</button></div></div>
    <div className="settings-body" key={section}>{section==='updates'?<UpdateSettings onDirtyChange={syncUpdateDirty}/>:section==='ai-library'?<AiSettings initialKind="library"/>:section==='ai'?<AiSettings/>:section==='appearance'?<>{appearance}</>:section==='execution'?<>{execution}<TrainingStorageSection onBusyChange={setTrainingBusy}/></>:section==='storage'?<StoragePathsSection onBusyChange={setPathsBusy}/>:section==='chats'?<ChatHistorySection onBusyChange={setChatsBusy}/>:section==='workspace'?<StorageSettings onBusyChange={setStorageBusy}/>:section==='local'?<LocalRuntimeSettings onBusyChange={setStorageBusy} beforeConfigure={()=>{if(dirty.current)throw new Error('设置尚未保存，请先点击“保存设置”后再配置本地解释器。');}}/>:section==='media'?<MediaRuntimeSettings onBusyChange={setStorageBusy} beforeConfigure={()=>{if(dirty.current)throw new Error('请先保存设置，再配置视频工具。');}}/>:section==='samples'?<SamplesSection/>:section==='shortcuts'?<section className="settings-section"><h2>人工标注与操作快捷键</h2><p className="muted">人工标注入口：打开项目概览或对话结果里的素材，点「编辑标注」进入画布。画布与全局实际可用的键如下。</p>{[['完成当前多边形','Enter'],['取消当前绘制','Escape'],['删除选中的多边形顶点','Delete'],['发送对话消息','Ctrl + Enter'],['打开快速跳转','Ctrl + K'],['切换到前九个对话','Ctrl + 1…9']].map(([label,key])=><div className="setting-row" key={label}><h3>{label}</h3><kbd>{key}</kbd></div>)}<p className="muted">输入框或对话框获得焦点时，不触发画布快捷键。</p></section>:<section className="settings-section"><div className="section-toolbar"><h2>诊断</h2><div className="actions"><Button disabled={isDemo} busy={busy} onClick={()=>{setBusy(true);void request<{saved:boolean}>('diagnostics.save').then(result=>{if(result.saved)notify('脱敏诊断已保存。');}).catch(e=>notify(errorMessage(e),true)).finally(()=>setBusy(false));}}><Save size={14}/>保存脱敏诊断</Button><Button disabled={settingsBusy} busy={busy} onClick={()=>void diagnose()}><RefreshCw size={14}/>刷新诊断</Button></div></div><Notice><ShieldCheck size={16}/>仅展示本地返回的信息，不自动上传。</Notice>{diagnostics?<pre className="diagnostic-output">{JSON.stringify(diagnostics,null,2)}</pre>:<p className="quiet-empty">点击“刷新诊断”读取当前状态。</p>}{diagnostics&&<Button onClick={()=>void navigator.clipboard.writeText(JSON.stringify(diagnostics,null,2)).then(()=>notify('诊断信息已复制。')).catch(e=>notify(errorMessage(e),true))}><Clipboard size={14}/>复制诊断</Button>}</section>}
    <div className="setting-row engine-setting"><div><h3>本地引擎</h3><p>{isDemo?'浏览器演示不连接执行引擎':engine.message??'用于执行模型调用、媒体处理与保存项目'}</p></div><div className="actions"><span className="muted"><span className={`status-dot ${engine.state}`}/>{engine.state==='ready'?'已连接':engine.state==='starting'?'启动中':'未连接'}</span><Button disabled={settingsBusy} busy={busy} onClick={()=>{setBusy(true);void getBridge().then(b=>b.restartEngine()).then(status=>notify(status.message??(status.state==='ready'?'引擎已连接。':'引擎尚未就绪。'),status.state!=='ready')).catch(e=>notify(errorMessage(e),true)).finally(()=>setBusy(false));}}><RefreshCw size={13}/>重新连接</Button></div></div>
    </div>
  </div>;
}
