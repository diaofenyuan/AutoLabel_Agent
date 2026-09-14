import { useCallback, useEffect, useState } from 'react';
import { FolderOpen, RefreshCw, Save, Undo2, Database, AlertTriangle, CheckCircle2, ArrowRight } from 'lucide-react';
import type {
  StoragePathEntry, StoragePathKind, StoragePathMigrationPlan, StoragePathMigrationResult, StoragePathProbe, StoragePathsState,
} from '../../shared/storage';
import { useApp } from './context';
import { errorMessage, getBridge, isDemo, request } from './bridge';
import { Button, Field, Notice } from './ui';

const sourceLabels: Record<string, string> = { default: '默认', custom: '自定义', fallback: '回退' };
function bytes(value: number) {
  return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GB` : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(2)} MB`
    : value >= 1024 ? `${(value / 1024).toFixed(1)} KB` : `${value} 字节`;
}

/**
 * 三类业务数据的落点设置。默认值跟随安装目录，不可写时回退到当前用户目录并如实展示原因，
 * 不静默降级。改路径只影响之后的新数据，已有文件通过「迁移已有数据」显式复制。
 */
export default function StoragePathsSection({ onBusyChange }: { onBusyChange: (busy: boolean) => void }) {
  const { notify } = useApp();
  const [state, setState] = useState<StoragePathsState | null>(null);
  const [rootDraft, setRootDraft] = useState('');
  const [drafts, setDrafts] = useState<Partial<Record<StoragePathKind, string>>>({});
  const [probes, setProbes] = useState<Record<string, StoragePathProbe>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [plan, setPlan] = useState<StoragePathMigrationPlan | null>(null);
  const [migrated, setMigrated] = useState<StoragePathMigrationResult | null>(null);
  const [mounted, setMounted] = useState(true);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => () => { setMounted(false); }, []);

  const load = useCallback(async () => {
    try {
      const next = await request<StoragePathsState>('storage.paths.get');
      if (!mounted) return;
      setState(next);
      setDrafts(Object.fromEntries(next.entries.map(entry => [entry.kind, entry.custom ? entry.path : ''])) as Partial<Record<StoragePathKind, string>>);
      setRootDraft(next.rootSource === 'custom' ? next.root : '');
    } catch (e) { if (mounted) setError(errorMessage(e)); }
  }, [mounted]);

  useEffect(() => {
    if (isDemo) return;
    void (async () => { setBusy(true); await load(); if (mounted) setBusy(false); })();
  }, [load, mounted]);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); await load(); await refreshMigration(); }
    catch (e) { setError(errorMessage(e)); }
    finally { if (mounted) setBusy(false); }
  }
  async function refreshMigration() {
    try { setPlan(await request<StoragePathMigrationPlan>('storage.paths.migration')); }
    catch { /* 没有历史路径时不显示迁移入口。 */ }
  }
  useEffect(() => { if (!isDemo) void refreshMigration(); }, []);

  async function probe(value: string, key: string) {
    if (!value.trim()) return;
    try { const result = await request<StoragePathProbe>('storage.paths.probe', { path: value }); setProbes(current => ({ ...current, [key]: result })); }
    catch (e) { setError(errorMessage(e)); }
  }
  async function choose(key: string, apply: (path: string) => void) {
    const paths = await (await getBridge()).chooseFiles({ kind: 'directory' });
    if (!paths[0]) return;
    apply(paths[0]);
    void probe(paths[0], key);
  }
  async function open(value: string) {
    try { await (await getBridge()).openPath(value); }
    catch (e) { setError(errorMessage(e)); }
  }
  async function save() {
    await run(async () => {
      const payload: Record<string, string | null> = {};
      if (rootDraft.trim()) payload.storageRoot = rootDraft.trim();
      for (const kind of ['datasets', 'uploads', 'chats'] as StoragePathKind[]) {
        const value = drafts[kind]?.trim();
        // 空字符串表示跟随存储根；显式清空时提交 null，保留时提交空串交由服务端忽略。
        if (value === undefined) continue;
        payload[`${kind}Root`] = value || null;
      }
      if (!Object.keys(payload).length) throw new Error('没有需要保存的改动。');
      setState(await request<StoragePathsState>('storage.paths.save', payload));
      setProbes({});
      notify('存储位置已保存，之后的新数据将写入新目录。');
    });
  }
  async function reset() {
    await run(async () => {
      setState(await request<StoragePathsState>('storage.paths.save', { storageRoot: null, datasetsRoot: null, uploadsRoot: null, chatsRoot: null }));
      setProbes({}); setRootDraft(''); setDrafts({});
      notify('已恢复为默认存储位置。');
    });
  }
  if (isDemo) return <section className="settings-section"><h2>存储位置</h2><Notice>浏览器演示不使用本地存储目录，请在桌面版本中配置。</Notice></section>;

  const probeHint = (key: string) => {
    const item = probes[key];
    if (!item) return undefined;
    return item.writable ? `可写${item.created ? '（已创建）' : ''}` : `不可用：${item.reason ?? '未知原因'}`;
  };
  const row = (entry: StoragePathEntry) => {
    const key = entry.kind;
    return <div className="setting-row" key={key}>
      <div><h3>{entry.label}</h3>
        <p className="break-word">当前：{entry.path}</p>
        <p className="muted tiny">来源 {sourceLabels[entry.source] ?? entry.source} · {entry.files} 个文件 · {bytes(entry.bytes)}</p>
        {entry.reason && <p className="inline-error">{entry.reason}</p>}
      </div>
      <div className="actions">
        <Button disabled={busy} onClick={() => void run(async () => { await open(entry.path); })}><FolderOpen size={13} />打开</Button>
        <Button disabled={busy} onClick={() => void choose(key, path => setDrafts(current => ({ ...current, [key]: path })))}>更改目录</Button>
        {entry.custom && <Button disabled={busy} onClick={() => void run(async () => {
          setState(await request<StoragePathsState>('storage.paths.save', { [`${key}Root`]: null }));
          notify(`「${entry.label}」已恢复为跟随存储根目录。`);
        })}><Undo2 size={13} />恢复默认</Button>}
      </div>
      {drafts[key] !== undefined && drafts[key] !== '' && <>
        <Field label={`新的${entry.label}目录`} hint={probeHint(key)}>
          <div className="input-action">
            <input readOnly aria-label={`新的${entry.label}目录`} value={drafts[key] ?? ''} placeholder="跟随存储根目录" />
            <Button disabled={busy} onClick={() => setDrafts(current => ({ ...current, [key]: '' }))}>清空</Button>
          </div>
        </Field>
        {probes[key] && !probes[key].writable && <p className="inline-error"><AlertTriangle size={13} /> {probes[key].reason}</p>}
      </>}
    </div>;
  };
  return <div className="storage-settings">
    <section className="settings-section">
      <div className="section-toolbar"><h2><Database size={17} />存储位置</h2>
        <Button disabled={busy} onClick={() => void run(async () => { await load(); await refreshMigration(); })}><RefreshCw size={13} />刷新</Button>
      </div>
      <p className="muted">划分好的训练集、用户上传的训练集与对话记录默认保存在安装目录，安装目录不可写时自动回退到当前用户目录。</p>
      <div className="setting-row">
        <div><h3>存储根目录</h3>
          <p className="break-word">当前：{state?.root ?? '正在读取…'}</p>
          <p className="muted tiny">安装目录 {state?.installDirectory ?? ''} · 来源 {sourceLabels[state?.rootSource ?? 'default']}</p>
          {state?.rootReason && <p className="inline-error">{state.rootReason}</p>}
        </div>
        <div className="actions">
          <Button disabled={busy || !state} onClick={() => void run(async () => { if (state) await open(state.root); })}><FolderOpen size={13} />打开</Button>
          <Button disabled={busy} onClick={() => void choose('root', path => { setRootDraft(path); })}>更改目录</Button>
          <Button disabled={busy} onClick={() => void reset()}><Undo2 size={13} />全部恢复默认</Button>
        </div>
        {rootDraft && <Field label="新的存储根目录" hint={probeHint('root')}>
          <div className="input-action">
            <input readOnly aria-label="新的存储根目录" value={rootDraft} placeholder="默认使用安装目录" />
            <Button disabled={busy} onClick={() => setRootDraft('')}>清空</Button>
          </div>
        </Field>}
      </div>
      {state?.entries.map(row)}
      <div className="actions"><Button className="primary" disabled={busy} busy={busy} onClick={() => void save()}><Save size={14} />保存存储位置</Button></div>
      <Notice>更改目录只影响之后产生的新数据，已有文件不会自动搬移。</Notice>
    </section>
    {!!plan?.candidates.length && <section className="settings-section">
      <h2>迁移已有数据</h2>
      <p className="muted">把上一次生效目录中的文件复制到当前目录。复制前会逐文件核对大小，失败只回滚失败目录，源目录始终保留。</p>
      {plan.candidates.map(candidate => <div className="setting-row" key={candidate.kind}>
        <div><h3>{candidate.label}</h3><p className="break-word tiny">{candidate.from} <ArrowRight size={12} /> {candidate.to}</p>
          <p className="muted tiny">{candidate.files} 个文件 · {bytes(candidate.bytes)}</p></div>
      </div>)}
      <div className="actions"><Button disabled={busy} onClick={() => void run(async () => {
        setMigrated(await request<StoragePathMigrationResult>('storage.paths.migrate'));
        notify('迁移完成，源目录已保留。');
      })}>复制并保留源目录</Button></div>
      {migrated && <div className="storage-result" role="status"><CheckCircle2 size={17} />
        <div><strong>已复制 {migrated.copiedFiles} 个文件 · {bytes(migrated.copiedBytes)}</strong>
          <small>跳过已存在 {migrated.skipped} 个{migrated.failures.length ? ` · 失败 ${migrated.failures.length} 项` : ''}</small></div></div>}
    </section>}
    {error && <p className="inline-error storage-error" role="alert">{error}</p>}
  </div>;
}
