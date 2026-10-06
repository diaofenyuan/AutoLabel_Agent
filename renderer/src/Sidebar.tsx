import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight, Eraser, FolderOpen, LayoutGrid, ListTodo, MessageSquare, MoreHorizontal, Pencil, Pin, PinOff, Plus, Scan, Search,
  Settings as SettingsIcon, Trash2, X,
} from 'lucide-react';
import type { ChatSessionSummary } from '../../shared/chat';
import type { Project } from './types';
import { isEditableTarget, useApp } from './context';
import { useActiveTaskCount } from './activeTasks';
import { useExampleProject } from './exampleProject';
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

/** 列表保留完整数据，首屏只展示常用数量，避免历史记录挤占导航空间。 */
const PROJECTS_VISIBLE = 6;
const SESSIONS_VISIBLE = 6;

type RenameTarget = { kind: 'session' | 'project'; id: string; value: string };

/** 项目与对话分开呈现：项目负责进入工作上下文，最近对话负责快速续接工作。 */
export function Sidebar({ inert = false, drawer = false, onClose }: { inert?: boolean; drawer?: boolean; onClose: () => void }) {
  const { page, navigate, project, projects, openProject, refreshProjects, chatSessions, refreshChatSessions, activeSessionId, setActiveSessionId, startProjectChat, openChatSession, requestDeleteProject, notify, engine } = useApp();
  // 侧栏「任务」徽标：进行中的长任务数量，切页也能看见还有多少在跑。
  const activeTasks = useActiveTaskCount();
  // 空态里的「载入示例项目」与欢迎页、设置页共用同一条链路，忙碌态也在这里判定。
  const example = useExampleProject();
  const [rename, setRename] = useState<RenameTarget | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [headerMenu, setHeaderMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [showAllSessions, setShowAllSessions] = useState(false);
  const [projectMenu, setProjectMenu] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  // 新建项目走命名弹框：项目不再自动取名，名称由用户在这里确定。
  const [creatingProject, setCreatingProject] = useState(false);
  useEffect(() => {
    if (!projectMenu && !headerMenu) return;
    // 菜单是悬浮层，会挡住下方的项目行：点外部或 Esc 都必须能收起，
    // 否则「会话管理」开着时用户点项目行会误触到菜单项（包括「清空全部对话」这种危险项）。
    const closeOnOutside = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest) return;
      if (target.closest('.sidebar-menu')) return;
      // 触发按钮交给自己的 onClick 取反，避免「先关再开」把菜单又弹回来。
      if (target.closest('button[aria-haspopup="menu"]')) return;
      setHeaderMenu(false); setProjectMenu('');
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setHeaderMenu(false); setProjectMenu(''); } };
    document.addEventListener('mousedown', closeOnOutside);
    window.addEventListener('keydown', closeOnEscape);
    return () => { document.removeEventListener('mousedown', closeOnOutside); window.removeEventListener('keydown', closeOnEscape); };
  }, [projectMenu, headerMenu]);
  // 菜单锚在行内：行贴近侧栏可视区底部时菜单会被滚动容器裁掉，放不下就改为向上展开。
  // 「会话管理」与「项目操作」可以同时开着（各自的按钮只切自己的状态），两个菜单的位置不同，
  // 必须分别判定：只量先出现的那个，贴在侧栏底部的项目菜单仍会被裁掉，菜单项点不到。
  const [menuFlip, setMenuFlip] = useState({ header: false, project: false });
  useLayoutEffect(() => {
    const overflows = (selector: string) => {
      const menu = document.querySelector(selector);
      const scroller = menu?.closest('.sidebar-scroll');
      if (!menu || !scroller) return false;
      return menu.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom > 4;
    };
    const next = { header: headerMenu ? overflows('.sidebar-menu.header-menu') : false, project: projectMenu ? overflows('.sidebar-menu.project-menu') : false };
    setMenuFlip(current => current.header === next.header && current.project === next.project ? current : next);
  }, [projectMenu, headerMenu]);

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
  /**
   * 侧栏项目按「当前优先 + 最近更新」排：接口返回的顺序不保证稳定，
   * 直接用会让正在用的项目在列表里跳来跳去，切一次项目就得重新找它。
   * 排序口径与欢迎页「继续最近项目」一致，两处看到的顺序不会互相矛盾。
   */
  const sortedProjects = useMemo(() => [...projects].sort((a, b) => {
    if (a.id === project?.id) return -1;
    if (b.id === project?.id) return 1;
    return String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''));
  }), [projects, project?.id]);
  /** 会话在最近列表只出现一次；置顶另列，避免它在项目列表与历史列表中重复。 */
  const recentSessions = useMemo(() => ordered.filter(item => !item.pinned), [ordered]);
  /** 置顶及最近会话要标明项目归属，列表脱离项目层级后仍保留上下文。 */
  const projectNameOf = useMemo(() => new Map(projects.map(item => [item.id, item.name])), [projects]);
  // 来源项目已被删除的会话不再展示：项目删除时会话已一并移入回收站，这里不再有对应的分组。
  /** Ctrl+1…9 的序号与 `ordered` 一致；把它显示出来，这条既有能力才不用靠帮助文档才发现。 */
  const shortcutOf = useMemo(() => new Map(ordered.slice(0, 9).map((item, index) => [item.id, index + 1])), [ordered]);

  /**
   * 会话属于项目：点开某条会话时要连同它的归属项目一起切过去，
   * 否则「置顶」或别的项目分组里的会话会在当前项目的上下文里被打开。
   */
  const openSession = useCallback(async (id: string) => {
    setHeaderMenu(false);
    await openChatSession(id).catch(error => notify(errorMessage(error), true));
  }, [openChatSession, notify]);
  const openSessionRef = useRef(openSession); openSessionRef.current = openSession;
  /**
   * 项目概览需要先把这个项目设为当前上下文，否则概览页拿不到数据。
   * 走 openProject 的同一套上下文切换（素材首屏、跨页勾选、抽帧跟踪一起重置），落点改为概览；
   * 概览不是会话页，因此不挑选也不新建会话。
   */
  async function openOverview(target: Project) {
    await run(async () => { await openProject(target, undefined, 'overview'); });
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
      // 快捷键与点击走同一条路径：跨项目开会话同样要先切项目上下文。
      void openSessionRef.current(target.id);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // 会话本身由 ref 提供：快捷键只跟 `ordered` 的顺序绑定，避免每次渲染都换一个监听器。
  }, [ordered]);

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

  /** 会话脱离项目分组后，在副标题上保留归属，标题优先拿到完整可读宽度。 */
  const sessionRow = (session: ChatSessionSummary, ownerName = '') => <div key={session.id} className={`sidebar-session ${activeSessionId === session.id ? 'selected' : ''}`}>
    <button className={`sidebar-row ${ownerName ? 'sidebar-session-row' : ''}`} title={`${session.title}${ownerName ? ` · ${ownerName}` : ''}`} aria-current={page === 'chat' && activeSessionId === session.id ? 'page' : undefined} onClick={() => void openSession(session.id)}>
      <MessageSquare size={15} /><span className="sidebar-row-title truncate">{session.title}</span>
      {ownerName && <small className="sidebar-session-owner truncate">{ownerName}</small>}
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
  /** 底部状态行的文案：顶栏 chip 只给状态，这里补上「这是本地工作空间」这层定位信息。 */
  const engineLabel = isDemo ? '本地演示 · 浏览器存储'
    : engine.state === 'ready' ? '本地工作空间 · 引擎已连接'
    : engine.state === 'starting' ? '本地工作空间 · 引擎启动中'
    : engine.state === 'stopped' ? '本地工作空间 · 引擎已停止'
    : '本地工作空间 · 引擎中断';
  return <aside id="app-sidebar" className="sidebar" role={isMobileDrawer ? 'dialog' : undefined} aria-label={isMobileDrawer ? '侧边导航' : undefined} aria-modal={isMobileDrawer ? true : undefined} inert={inert ? true : undefined}>
    <div className="sidebar-top">
      {/* 顶部只留产品标识与搜索：原先的下拉菜单里两项（快速跳转、帮助）在顶栏都已有入口。 */}
      <div className="sidebar-workspace"><Scan size={20} strokeWidth={1.8} /><span>自动标注小助手</span></div>
      <IconButton label="搜索项目和会话" onClick={() => { setSearchQuery(''); setSearchOpen(true); }}><Search size={16} /></IconButton>
      {isMobileDrawer && <IconButton label="关闭侧栏" onClick={onClose}><X size={16} /></IconButton>}
    </div>
    <div className="sidebar-scroll">
      <nav aria-label="主导航">{mainEntries.map(entry => <button key={entry.key} className="nav-item" aria-current={page === 'chat' && !activeSessionId ? 'page' : undefined} title={entry.label} onClick={() => void startProjectChat()}><entry.icon size={18} strokeWidth={1.65} /><span>{entry.label}</span></button>)}</nav>
      {pinned.length > 0 && <div className="sidebar-group sidebar-pinned"><div className="sidebar-group-head"><span className="sidebar-group-title">置顶</span><span className="sidebar-section-count">{pinned.length}</span></div>{pinned.map(session => sessionRow(session, projectNameOf.get(session.projectId ?? '') ?? '历史项目'))}</div>}
      <div className="sidebar-group sidebar-projects">
        {/* 「＋」弹出命名框：项目必须由用户命名，不再自动取名也不再只跳欢迎页。 */}
        <div className="sidebar-group-head"><span className="sidebar-group-title">项目</span><span className="sidebar-section-count">{sortedProjects.length}</span>
          <button className="sidebar-group-more" title="新建项目" aria-label="新建项目" onClick={() => setCreatingProject(true)}><Plus size={15} /></button>
        </div>
        {sortedProjects.length
          ? <>
            {(showAllProjects ? sortedProjects : sortedProjects.slice(0, PROJECTS_VISIBLE)).map(item => <div key={item.id} className="sidebar-project-group">
              <div className={`sidebar-project ${project?.id === item.id ? 'selected' : ''}`}>
                {/* 素材数直接写在项目行上：同名项目靠它区分，否则用户只能逐个点开看哪个有素材。 */}
                <button className="sidebar-row" title={`${item.name} · ${item.assetCount} 张素材`} aria-pressed={project?.id === item.id} onClick={() => void openProject(item).catch(e => notify(errorMessage(e), true))}><FolderOpen size={15} /><span className="sidebar-row-title truncate">{item.name}</span><span className="sidebar-project-count">{item.assetCount} 张</span></button>
                <span className="sidebar-actions"><button aria-label={`项目操作 ${item.name}`} aria-haspopup="menu" aria-expanded={projectMenu === item.id} title="项目操作" onClick={() => setProjectMenu(value => value === item.id ? '' : item.id)}><MoreHorizontal size={15} /></button></span>
                {projectMenu === item.id && <div className={`sidebar-menu project-menu ${menuFlip.project ? 'flip' : ''}`} role="menu" aria-label={`${item.name} 的项目操作`}>
                  <button role="menuitem" onClick={() => { setProjectMenu(''); void openOverview(item); }}><LayoutGrid size={14} />项目概览</button>
                  <button role="menuitem" onClick={() => { setProjectMenu(''); setRename({ kind: 'project', id: item.id, value: item.name }); }}><Pencil size={14} />重命名</button>
                  <button role="menuitem" onClick={() => { setProjectMenu(''); requestDeleteProject(item); }}><Trash2 size={14} />删除项目…</button>
                </div>}
              </div>
            </div>)}
            {sortedProjects.length > PROJECTS_VISIBLE && <button className="sidebar-more" onClick={() => setShowAllProjects(value => !value)}>
              {showAllProjects ? '收起项目' : `查看全部 ${sortedProjects.length} 个项目`}
            </button>}
          </>
          : <div className="sidebar-empty">
            <span className="sidebar-empty-icon"><FolderOpen size={16} /></span>
            <div><strong>从一个项目开始</strong><p>项目会保存素材、标注规范和相关对话。</p></div>
            <button className="sidebar-empty-primary" onClick={() => setCreatingProject(true)}><Plus size={14} />新建项目</button>
            <button className="sidebar-empty-secondary" disabled={busy || example.busy} onClick={() => void example.load()}><Scan size={14} />{example.busy ? '正在载入…' : '试用示例项目'}</button>
          </div>}
      </div>
      <div className="sidebar-group sidebar-recent">
        <div className="sidebar-group-head"><span className="sidebar-group-title">最近对话</span><span className="sidebar-section-count">{recentSessions.length}</span>
          <button className="sidebar-group-more" title="会话管理" aria-label="会话管理" aria-haspopup="menu" aria-expanded={headerMenu} onClick={() => setHeaderMenu(v => !v)}><MoreHorizontal size={15} /></button>
          {headerMenu && <div className={`sidebar-menu header-menu ${menuFlip.header ? 'flip' : ''}`} role="menu">
            <button role="menuitem" disabled={!chatSessions.length} title={!chatSessions.length ? '还没有对话可清空' : undefined} onClick={() => { setHeaderMenu(false); setConfirmClear(true); }}><Eraser size={14} />清空全部对话…</button>
            <button role="menuitem" onClick={() => { setHeaderMenu(false); void navigate('settings', 'chats'); }}><SettingsIcon size={14} />对话记录设置…</button>
          </div>}
        </div>
        {recentSessions.length > 0 ? <>
          {(showAllSessions ? recentSessions : recentSessions.slice(0, SESSIONS_VISIBLE)).map(session => sessionRow(session, projectNameOf.get(session.projectId ?? '') ?? '历史项目'))}
          {recentSessions.length > SESSIONS_VISIBLE && <button className="sidebar-more" onClick={() => setShowAllSessions(value => !value)}>
            {showAllSessions ? '收起对话' : `查看全部 ${recentSessions.length} 条对话`}
          </button>}
        </> : <p className="sidebar-recent-empty">项目中的对话会显示在这里</p>}
      </div>
    </div>
    <div className="sidebar-bottom">
      {/*
        这行和顶栏的引擎 chip 是同一份状态，但引擎不正常时它是侧栏里唯一还亮着的入口：
        点它直接落到设置·诊断，比让用户先看见顶栏横幅再回来找设置少绕一圈。
        正常状态下没有可修的东西，退回纯文本，不给一个点了没用的按钮。
      */}
      {(!isDemo && engine.state !== 'ready')
        ? <button className="sidebar-status" title={engine.message || '打开诊断'} onClick={() => void navigate('settings', 'diagnostics')}><span className={`status-dot ${engine.state}`} /><span className="truncate">{engineLabel}</span><ArrowRight size={12} /></button>
        : <div className="sidebar-status" title={isDemo ? '浏览器演示' : engine.message || '本地引擎状态'}><span className={`status-dot ${engine.state}`} /><span className="truncate">{engineLabel}</span></div>}
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
