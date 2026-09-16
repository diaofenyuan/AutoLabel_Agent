import { useEffect, useMemo, useState } from 'react';
import {
  Eraser, FolderOpen, ListTodo, MessageSquare, MoreHorizontal, Pencil, Pin, PinOff, Plus, Scan, Search,
  Settings as SettingsIcon, Trash2,
} from 'lucide-react';
import type { ChatSessionSummary } from '../../shared/chat';
import { useApp } from './context';
import { errorMessage, isDemo, request } from './bridge';
import { Button, Field, IconButton, Modal } from './ui';

/**
 * 会话挂在项目下，导航里不再有「新建对话」：新对话由欢迎页按描述建项目后开始。
 * 主导航只剩任务，设置固定在底部。
 */
const mainEntries = [
  { key: 'tasks', label: '任务', icon: ListTodo },
] as const;

/** 单个项目在侧栏里最多展开的会话数，超出的在项目页里看，避免侧栏被历史会话淹掉。 */
const SESSIONS_PER_PROJECT = 5;

type RenameTarget = { kind: 'session' | 'project'; id: string; value: string };

/** Codex 式侧栏：顶部 / 主入口 / 置顶 / 项目 / 最近 / 底部六段，会话来自 chat.history.list。 */
export function Sidebar() {
  const { page, navigate, project, projects, openProject, refreshProjects, chatSessions, refreshChatSessions, activeSessionId, setActiveSessionId, startProjectChat, openJumper, requestDeleteProject, notify, engine } = useApp();
  const [rename, setRename] = useState<RenameTarget | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [headerMenu, setHeaderMenu] = useState(false);
  const [busy, setBusy] = useState(false);

  // 置顶按 pinOrder、其余按 lastMessageAt 倒序，Ctrl+1…9 与置顶共用同一序列。
  const ordered = useMemo(() => [...chatSessions].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.pinned) return (a.pinOrder || 0) - (b.pinOrder || 0);
    return b.lastMessageAt.localeCompare(a.lastMessageAt);
  }), [chatSessions]);
  const pinned = ordered.filter(item => item.pinned);
  // 会话按项目归组：项目行下面直接列出该项目的会话，进对话一律从项目走。
  const grouped = useMemo(() => projects.map(item => ({
    project: item,
    sessions: ordered.filter(session => session.projectId === item.id).slice(0, SESSIONS_PER_PROJECT),
  })), [projects, ordered]);
  // 来源项目已被删除的历史会话仍要能看到，单独成组；判据用会话自身状态，不靠项目列表是否已刷新。
  const orphaned = ordered.filter(session => session.status === 'deleted-project');
  /** Ctrl+1…9 的序号与 `ordered` 一致；把它显示出来，这条既有能力才不用靠帮助文档才发现。 */
  const shortcutOf = useMemo(() => new Map(ordered.slice(0, 9).map((item, index) => [item.id, index + 1])), [ordered]);

  async function openSession(id: string) { setActiveSessionId(id); setHeaderMenu(false); await navigate('chat'); }
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      const index = Number(event.key);
      if (!Number.isInteger(index) || index < 1 || index > 9) return;
      const target = ordered[index - 1];
      if (!target) return;
      event.preventDefault();
      setActiveSessionId(target.id);
      setHeaderMenu(false);
      void navigate('chat');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [ordered, navigate, setActiveSessionId]);

  async function run(action: () => Promise<void>, message?: string) {
    if (busy) return;
    setBusy(true);
    try { await action(); if (message) notify(message); }
    catch (e) { notify(errorMessage(e), true); }
    finally { setBusy(false); }
  }
  async function togglePin(session: ChatSessionSummary) {
    await run(async () => { await request('chat.history.pin', { sessionId: session.id, pinned: !session.pinned }); await refreshChatSessions(); });
  }
  async function removeSession(session: ChatSessionSummary) {
    await run(async () => {
      await request('chat.history.delete', { sessionIds: [session.id] });
      if (activeSessionId === session.id) setActiveSessionId('');
      await refreshChatSessions();
    }, `已将「${session.title}」移入回收站。`);
  }
  async function clearSessions() {
    await run(async () => {
      const result = await request<{ removed: number }>('chat.history.clear', {});
      setConfirmClear(false);
      await refreshChatSessions();
      notify(`已移入回收站 ${result.removed} 个对话。`);
    });
  }
  async function submitRename(event: React.FormEvent) {
    event.preventDefault();
    if (!rename) return;
    setBusy(true);
    try {
      if (rename.kind === 'session') { await request('chat.history.rename', { sessionId: rename.id, title: rename.value.trim() }); await refreshChatSessions(); }
      else { await request('project.update', { projectId: rename.id, name: rename.value.trim() }); await refreshProjects(); }
      setRename(null);
    } catch (e) { notify(errorMessage(e), true); }
    finally { setBusy(false); }
  }

  const sessionRow = (session: ChatSessionSummary) => <div key={session.id} className={`sidebar-session ${activeSessionId === session.id ? 'selected' : ''}`}>
    <button className="sidebar-row" title={session.title} onClick={() => void openSession(session.id)}>
      <MessageSquare size={15} /><span className="sidebar-row-title truncate">{session.title}</span>
      {session.status === 'deleted-project' && <span className="sidebar-tag" title="来源项目已删除">项目已删除</span>}
    </button>
    {/* 行尾提示与悬浮操作占同一位置：静止时给快捷键，悬浮时让位给操作按钮。 */}
    {shortcutOf.has(session.id) && <kbd className="sidebar-shortcut">{`Ctrl+${shortcutOf.get(session.id)}`}</kbd>}
    <span className="sidebar-actions">
      <button title="重命名" onClick={() => setRename({ kind: 'session', id: session.id, value: session.title })}><Pencil size={13} /></button>
      <button title={session.pinned ? '取消置顶' : '置顶'} aria-pressed={session.pinned} onClick={() => void togglePin(session)}>{session.pinned ? <PinOff size={13} /> : <Pin size={13} />}</button>
      <button title="删除" onClick={() => void removeSession(session)}><Trash2 size={13} /></button>
    </span>
  </div>;

  return <aside className="sidebar">
    <div className="sidebar-top">
      {/* 顶部只留产品标识与搜索：原先的下拉菜单里两项（快速跳转、帮助）在顶栏都已有入口。 */}
      <div className="sidebar-workspace"><Scan size={20} strokeWidth={1.8} /><span>自动标注小助手</span></div>
      <IconButton label="搜索" onClick={openJumper}><Search size={16} /></IconButton>
    </div>
    <div className="sidebar-scroll">
      <nav aria-label="主导航">{mainEntries.map(entry => <button key={entry.key} className={`nav-item ${page === entry.key ? 'selected' : ''}`} aria-current={page === entry.key ? 'page' : undefined} title={entry.label} onClick={() => void navigate(entry.key)}><entry.icon size={18} strokeWidth={1.65} /><span>{entry.label}</span></button>)}</nav>
      {pinned.length > 0 && <div className="sidebar-group"><div className="sidebar-group-head"><span className="sidebar-group-title">置顶</span></div>{pinned.map(sessionRow)}</div>}
      <div className="sidebar-group">
        {/* 「＋」回到欢迎页：新对话要先有项目，由欢迎页按描述建好项目再开始。 */}
        <div className="sidebar-group-head"><span className="sidebar-group-title">项目</span>
          <button className="sidebar-group-more" title="新建项目" aria-label="新建项目" onClick={() => void startProjectChat()}><Plus size={15} /></button>
          <button className="sidebar-group-more" title="会话管理" aria-label="会话管理" aria-haspopup="menu" aria-expanded={headerMenu} onClick={() => setHeaderMenu(v => !v)}><MoreHorizontal size={15} /></button>
          {headerMenu && <div className="sidebar-menu" role="menu">
            <button role="menuitem" disabled={!chatSessions.length} onClick={() => { setHeaderMenu(false); setConfirmClear(true); }}><Eraser size={14} />清空全部对话…</button>
            <button role="menuitem" onClick={() => { setHeaderMenu(false); void navigate('settings'); }}><SettingsIcon size={14} />对话记录设置…</button>
          </div>}
        </div>
        {projects.length
          ? grouped.map(({ project: item, sessions }) => <div key={item.id} className="sidebar-project-group">
            <div className={`sidebar-project ${project?.id === item.id ? 'selected' : ''}`}>
              <button className="sidebar-row" title={item.name} onClick={() => void openProject(item).catch(e => notify(errorMessage(e), true))}><FolderOpen size={15} /><span className="sidebar-row-title truncate">{item.name}</span></button>
              <span className="sidebar-actions">
                <button title="重命名" onClick={() => setRename({ kind: 'project', id: item.id, value: item.name })}><Pencil size={13} /></button>
                <button title="删除项目…" onClick={() => requestDeleteProject(item)}><Trash2 size={13} /></button>
              </span>
            </div>
            {sessions.length > 0 && <div className="sidebar-sublist">{sessions.map(sessionRow)}</div>}
          </div>)
          : <p className="sidebar-empty">还没有项目，用一句话描述要标注什么就会建好。</p>}
      </div>
      {orphaned.length > 0 && <div className="sidebar-group">
        <div className="sidebar-group-head"><span className="sidebar-group-title">项目已删除</span></div>
        {orphaned.map(sessionRow)}
      </div>}
    </div>
    <div className="sidebar-bottom">
      {/* 顶栏已经有一个引擎状态 chip，侧栏不再重复两行文案，只留一条能看清「本地 / 状态」的行。 */}
      <div className="sidebar-status" title={isDemo ? '浏览器演示' : engine.message || '本地引擎状态'}>
        <span className={`status-dot ${engine.state}`} />
        <span className="truncate">{isDemo ? '本地演示 · 浏览器存储' : engine.state === 'ready' ? '本地工作空间 · 引擎已连接' : engine.state === 'starting' ? '本地工作空间 · 引擎启动中' : engine.state === 'stopped' ? '本地工作空间 · 引擎已停止' : '本地工作空间 · 引擎中断'}</span>
      </div>
      <button className="nav-item" aria-current={page === 'settings' ? 'page' : undefined} title="设置" onClick={() => void navigate('settings')}><SettingsIcon size={18} strokeWidth={1.65} /><span>设置</span></button>
    </div>
    {rename && <Modal title={rename.kind === 'session' ? '重命名对话' : '重命名项目'} onClose={() => setRename(null)}><form onSubmit={submitRename} className="form-stack"><Field label="名称"><input autoFocus maxLength={rename.kind === 'session' ? 120 : 80} value={rename.value} onChange={e => setRename({ ...rename, value: e.target.value })} /></Field><div className="modal-actions"><Button type="button" onClick={() => setRename(null)}>取消</Button><Button className="primary" type="submit" busy={busy} disabled={!rename.value.trim()}>保存</Button></div></form></Modal>}
    {confirmClear && <Modal title="清空全部对话" onClose={() => setConfirmClear(false)}><div className="form-stack"><p>全部 {chatSessions.length} 个对话会先移入回收站并保留 7 天，可在此期间从回收站恢复。</p><div className="modal-actions"><Button type="button" onClick={() => setConfirmClear(false)}>取消</Button><Button className="primary" busy={busy} onClick={() => void clearSessions()}>确认清空</Button></div></div></Modal>}
  </aside>;
}
