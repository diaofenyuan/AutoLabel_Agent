import { useEffect, useRef, useState } from 'react';
import { FolderOpen, RefreshCw, Save, Database, CheckCircle2, Trash2 } from 'lucide-react';
import type { BackupCreated, BackupInspection, BackupPreflight, BackupProgress, BackupSummary, RestorePreparation, StorageStatus, StorageUsage, StorageCleanup } from '../../shared/storage';
import { useApp } from './context';
import { errorMessage, getBridge, isDemo, request } from './bridge';
import { Button, Field, Notice } from './ui';

const phases: Record<string, string> = { idle: '就绪', guarding: '检查当前运行状态', waiting: '等待在途操作结束', preparing: '准备恢复副本', 'backing-up': '写入备份', stopping: '停止原目录引擎', verifying: '验证副本和新引擎', committing: '提交数据目录切换', 'rolling-back': '恢复原目录', 'maintenance-uncertain': '正在确认维护操作是否结束' };
function bytes(value: number) { return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GB` : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(2)} MB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KB` : `${value} 字节`; }
function Summary({ value }: { value: BackupSummary }) {
  return <div className="storage-summary"><strong>{value.fileCount} 个文件 · {bytes(value.totalBytes)}</strong><span>数据格式版本 {value.schemaVersion} · 不包含 API Key</span>{[...value.issues, ...value.warnings].map((issue, i) => <div className="issue-detail" key={`${issue.code}-${i}`}><p>{issue.message}</p>{issue.target && <small className="break-word">{issue.target}</small>}<small>{issue.code}</small></div>)}</div>;
}
export default function StorageSettings({ onBusyChange }: { onBusyChange: (busy: boolean) => void }) {
  const { guard, events, notify } = useApp();
  const [status, setStatus] = useState<StorageStatus | null>(null);
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [reading, setReading] = useState(!isDemo);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [outputDir, setOutputDir] = useState('');
  const [preflight, setPreflight] = useState<BackupPreflight | null>(null);
  const [created, setCreated] = useState<BackupCreated | null>(null);
  const [backupPath, setBackupPath] = useState('');
  const [inspection, setInspection] = useState<BackupInspection | null>(null);
  const [targetParent, setTargetParent] = useState('');
  const [preparation, setPreparation] = useState<RestorePreparation | null>(null);
  const [migrationParent, setMigrationParent] = useState('');
  const [eventStart, setEventStart] = useState<number | null>(null);
  const operation = useRef(false), mounted = useRef(true);
  const busy = working || Boolean(status?.busy);
  const disabled = busy || reading || !status;
  const event = eventStart === null ? undefined : events.filter(e => e.type === 'backup.progress' && e.sequence > eventStart).at(-1);
  const progress = event?.payload as unknown as BackupProgress | undefined;
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => {
    mounted.current = true;
    if (isDemo) return;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try { const next = await request<StorageStatus>('storage.status'); const size = await request<StorageUsage>('storage.usage'); if (mounted.current) { setStatus(next); setUsage(size); } }
      catch (e) { if (mounted.current) setError(errorMessage(e)); }
      finally { if (mounted.current) { setReading(false); timer = setTimeout(() => void poll(), 1000); } }
    }
    void poll();
    return () => { mounted.current = false; clearTimeout(timer); onBusyChange(false); };
  }, [onBusyChange]);
  async function perform(action: () => Promise<void>) {
    if (operation.current || busy) return;
    operation.current = true;
    try {
      await guard.current?.();
      setWorking(true); setError(''); setEventStart(events.at(-1)?.sequence ?? 0);
      await action();
    } catch (e) { if (mounted.current) setError(errorMessage(e)); }
    finally {
      operation.current = false;
      if (mounted.current) {
        setWorking(false);
        try { setStatus(await request<StorageStatus>('storage.status')); setUsage(await request<StorageUsage>('storage.usage')); } catch (e) { setError(errorMessage(e)); }
      }
    }
  }
  async function choose(kind: 'directory' | 'backup', apply: (path: string) => void) { const paths = await (await getBridge()).chooseFiles({ kind }); if (paths[0]) apply(paths[0]); }
  async function inspectBackup() { const result = await request<BackupInspection>('backup.inspect', { backupPath }); setInspection(result); }
  async function createBackup() {
    // 保存时再次由引擎预检，目录选择后的旧检查不能代替当前数据状态。
    const check = await request<BackupPreflight>('backup.preflight', { outputDir }); setPreflight(check);
    if (!check.ready) throw new Error('预检尚未通过，请处理下方问题后重试。');
    const result = await request<BackupCreated>('backup.create', { outputDir }); setCreated(result); notify('本地备份已保存。');
  }
  if (isDemo) return <section className="settings-section"><h2>工作空间</h2><Notice>当前数据位于本浏览器的 IndexedDB。数据目录、备份与恢复需要桌面引擎。</Notice></section>;
  return <div className="storage-settings">
    <section className="settings-section"><div className="section-toolbar"><h2><Database size={17}/>数据目录</h2><Button disabled={busy || reading} onClick={() => void perform(async () => { setStatus(await request<StorageStatus>('storage.status')); setUsage(await request<StorageUsage>('storage.usage')); })}><RefreshCw size={13}/>刷新存储状态</Button></div><p className="storage-data-dir break-word" aria-label="当前数据目录">{status?.dataDir ?? '正在读取实际目录…'}</p><div className="storage-state" role="status">{reading ? '正在读取存储状态…' : status ? phases[status.phase] ?? status.phase : '存储状态读取失败'}{working && !status?.busy && ' · 正在处理当前操作'}</div>{status?.error && <p className="inline-error">{status.error.message}（{status.error.code}）</p>}{usage && <div className="storage-usage" aria-label="数据占用"><p>项目与素材 {bytes(usage.projectBytes)} · 过程文件 {bytes(usage.processBytes)} · 数据库 {bytes(usage.databaseBytes)}</p><p>可清理临时缓存 {bytes(usage.cacheBytes)} · 数据总计 {bytes(usage.totalBytes)}</p><Button disabled={disabled || usage.cacheBytes === 0} onClick={() => void perform(async () => { const result = await request<StorageCleanup>('storage.cleanup'); setUsage(result); notify(result.removedBytes ? `已清理 ${bytes(result.removedBytes)} 个临时文件。` : '没有可安全清理的临时文件。'); })}><Trash2 size={14}/>清理可重建临时文件</Button></div>}{progress && Number.isFinite(progress.completedFiles) && Number.isFinite(progress.totalFiles) && <div className="storage-progress">{progress.phase === 'completed' ? '文件处理完成' : progress.phase === 'verifying' ? '正在核对文件' : '正在复制文件'} · {progress.completedFiles} / {progress.totalFiles} 个文件 · {bytes(progress.copiedBytes)} / {bytes(progress.totalBytes)}</div>}<Notice>备份包含项目、图片、标注和已保存草稿，不包含 API Key。恢复外部备份后需要重新绑定密钥；本机迁移保留当前密钥。</Notice></section>
    <section className="settings-section"><h2>保存备份</h2><Field label="备份保存目录" hint="选择当前数据目录之外的文件夹。引擎在其中新建备份文件。"><div className="input-action"><input readOnly aria-label="备份保存目录" value={outputDir} placeholder="请选择文件夹"/><Button disabled={disabled} onClick={() => void perform(() => choose('directory', path => { setOutputDir(path); setPreflight(null); setCreated(null); }))}><FolderOpen size={14}/>选择备份目录</Button></div></Field><div className="actions"><Button disabled={disabled || !outputDir} onClick={() => void perform(async () => { setPreflight(await request<BackupPreflight>('backup.preflight', { outputDir })); })}>检查备份条件</Button><Button className="primary" disabled={disabled || !outputDir || !preflight?.ready} onClick={() => void perform(createBackup)}><Save size={14}/>保存本地备份</Button></div>{preflight && <><Summary value={preflight}/><p className="muted tiny">{preflight.ready ? '预检通过' : '预检未通过'} · 可用空间 {bytes(preflight.availableBytes)}</p></>}{created && <div className="storage-result" role="status"><CheckCircle2 size={17}/><div><strong>备份已保存</strong><p className="break-word" aria-label="已保存备份文件">{created.backupPath}</p><small>{created.fileCount} 个文件 · {bytes(created.totalBytes)}</small></div></div>}</section>
    <section className="settings-section"><h2>从备份恢复到新目录</h2><Field label="备份文件"><div className="input-action"><input readOnly aria-label="备份文件" value={backupPath} placeholder="选择备份归档"/><Button disabled={disabled} onClick={() => void perform(() => choose('backup', path => { setBackupPath(path); setInspection(null); setPreparation(null); }))}><FolderOpen size={14}/>选择备份文件</Button></div></Field><Button disabled={disabled || !backupPath} onClick={() => void perform(async () => { setInspection(null); setPreparation(null); await inspectBackup(); })}>检查备份文件</Button>{inspection && <><Summary value={inspection}/><p className="muted tiny">备份创建于 {new Date(inspection.createdAt).toLocaleString('zh-CN')}</p></>}<Field label="恢复副本所在父目录" hint="将在此新建独立副本，原数据目录会保留。"><div className="input-action"><input readOnly aria-label="恢复副本所在父目录" value={targetParent} placeholder="请选择新父目录"/><Button disabled={disabled} onClick={() => void perform(() => choose('directory', path => { setTargetParent(path); setPreparation(null); }))}><FolderOpen size={14}/>选择恢复目录</Button></div></Field><Button disabled={disabled || !inspection || !targetParent} onClick={() => void perform(async () => { setPreparation(null); const result = await request<RestorePreparation>('restore.prepare', { backupPath, targetParent }); setPreparation(result); notify('恢复副本已准备好，可核对后切换。'); })}>准备恢复副本</Button>{preparation && <div className="storage-activation"><Notice>副本已准备。切换后应用会重新加载，新副本的接口密钥需要重新绑定。原数据目录继续保留。</Notice><Button className="primary" disabled={disabled} onClick={() => void perform(async () => { const preparationId = preparation.preparationId; setPreparation(null); await request('storage.activate', { preparationId }); })}>切换到恢复副本</Button></div>}</section>
    <section className="settings-section"><h2>迁移本机数据目录</h2><p className="muted">复制当前工作空间到新目录并切换，保留本机 API Key 和原数据目录。</p><Field label="迁移目标父目录"><div className="input-action"><input readOnly aria-label="迁移目标父目录" value={migrationParent} placeholder="请选择新父目录"/><Button disabled={disabled} onClick={() => void perform(() => choose('directory', path => { setMigrationParent(path); }))}><FolderOpen size={14}/>选择迁移目录</Button></div></Field><Button className="primary" disabled={disabled || !migrationParent} onClick={() => void perform(async () => { await request('storage.migrate', { targetParent: migrationParent }); })}>复制并切换</Button></section>
    {error && <p className="inline-error storage-error" role="alert">{error}</p>}
  </div>;
}
