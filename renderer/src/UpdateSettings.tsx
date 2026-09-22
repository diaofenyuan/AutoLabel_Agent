import { useEffect, useRef, useState } from 'react';
import { Download, RefreshCw, Save, Square, PackageCheck } from 'lucide-react';
import { useApp } from './context';
import { errorMessage, isDemo, request } from './bridge';
import { Button, Field, Loading, Notice } from './ui';

interface UpdateSettingsProps { onDirtyChange?: (dirty: boolean) => void }
interface UpdateStatus {
  state:'unconfigured'|'idle'|'checking'|'up-to-date'|'available'|'downloading'|'verifying'|'ready'|'cancelled'|'error'|'installing';
  currentVersion:string; release?:{version:string;releaseNotes:string;size:number;publishedAt?:string};
  downloadedBytes:number;totalBytes?:number;error?:{code:string;message:string};
}
const names:Record<UpdateStatus['state'],string>={unconfigured:'未配置更新源',idle:'等待检查',checking:'正在检查更新','up-to-date':'当前为最新版本',available:'发现可用更新',downloading:'正在下载',verifying:'正在校验安装包',ready:'已校验，可安装',cancelled:'下载已取消',error:'更新未完成',installing:'正在准备安装'};
const bytes=(value:number)=>value>=1024**3?`${(value/1024**3).toFixed(2)} GB`:value>=1024**2?`${(value/1024**2).toFixed(1)} MB`:value>=1024?`${(value/1024).toFixed(1)} KB`:`${value} B`;
export default function UpdateSettings({ onDirtyChange }: UpdateSettingsProps){
  const {prefs,setPrefs,notify}=useApp();
  const [url,setUrl]=useState(String(prefs.updateManifestUrl??''));const [savedUrl,setSavedUrl]=useState(String(prefs.updateManifestUrl??''));
  const [status,setStatus]=useState<UpdateStatus|null>(null);const [pending,setPending]=useState('');const [cancelling,setCancelling]=useState(false);
  const [error,setError]=useState('');const [installAck,setInstallAck]=useState(false);const [loading,setLoading]=useState(!isDemo);
  const mounted=useRef(true);const revision=useRef(0);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;revision.current++;};},[]);
  async function refresh(){const current=revision.current;try{const value=await request<UpdateStatus>('update.status');if(mounted.current&&revision.current===current)setStatus(value);}catch(e){if(mounted.current)setError(errorMessage(e));}finally{if(mounted.current)setLoading(false);}}
  useEffect(()=>{if(!isDemo)void refresh();},[]);
  const active=Boolean(pending)||loading||Boolean(status&&['checking','downloading','verifying','installing'].includes(status.state));
  useEffect(()=>{
    if(isDemo||!active)return;let live=true;let timer:ReturnType<typeof setTimeout>;
    // 只查询主进程的实际字节；逐次等待，避免慢 IPC 导致轮询请求堆积。
    const poll=async()=>{await refresh();if(live)timer=setTimeout(()=>void poll(),1000);};
    timer=setTimeout(()=>void poll(),500);return()=>{live=false;clearTimeout(timer);};
  },[active]);
  async function command(action:'check'|'download'|'cancel'|'install'){
    if(action==='cancel')setCancelling(true);else setPending(action);setError('');
    try{const result=await request<UpdateStatus>(`update.${action}`);revision.current++;if(mounted.current){setStatus(result);if(result.state==='error')setInstallAck(false);}}
    catch(e){if(mounted.current)setError(errorMessage(e));}
    finally{if(mounted.current){if(action==='cancel')setCancelling(false);else setPending('');}}
  }
  async function saveUrl(){setPending('save');setError('');try{
    const value=url.trim();if(value){const parsed=new URL(value);const loopback=['127.0.0.1','[::1]'].includes(parsed.hostname);if((parsed.protocol!=='https:'&&!(loopback&&parsed.protocol==='http:'))||parsed.username||parsed.password||parsed.hash)throw new Error('更新地址须为 HTTPS，或仅在本机回环测试时使用 HTTP；不能包含用户名、密码或片段。');}
    await request('settings.save',{settings:{updateManifestUrl:value}});setPrefs(p=>({...p,updateManifestUrl:value}));setSavedUrl(value);setUrl(value);setInstallAck(false);revision.current++;await refresh();notify('更新地址已保存。');
  }catch(e){setError(errorMessage(e));}finally{setPending('');}}
  const changed=url.trim()!==savedUrl;
  useEffect(()=>{onDirtyChange?.(changed);return()=>onDirtyChange?.(false);},[changed,onDirtyChange]);
  const total=status?.totalBytes;const downloaded=status?.downloadedBytes??0;
  const percent=total&&total>0?Math.min(100,Math.max(0,downloaded/total*100)):null;
  return <section className="settings-section update-settings"><h2>应用更新</h2>{isDemo?<Notice>浏览器演示不提供安装包更新，也不模拟下载。请在桌面应用中配置更新源。</Notice>:<>
    <Field label="更新清单地址" hint="不填就用官方默认源（GitHub 发布清单）；保存空值则关闭更新。需要自建发布时填 HTTPS 清单地址。"><input type="url" value={url} disabled={active} onChange={e=>setUrl(e.target.value)} placeholder="默认：官方 GitHub 发布清单"/></Field><Button disabled={active||!changed} busy={pending==='save'} onClick={()=>void saveUrl()}><Save size={14}/>保存更新地址</Button>
    <div className="update-status" data-state={status?.state ?? (loading ? 'loading' : 'error')}><div className="section-toolbar"><div role="status" aria-live="polite">{loading?<Loading compact label="正在读取桌面更新状态…"/>:<><h3>{status?names[status.state]:'更新状态无法读取'}</h3>{status&&<p className="muted">当前版本 {status.currentVersion}</p>}</>}</div><Button disabled={active} onClick={()=>{setError('');void refresh();}}><RefreshCw size={14}/>刷新状态</Button></div>
    {changed&&<p className="muted">更新地址尚未保存，请先保存再检查。</p>}
    {status?.release&&<div className="update-release"><h3>版本 {status.release.version}</h3><p className="muted">安装包 {bytes(status.release.size)}{status.release.publishedAt?` · ${new Date(status.release.publishedAt).toLocaleString('zh-CN')}`:''}</p><div className="release-notes">{status.release.releaseNotes||'此版本未提供更新说明。'}</div></div>}
    {status&&['downloading','verifying','ready','cancelled','installing'].includes(status.state)&&<div className="download-progress"><p>{bytes(downloaded)}{total?` / ${bytes(total)}`:''}{percent!==null?` · ${percent.toFixed(1)}%`:''}</p>{percent!==null&&<progress aria-label="安装包实际下载进度" value={downloaded} max={total}/>}<small>{status.state==='verifying'?'下载完成，正在验证完整性与安装包身份。':status.state==='cancelled'?'已停止下载。重新下载将由桌面更新器处理。':'进度来自实际接收的字节。'}</small></div>}
    {(status?.error||error)&&<div className="inline-error" role="alert">{status?.error&&<p>{status.error.message}<small className="error-code">{status.error.code}</small></p>}{error&&<p>{error}</p>}</div>}
    <div className="actions update-actions"><Button disabled={!status||active||changed||status.state==='unconfigured'} busy={pending==='check'} onClick={()=>void command('check')}><RefreshCw size={14}/>检查更新</Button><Button className="primary" disabled={!status||active||changed||!['available','cancelled'].includes(status.state)} busy={pending==='download'} onClick={()=>void command('download')}><Download size={14}/>下载更新</Button>{status?.state==='downloading'&&<Button busy={cancelling} onClick={()=>void command('cancel')}><Square size={13}/>取消下载</Button>}</div>
    {status?.state==='ready'&&<section className="operation-section"><p className="muted">安装前请结束未完成任务并处理待确认调用。主进程会再次检查全部任务；暂停任务仍可能阻止安装。</p><label className="checkbox-row"><input type="checkbox" checked={installAck} disabled={active} onChange={e=>setInstallAck(e.target.checked)}/>已了解安装将退出应用并启动安装程序</label><Button className="primary" disabled={!installAck||active||changed} busy={pending==='install'} onClick={()=>void command('install')}><PackageCheck size={14}/>退出并安装更新</Button></section>}
    </div></>}
  </section>;
}
