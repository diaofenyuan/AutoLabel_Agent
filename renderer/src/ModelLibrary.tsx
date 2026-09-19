import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { formatModelBytes, type ModelLibraryEntry, type ModelLibraryState } from '../../shared/model-library';
import { request, errorMessage, isDemo } from './bridge';
import { Button, Notice } from './ui';
import { taskNames } from './types';

const stateLabels: Record<ModelLibraryEntry['state'], string> = { ready: '已就绪', missing: '未就绪', corrupt: '需要修复' };

/**
 * 模型库。
 *
 * 与「本地模型」分开：那里是用户自己找来的 .pt 文件（要授权、要核对哈希），
 * 这里是软件自带的模型 —— 随安装包装好，或者点一下按需下载。两者在执行时走同一条本地推理链路。
 * 本页只如实回答三件事：有哪些、体积多大、现在能不能用；不能用时给出原因，不显示一个转圈的假进度。
 */
export default function ModelLibrary() {
  const [state, setState] = useState<ModelLibraryState | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function refresh() {
    if (isDemo) return;
    setBusy(true); setError('');
    try { setState(await request<ModelLibraryState>('model.library.status')); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  useEffect(() => { void refresh(); }, []);
  const groups = new Map<string, ModelLibraryEntry[]>();
  for (const entry of state?.entries ?? []) groups.set(entry.group, [...(groups.get(entry.group) ?? []), entry]);
  return <div className="model-library">
    <div className="section-toolbar"><h2>模型库</h2><div className="actions"><Button disabled={isDemo || busy} busy={busy} onClick={() => void refresh()}><RefreshCw size={14}/>刷新模型库</Button></div></div>
    <p className="muted">这里的模型由软件提供，不需要自己找文件，也不需要 API Key。本机运行，不产生接口费用；按需下载的模型只在你点击下载后才会联网。</p>
    {isDemo && <Notice>浏览器演示不读取本机模型库，请在桌面应用中查看。</Notice>}
    {state && <div className="model-library-summary"><strong>已就绪 {state.ready} / {state.total}</strong><span>内置 {formatModelBytes(state.bundledBytes)} 随安装包提供</span><span>下载目录：{state.modelsRoot}</span></div>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {[...groups.entries()].map(([group, entries]) => <section className="model-library-group" key={group}>
      <h3>{group}</h3>
      {entries.map(entry => <article className={`model-card ${entry.state}`} key={entry.id} data-model={entry.id} data-state={entry.state}>
        <div className="model-card-head"><strong>{entry.name}</strong><span className={`model-card-state ${entry.state}`}>{stateLabels[entry.state]}</span></div>
        <p className="model-card-note">{entry.note}</p>
        <ul className="model-card-facts">
          <li>{entry.taskType ? taskNames[entry.taskType] : '文本编码器'}</li>
          <li>{formatModelBytes(entry.sizeBytes)}</li>
          <li>{entry.tier === 'bundled' ? '随安装包提供' : '按需下载'}</li>
          <li>{entry.license}</li>
        </ul>
        {entry.state === 'ready' && entry.location === 'storage' && <p className="model-card-hint">已下载到本机模型目录。</p>}
        {entry.state !== 'ready' && <p className="model-card-hint">{entry.message}</p>}
      </article>)}
    </section>)}
  </div>;
}
