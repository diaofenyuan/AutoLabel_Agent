import { useCallback, useEffect, useState } from 'react';
import { FolderOpen, HardDrive, RefreshCw, Save, Undo2 } from 'lucide-react';
import type { StoragePathProbe } from '../../shared/storage';
import type { TrainingRootStatus } from '../../shared/training';
import { useApp } from './context';
import { errorMessage, getBridge, isDemo, request } from './bridge';
import { Button, Field, Notice } from './ui';

function bytes(value: number) {
  return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GB` : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(2)} MB`
    : value >= 1024 ? `${(value / 1024).toFixed(1)} KB` : `${value} 字节`;
}

/**
 * 训练产物目录设置。默认在数据目录内，可改到其他磁盘；改路径前主进程会把已有任务与数据集固定在原目录，
 * 所以历史权重、日志与逐轮指标仍能读取，新任务才写入新位置。
 */
export default function TrainingStorageSection({ onBusyChange }: { onBusyChange: (busy: boolean) => void }) {
  const { notify } = useApp();
  const [status, setStatus] = useState<TrainingRootStatus | null>(null);
  const [draft, setDraft] = useState('');
  const [probe, setProbe] = useState<StoragePathProbe | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [mounted, setMounted] = useState(true);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => () => { setMounted(false); }, []);

  const load = useCallback(async () => {
    try {
      const next = await request<TrainingRootStatus>('training.root.status');
      if (!mounted) return;
      setStatus(next);
      setDraft(next.savedPath ?? '');
    } catch (e) { if (mounted) setError(errorMessage(e)); }
  }, [mounted]);

  useEffect(() => { if (!isDemo) void (async () => { setBusy(true); await load(); if (mounted) setBusy(false); })(); }, [load, mounted]);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); await load(); }
    catch (e) { setError(errorMessage(e)); }
    finally { if (mounted) setBusy(false); }
  }
  async function choose() {
    const paths = await (await getBridge()).chooseFiles({ kind: 'directory' });
    if (!paths[0]) return;
    setDraft(paths[0]);
    try { setProbe(await request<StoragePathProbe>('storage.paths.probe', { path: paths[0] })); }
    catch (e) { setError(errorMessage(e)); }
  }
  async function save(path: string | null, done: string) {
    const result = await request<{ trainingRoot?: 'active' | 'pending-restart' | 'unchanged'; jobs?: number; datasets?: number }>('training.root.save', { path });
    setProbe(null);
    const pinned = (result.jobs ?? 0) + (result.datasets ?? 0);
    const suffix = pinned ? `已有 ${pinned} 项任务与数据集固定在原目录。` : '';
    notify(result.trainingRoot === 'pending-restart'
      ? `训练产物目录已保存；引擎正在执行任务，新目录将在引擎重启后生效。${suffix}`
      : `${done}${suffix}`);
  }
  if (isDemo) return <section className="settings-section"><h2>训练产物</h2><Notice>浏览器演示不使用本地训练目录，请在桌面版本中配置。</Notice></section>;

  const actual = status?.actualPath ?? '正在读取…';
  const source = status?.custom ? '自定义' : '默认（数据目录内）';
  return <section className="settings-section">
    <div className="section-toolbar"><h2><HardDrive size={17} />训练产物目录</h2>
      <Button disabled={busy} onClick={() => void run(async () => { await load(); })}><RefreshCw size={13} />刷新</Button>
    </div>
    <p className="muted">训练权重、逐轮结果与日志按任务隔离保存在这里。更换目录只影响新任务，已有产物仍按创建时的位置读取。</p>
    <div className="setting-row">
      <div><h3>当前生效目录</h3>
        <p className="break-word">{actual}</p>
        <p className="muted tiny">来源 {source}{status?.files !== undefined ? ` · ${status.files} 个文件 · ${bytes(status.bytes ?? 0)}` : ''}</p>
        {status?.fallbackReason && <p className="inline-error">{status.fallbackReason}</p>}
        {!!status?.unpinned && <p className="muted tiny">仍有 {status.unpinned} 项历史记录未固定目录，保存新目录时会被固定在当前位置。</p>}
      </div>
      <div className="actions">
        <Button disabled={busy || !status?.actualPath} onClick={() => void run(async () => { await (await getBridge()).openPath(status!.actualPath!); })}><FolderOpen size={13} />打开</Button>
        <Button disabled={busy} onClick={() => void choose()}>更改目录</Button>
        {status?.custom && <Button disabled={busy} onClick={() => void run(async () => { await save(null, '训练产物目录已恢复为数据目录内的默认位置。'); })}><Undo2 size={13} />恢复默认</Button>}
      </div>
      {draft && <>
        <Field label="新的训练产物目录" hint={probe ? (probe.writable ? `可写${probe.created ? '（已创建）' : ''}` : `不可用：${probe.reason ?? '未知原因'}`) : undefined}>
          <div className="input-action">
            <input readOnly aria-label="新的训练产物目录" value={draft} placeholder="默认在数据目录内" />
            <Button disabled={busy} onClick={() => { setDraft(''); setProbe(null); }}>清空</Button>
          </div>
        </Field>
      </>}
      <div className="actions"><Button className="primary" disabled={busy} busy={busy} onClick={() => void run(async () => { await save(draft.trim() ? draft.trim() : null, '训练产物目录已保存。'); })}><Save size={14} />保存训练产物目录</Button></div>
    </div>
    {error && <p className="inline-error storage-error" role="alert">{error}</p>}
  </section>;
}
