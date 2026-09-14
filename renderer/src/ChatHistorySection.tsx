import { useCallback, useEffect, useState } from 'react';
import { FolderOpen, RefreshCw, Trash2, Download, ShieldCheck } from 'lucide-react';
import type { ChatHistoryStatus, ChatMutationResult } from '../../shared/chat';
import { useApp } from './context';
import { errorMessage, getBridge, isDemo, request } from './bridge';
import { Button, Notice } from './ui';

function bytes(value: number) {
  return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GB` : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(2)} MB`
    : value >= 1024 ? `${(value / 1024).toFixed(1)} KB` : `${value} 字节`;
}

/** 对话记录的占用、回收站与导出入口；删除一律先进回收站，保留 7 天。 */
export default function ChatHistorySection({ onBusyChange }: { onBusyChange: (busy: boolean) => void }) {
  const { notify } = useApp();
  const [status, setStatus] = useState<ChatHistoryStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [mounted, setMounted] = useState(true);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => () => { setMounted(false); }, []);

  const load = useCallback(async () => {
    try { const next = await request<ChatHistoryStatus>('chat.history.status'); if (mounted) setStatus(next); }
    catch (e) { if (mounted) setError(errorMessage(e)); }
  }, [mounted]);
  useEffect(() => { if (!isDemo) void (async () => { setBusy(true); await load(); if (mounted) setBusy(false); })(); }, [load, mounted]);

  async function run(action: () => Promise<void>, message?: string) {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); await load(); if (message) notify(message); }
    catch (e) { setError(errorMessage(e)); }
    finally { if (mounted) setBusy(false); }
  }
  async function exportAll() {
    const target = await (await getBridge()).saveFile({ title: '导出全部对话记录', defaultPath: `对话记录-${new Date().toISOString().slice(0, 10)}.json`, extension: 'json' });
    if (!target) return;
    await run(async () => {
      const result = await request<{ sessions: number }>('chat.history.export', { targetPath: target });
      notify(`已导出 ${result.sessions} 个对话。`);
    });
  }
  if (isDemo) return <section className="settings-section"><h2>对话记录</h2><Notice>浏览器演示不保存本地对话记录，请在桌面版本中使用。</Notice></section>;
  return <div className="storage-settings">
    <section className="settings-section">
      <div className="section-toolbar"><h2>对话记录</h2>
        <Button disabled={busy} onClick={() => void run(async () => { await load(); })}><RefreshCw size={13} />刷新</Button>
      </div>
      <p className="storage-data-dir break-word" aria-label="对话记录目录">{status?.root ?? '正在读取…'}</p>
      {status && <div className="storage-usage" aria-label="对话记录占用">
        <p>{status.sessions} 个对话 · {status.messages} 条消息 · {bytes(status.bytes)}</p>
        <p>回收站 {status.trash.entries} 项 · {bytes(status.trash.bytes)} · 保留 {status.trash.retentionDays} 天</p>
      </div>}
      {status?.warning && <p className="inline-error">{status.warning}</p>}
      <div className="actions">
        <Button disabled={busy || !status} onClick={() => void run(async () => { if (status) await (await getBridge()).openPath(status.root); })}><FolderOpen size={14} />打开目录</Button>
        <Button disabled={busy || !status?.sessions} onClick={() => void exportAll()}><Download size={14} />导出全部</Button>
        <Button disabled={busy || !status?.trash.entries} onClick={() => void run(async () => {
          const result = await request<ChatMutationResult>('chat.history.purge', { all: true });
          notify(`已清空回收站 ${result.removed} 项。`);
        })}><Trash2 size={14} />清空回收站</Button>
      </div>
      <Notice><ShieldCheck size={16} />对话记录只保存在本机，接口密钥不会写入记录；导出的文件请自行保管。</Notice>
    </section>
    <section className="settings-section">
      <h2>清空全部对话</h2>
      <p className="muted">全部对话会先移入回收站并保留 {status?.trash.retentionDays ?? 7} 天，可在此期间从回收站恢复。</p>
      {!confirmClear
        ? <Button disabled={busy || !status?.sessions} onClick={() => setConfirmClear(true)}><Trash2 size={14} />清空全部对话…</Button>
        : <div className="actions">
          <Button disabled={busy} onClick={() => setConfirmClear(false)}>取消</Button>
          <Button className="primary" disabled={busy} busy={busy} onClick={() => void run(async () => {
            const result = await request<ChatMutationResult>('chat.history.clear', {});
            setConfirmClear(false);
            notify(`已移入回收站 ${result.removed} 个对话。`);
          })}>确认清空 {status?.sessions ?? 0} 个对话</Button>
        </div>}
    </section>
    {error && <p className="inline-error storage-error" role="alert">{error}</p>}
  </div>;
}
