import { useEffect, useState } from 'react';
import { CheckCircle2, ChevronRight, RefreshCw, Trash2 } from 'lucide-react';
import { formatModelBytes, type ModelLibraryEntry, type ModelLibraryProgress, type ModelLibraryState } from '../../shared/model-library';
import type { LocalModel } from '../../shared/inference';
import { getBridge, request, errorMessage, isDemo } from './bridge';
import { useApp } from './context';
import { Button, Notice } from './ui';
import { taskNames } from './types';

const stateLabels: Record<ModelLibraryEntry['state'], string> = { ready: '已就绪', missing: '未就绪', corrupt: '需要修复' };

/**
 * 模型库。
 *
 * 与「本地模型」分开：那里是用户自己找来的 .pt 文件（要授权、要核对哈希），
 * 这里是软件自带的模型 —— 随安装包装好，或者点一下按需下载。
 * 「启用」一步做完三件事：确保权重就绪（需要时下载）、登记为本地模型、按当前数据目录授权执行；
 * 之后到「本地模型」里选设备加载即可。文本编码器只下载不登记，它不是任务模型。
 */
export default function ModelLibrary() {
  const [state, setState] = useState<ModelLibraryState | null>(null);
  const [enabled, setEnabled] = useState<Record<string, LocalModel>>({});
  const [progress, setProgress] = useState<ModelLibraryProgress | null>(null);
  const [busyId, setBusyId] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const { notify } = useApp();
  async function refresh() {
    if (isDemo) return;
    setBusy(true); setError('');
    const values = await Promise.allSettled([
      request<ModelLibraryState>('model.library.status'),
      request<{ items: LocalModel[] }>('local.model.list', { offset: 0, limit: 500 }),
    ]);
    if (values[0].status === 'fulfilled') setState(values[0].value); else setError(errorMessage(values[0].reason));
    if (values[1].status === 'fulfilled') setEnabled(Object.fromEntries(values[1].value.items.filter(item => item.catalogId).map(item => [item.catalogId!, item])));
    setBusy(false);
  }
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    let unsubscribe: (() => void) | undefined, active = true;
    void getBridge().then(bridge => { if (active) unsubscribe = bridge.onModelLibraryProgress?.(setProgress); }).catch(() => undefined);
    return () => { active = false; unsubscribe?.(); };
  }, []);
  /** 启用或按下修复：一个命令同时覆盖「下载、校验、登记、授权」，失败时权重仍留在本机可重试。 */
  async function enable(entry: ModelLibraryEntry, force = false) {
    setBusyId(entry.id); setError(''); setProgress(null);
    try {
      const next = await request<ModelLibraryState & { enabled: LocalModel | null }>('model.library.install', { catalogId: entry.id, ...(force ? { force: true } : {}) });
      setState(next); await refresh();
      notify(next.enabled ? `${entry.name} 已启用。到「本地模型」里选择设备并加载即可使用。`
        : `${entry.name} 已下载。类别名不在内置词表时才需要它。`);
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusyId(''); setProgress(null); }
  }
  /**
   * 删除本机下载的副本。登记记录与已授权的哈希都保留：删掉后加载会明确报「模型文件已变化」，
   * 而不是静默用旧哈希——需要恢复时重新点启用即可。
   */
  async function remove(entry: ModelLibraryEntry) {
    setBusyId(entry.id); setError('');
    try { setState(await request<ModelLibraryState>('model.library.remove', { catalogId: entry.id })); notify(`${entry.name} 的本机副本已删除。`); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusyId(''); }
  }
  const groups = new Map<string, ModelLibraryEntry[]>();
  for (const entry of state?.entries ?? []) groups.set(entry.group, [...(groups.get(entry.group) ?? []), entry]);
  const card = (entry: ModelLibraryEntry) => {
    const registered = enabled[entry.id];
    const downloading = busyId === entry.id;
    const pinned = downloading && progress?.catalogId === entry.id && progress.totalBytes > 0;
    return <article className={`model-card ${entry.state}`} key={entry.id} data-model={entry.id} data-state={entry.state} data-enabled={registered ? 'yes' : 'no'}>
      <div className="model-card-head"><strong>{entry.name}</strong>
        <span className={`model-card-state ${entry.state}`}>{registered ? '已启用' : entry.taskType === null && entry.state === 'ready' ? '已下载' : stateLabels[entry.state]}</span></div>
      <p className="model-card-note">{entry.note}</p>
      <ul className="model-card-facts">
        <li>{entry.taskType ? taskNames[entry.taskType] : '文本编码器'}</li>
        <li>{formatModelBytes(entry.sizeBytes)}</li>
        <li>{entry.tier === 'bundled' ? '随安装包提供' : '按需下载'}</li>
        <li>{entry.license}</li>
      </ul>
      {entry.state === 'ready' && entry.location === 'storage' && <p className="model-card-hint">已下载到本机模型目录。</p>}
      {entry.state !== 'ready' && <p className="model-card-hint">{entry.message}</p>}
      {pinned && <div className="model-card-progress" role="progressbar" aria-label={`${entry.name} 下载进度`} aria-valuenow={Math.round(progress!.receivedBytes / progress!.totalBytes * 100)}>
        <span style={{ width: `${Math.round(progress!.receivedBytes / progress!.totalBytes * 100)}%` }}/>
        <small>{formatModelBytes(progress!.receivedBytes)} / {formatModelBytes(progress!.totalBytes)}</small></div>}
      <div className="model-card-actions">
        <Button className={entry.state === 'ready' ? '' : 'primary'} busy={downloading} disabled={isDemo || Boolean(busyId)} title={busyId && busyId !== entry.id ? '另一个模型正在下载，完成后可继续' : undefined}
          onClick={() => void enable(entry, entry.state === 'corrupt')}>{entry.state === 'corrupt' ? '重新下载并修复'
            : entry.state !== 'ready' ? (entry.taskType === null ? '下载' : '启用（需要时先下载）') : registered ? '重新下载' : '启用'}</Button>
        {entry.location === 'storage' && <Button disabled={isDemo || Boolean(busyId)} onClick={() => void remove(entry)}><Trash2 size={13}/>删除本机副本</Button>}
        {registered && <span className="model-card-enabled"><CheckCircle2 size={13}/>已登记为本地模型 · 版本 {registered.version}</span>}
      </div>
    </article>;
  };
  return <div className="model-library">
    <div className="section-toolbar"><h2>模型库</h2><div className="actions"><Button disabled={isDemo || busy} busy={busy} onClick={() => void refresh()}><RefreshCw size={14}/>刷新模型库</Button></div></div>
    <p className="muted">这里的模型由软件提供，不需要自己找文件，也不需要 API Key：点「启用」就会登记好并授权给当前数据目录，本机运行、不产生接口费用；只有你点了下载才会联网。</p>
    {isDemo && <Notice>浏览器演示不读取本机模型库，请在桌面应用中查看。</Notice>}
    {state && <div className="model-library-summary"><strong>已就绪 {state.ready} / {state.total}</strong><span>内置 {formatModelBytes(state.bundledBytes)} 随安装包提供</span><span>下载目录：{state.modelsRoot}</span></div>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {[...groups.entries()].map(([group, entries]) => {
      // 大件默认收起：列表按「能直接用的」优先，需要下载的收进一行，需要时再展开。
      const inline = entries.filter(entry => entry.tier === 'bundled' || entry.state === 'ready' || enabled[entry.id] || busyId === entry.id);
      const folded = entries.filter(entry => !inline.includes(entry));
      return <section className="model-library-group" key={group}>
        <h3>{group}</h3>
        {inline.map(card)}
        {folded.length > 0 && <details className="model-library-more"><summary><ChevronRight size={13}/>更多模型（按需下载 {folded.length} 个）</summary>{folded.map(card)}</details>}
      </section>;
    })}
  </div>;
}
