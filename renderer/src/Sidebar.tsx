import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight, Eraser, FolderOpen, LayoutGrid, ListTodo, MessageSquare, MoreHorizontal, Pencil, Pin, PinOff, Plus, Scan, Search,
  Settings as SettingsIcon, Trash2, X,
} from 'lucide-react';
import type { ChatSessionSummary } from '../../shared/chat';
import type { Project } from './types';
import { isEditableTarget, useApp } from './context';
import { useActiveTaskCount } from './activeTasks';
import { errorMessage, isDemo, request } from './bridge';
import { Button, Field, IconButton, Modal } from './ui';
import ProjectResolveDialog from './ProjectResolveDialog';
import { applyProjectDraft } from './projectSetup';

/**
 * 会话挂在项目下，导航里不再有「新建对话」：新对话由欢迎页按描述建项目后开始。
 * 主导航只剩「新对话」这一项动作与底部的设置；任务与流程都回到对话里发起，进度在对话的任务卡片回看。
 */
const mainEntries = [
  { key: 'new-chat', label: '新对话', icon: Plus },
] as const;

/**
 * 侧栏的显示上限：项目和会话都会越攒越多，默认只显示最近的一小段，其余折叠成一行提示。
 * 数量本身不丢，展开就能看到全部。
 */
const PROJECTS_VISIBLE = 6;
const SESSIONS_PER_PROJECT = 3;
const ORPHANED_VISIBLE = 3;

type RenameTarget = { kind: 'session' | 'project'; id: string; value: string };

/** Codex 式侧栏：顶部 / 主入口 / 置顶 / 项目 / 最近 / 底部六段，会话来自 chat.history.list。 */
export function Sidebar({ inert = false, drawer = false, onClose }: { inert?: boolean; drawer?: boolean; onClose: () => void }) {
  const { page, navigate, project, projects, openProject, refreshProjects, chatSessions, refreshChatSessions, activeSessionId, setActiveSessionId, startProjectChat, requestDeleteProject, notify, engine, setProject } = useApp();
  // 侧栏「任务」徽标：进行中的长任务数量，切页也能看见还有多少在跑。
  const activeTasks = useActiveTaskCount();
  const [rename, setRename] = useState<RenameTarget | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [headerMenu, setHeaderMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [showAllOrphaned, setShowAllOrphaned] = useState(false);
  const [expandedProjects, setExpandedProjects] = useState<string[]>([]);
  const [projectMenu, setProjectMenu] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  // 新建项目走命名弹框：项目不再自动取名，名称由用户在这里确定。
  const [creatingProject, setCreatingProject] = useState(false);
  useEffect(() => {
    if (!projectMenu) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setProjectMenu(''); } };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [projectMenu]);

  // 置顶按 pinOrder、其余按 lastMessageAt 倒序，Ctrl+1…9 与置顶共用同一序列。
  const ordered = useMemo(() => [...chatSessions].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.pinned) return (a.pinOrder || 0) - (b.pinOrder || 0);
    return b.lastMessageAt.localeCompare(a.lastMessageAt);
  }), [chatSessions]);
  const query = searchQuery.trim().toLocaleLowerCase('zh-CN');
  const matchingProjects = query ? projects.filter(item => item.name.toLocaleLowerCase('zh-CN').includes(query)).slice(0, 8) : [];
  const matchingSessions = query ? ordered.filter(item => item.title.toLocaleLowerCase('zh-CN').includes(query)).slice(0, 8) : [];
  const pinned = ordered.filter(item => item.pinned);
  // 会话按项目归组：项目行下面直接列出该项目的会话，进对话一律从项目走。
  // 每组默认只留最近几条，展开后才是全部。
  const grouped = useMemo(() => projects.map(item => {
    const sessions = ordered.filter(session => session.projectId === item.id);
    return { project: item, total: sessions.length,
      sessions: expandedProjects.includes(item.id) ? sessions : sessions.slice(0, SESSIONS_PER_PROJECT) };
  }), [projects, ordered, expandedProjects]);
  // 来源项目已被删除的历史会话仍要能看到，单独成组；判据用会话自身状态，不靠项目列表是否已刷新。
  const orphaned = ordered.filter(session => session.status === 'deleted-project');
  /** Ctrl+1…9 的序号与 `ordered` 一致；把它显示出来，这条既有能力才不用靠帮助文档才发现。 */
  const shortcutOf = useMemo(() => new Map(ordered.slice(0, 9).map((item, index) => [item.id, index + 1])), [ordered]);

  async function openSession(id: string) { setActiveSessionId(id); setHeaderMenu(false); await navigate('chat'); }
  /** 项目概览需要先把这个项目设为当前上下文，否则概览页拿不到数据。 */
  async function openOverview(target: Project) {
    await run(async () => {
      setProject(await request<Project>('project.open', { projectId: target.id }));
      await navigate('overview');
    });
  }
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || isEditableTarget(event.target) || document.querySelector('dialog[open]')) return;
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
    <button className="sidebar-row" title={session.title} aria-current={page === 'chat' && activeSessionId === session.id ? 'page' : undefined} onClick={() => void openSession(session.id)}>
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

  const isMobileDrawer = !inert && drawer;
  return <aside id="app-sidebar" className="sidebar" role={isMobileDrawer ? 'dialog' : undefined} aria-label={isMobileDrawer ? '侧边导航' : undefined} aria-modal={isMobileDrawer ? true : undefined} inert={inert ? true : undefined}>
    <div className="sidebar-top">
      {/* 顶部只留产品标识与搜索：原先的下拉菜单里两项（快速跳转、帮助）在顶栏都已有入口。 */}
      <div className="sidebar-workspace"><Scan size={20} strokeWidth={1.8} /><span>自动标注小助手</span></div>
      <IconButton label="搜索项目和会话" onClick={() => { setSearchQuery(''); setSearchOpen(true); }}><Search size={16} /></IconButton>
      {isMobileDrawer && <IconButton label="关闭侧栏" onClick={onClose}><X size={16} /></IconButton>}
    </div>
    <div className="sidebar-scroll">
      <nav aria-label="主导航">{mainEntries.map(entry => <button key={entry.key} className="nav-item" aria-current={page === 'chat' && !activeSessionId ? 'page' : undefined} title={entry.label} onClick={() => void startProjectChat()}><entry.icon size={18} strokeWidth={1.65} /><span>{entry.label}</span></button>)}</nav>
      {pinned.length > 0 && <div className="sidebar-group"><div className="sidebar-group-head"><span className="sidebar-group-title">置顶</span></div>{pinned.map(sessionRow)}</div>}
      <div className="sidebar-group">
        {/* 「＋」弹出命名框：项目必须由用户命名，不再自动取名也不再只跳欢迎页。 */}
        <div className="sidebar-group-head"><span className="sidebar-group-title">项目</span>
          <button className="sidebar-group-more" title="新建项目" aria-label="新建项目" onClick={() => setCreatingProject(true)}><Plus size={15} /></button>
          <button className="sidebar-group-more" title="会话管理" aria-label="会话管理" aria-haspopup="menu" aria-expanded={headerMenu} onClick={() => setHeaderMenu(v => !v)}><MoreHorizontal size={15} /></button>
          {headerMenu && <div className="sidebar-menu" role="menu">
            <button role="menuitem" disabled={!chatSessions.length} title={!chatSessions.length ? '还没有对话可清空' : undefined} onClick={() => { setHeaderMenu(false); setConfirmClear(true); }}><Eraser size={14} />清空全部对话…</button>
            <button role="menuitem" onClick={() => { setHeaderMenu(false); void navigate('settings', 'chats'); }}><SettingsIcon size={14} />对话记录设置…</button>
          </div>}
        </div>
        {grouped.length
          ? <>
            {(showAllProjects ? grouped : grouped.slice(0, PROJECTS_VISIBLE)).map(({ project: item, sessions, total }) => <div key={item.id} className="sidebar-project-group">
              <div className={`sidebar-project ${project?.id === item.id ? 'selected' : ''}`}>
                {/* 素材数直接写在项目行上：同名项目靠它区分，否则用户只能逐个点开看哪个有素材。 */}
                <button className="sidebar-row" title={`${item.name} · ${item.assetCount} 张素材`} aria-pressed={project?.id === item.id} onClick={() => void openProject(item).catch(e => notify(errorMessage(e), true))}><FolderOpen size={15} /><span className="sidebar-row-title truncate">{item.name}</span><span className="sidebar-project-count">{item.assetCount} 张</span></button>
                <span className="sidebar-actions"><button aria-label={`项目操作 ${item.name}`} aria-haspopup="menu" aria-expanded={projectMenu === item.id} title="项目操作" onClick={() => setProjectMenu(value => value === item.id ? '' : item.id)}><MoreHorizontal size={15} /></button></span>
                {projectMenu === item.id && <div className="sidebar-menu" role="menu" aria-label={`${item.name} 的项目操作`}>
                  <button role="menuitem" onClick={() => { setProjectMenu(''); void openOverview(item); }}><LayoutGrid size={14} />项目概览</button>
                  <button role="menuitem" onClick={() => { setProjectMenu(''); setRename({ kind: 'project', id: item.id, value: item.name }); }}><Pencil size={14} />重命名</button>
                  <button role="menuitem" onClick={() => { setProjectMenu(''); requestDeleteProject(item); }}><Trash2 size={14} />删除项目…</button>
                </div>}
              </div>
              {sessions.length > 0 && <div className="sidebar-sublist">{sessions.map(sessionRow)}</div>}
              {total > SESSIONS_PER_PROJECT && <button className="sidebar-more" onClick={() => setExpandedProjects(list => list.includes(item.id) ? list.filter(id => id !== item.id) : [...list, item.id])}>
                {expandedProjects.includes(item.id) ? '收起会话' : `还有 ${total - sessions.length} 条会话`}
              </button>}
            </div>)}
            {grouped.length > PROJECTS_VISIBLE && <button className="sidebar-more" onClick={() => setShowAllProjects(value => !value)}>
              {showAllProjects ? '收起项目' : `全部项目（共 ${grouped.length} 个）`}
            </button>}
          </>
          : <p className="sidebar-empty">还没有项目，用一句话描述要标注什么就会建好。</p>}
      </div>
      {orphaned.length > 0 && <div className="sidebar-group">
        <div className="sidebar-group-head"><span className="sidebar-group-title">项目已删除</span></div>
        {(showAllOrphaned ? orphaned : orphaned.slice(0, ORPHANED_VISIBLE)).map(sessionRow)}
        {orphaned.length > ORPHANED_VISIBLE && <button className="sidebar-more" onClick={() => setShowAllOrphaned(value => !value)}>
          {showAllOrphaned ? '收起' : `还有 ${orphaned.length - ORPHANED_VISIBLE} 条`}
        </button>}
      </div>}
    </div>
    <div className="sidebar-bottom">
      {/* 顶栏已经有一个引擎状态 chip，侧栏不再重复两行文案，只留一条能看清「本地 / 状态」的行。 */}
      <div className="sidebar-status" title={isDemo ? '浏览器演示' : engine.message || '本地引擎状态'}>
        <span className={`status-dot ${engine.state}`} />
        <span className="truncate">{isDemo ? '本地演示 · 浏览器存储' : engine.state === 'ready' ? '本地工作空间 · 引擎已连接' : engine.state === 'starting' ? '本地工作空间 · 引擎启动中' : engine.state === 'stopped' ? '本地工作空间 · 引擎已停止' : '本地工作空间 · 引擎中断'}</span>
      </div>
      {/* 任务不再是主导航项：长任务在对话里发起，看板留在底部次要入口，进行中的数量仍以徽标提示。 */}
      <button className="nav-item" aria-current={page === 'tasks' ? 'page' : undefined} title="任务" onClick={() => void navigate('tasks')}><ListTodo size={18} strokeWidth={1.65} /><span>任务</span>{activeTasks > 0 && <span className="nav-badge" aria-label={`进行中的任务 ${activeTasks} 个`}>{activeTasks}</span>}</button>
      <button className="nav-item" aria-current={page === 'settings' ? 'page' : undefined} title="设置" onClick={() => void navigate('settings')}><SettingsIcon size={18} strokeWidth={1.65} /><span>设置</span></button>
    </div>
    {creatingProject && <ProjectResolveDialog title="新建项目" confirmLabel="创建项目" projects={projects} allowExisting={false}
      onClose={() => setCreatingProject(false)}
      onConfirm={async choice => {
        if (choice.mode !== 'create') throw new Error('请填写项目名称。');
        let created = await request<Project>('project.create', { name: choice.name.slice(0, 80), taskType: choice.taskType });
        // 新建时就落下的类别与标注要求，与「类别与点位模板」走同一条通路。
        created = await applyProjectDraft(created.id, choice.classes, choice.rules) ?? created;
        await refreshProjects();
        // 建好直接进入该项目的新对话，不发首条消息，交给用户继续描述。
        await openProject(created);
        setCreatingProject(false);
      }} />}
    {searchOpen && <Modal title="搜索项目和会话" onClose={() => setSearchOpen(false)}><div className="command-palette sidebar-search-palette">
      <label className="command-search"><Search size={16} aria-hidden="true"/><input autoFocus aria-label="搜索项目和会话" placeholder="输入项目名或会话标题…" value={searchQuery} onChange={event => setSearchQuery(event.target.value)}/></label>
      {!query ? <p className="quiet-empty">输入关键词，搜索项目和会话。</p> : <div className="sidebar-search-results">
        {matchingProjects.length > 0 && <section aria-label="匹配的项目"><h3>项目</h3><div className="command-list">{matchingProjects.map(item => <button key={item.id} aria-label={`打开项目 ${item.name}`} onClick={() => { setSearchOpen(false); void openProject(item).catch(e => notify(errorMessage(e), true)); }}><span className="command-icon"><FolderOpen size={16}/></span><span className="truncate">{item.name}</span><small>{item.assetCount} 张素材</small><ArrowRight size={14}/></button>)}</div></section>}
        {matchingSessions.length > 0 && <section aria-label="匹配的会话"><h3>会话</h3><div className="command-list">{matchingSessions.map(item => <button key={item.id} aria-label={`打开会话 ${item.title}`} onClick={() => { setSearchOpen(false); void openSession(item.id); }}><span className="command-icon"><MessageSquare size={16}/></span><span className="truncate">{item.title}</span><small>{projects.find(target => target.id === item.projectId)?.name ?? '项目不可用'}</small><ArrowRight size={14}/></button>)}</div></section>}
        {!matchingProjects.length && !matchingSessions.length && <p className="quiet-empty">没有匹配的项目或会话。</p>}
      </div>}
    </div></Modal>}
    {rename && <Modal title={rename.kind === 'session' ? '重命名对话' : '重命名项目'} onClose={() => setRename(null)}><form onSubmit={submitRename} className="form-stack"><Field label="名称"><input autoFocus maxLength={rename.kind === 'session' ? 120 : 80} value={rename.value} onChange={e => setRename({ ...rename, value: e.target.value })} /></Field><div className="modal-actions"><Button type="button" onClick={() => setRename(null)}>取消</Button><Button className="primary" type="submit" busy={busy} disabled={!rename.value.trim()}>保存</Button></div></form></Modal>}
    {confirmClear && <Modal title="清空全部对话" onClose={() => setConfirmClear(false)}><div className="form-stack"><p>全部 {chatSessions.length} 个对话会先移入回收站并保留 7 天，可在此期间从回收站恢复。</p><div className="modal-actions"><Button type="button" onClick={() => setConfirmClear(false)}>取消</Button><Button className="primary" busy={busy} onClick={() => void clearSessions()}>确认清空</Button></div></div></Modal>}
  </aside>;
}
