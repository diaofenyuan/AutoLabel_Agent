import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { PanelLeftClose, PanelLeftOpen, CircleHelp, ChevronRight, X, Minus, Square, Check, AlertCircle, Keyboard, LoaderCircle, Search, ArrowRight } from 'lucide-react';
import { Context, blankChatSession, navAll, navLabel, type Page, type ChatSession, type SettingsSection } from './context';
import { getBridge, isDemo, request, errorMessage } from './bridge';
import type { Project, Asset, Preferences, Provider, EngineEvent, EngineStatus } from './types';
import { defaultPreferences } from './types';
import type { ChatHistoryList, ChatSessionSummary } from '../../shared/chat';
import { IconButton, Modal } from './ui';
import { Sidebar } from './Sidebar';
import { ProjectDeletionDialog } from './ProjectDeletion';
import ChatHome from './ChatHome';
import ChatPanel from './ChatPanel';
import ProjectOverview from './ProjectOverview';
const Tasks = lazy(() => import('./Tasks'));
const Settings = lazy(() => import('./Settings'));
export default function App() {
  const [page, setPage] = useState<Page>(() => { const hash = location.hash.slice(1); return navAll.some(entry => entry.key === hash) ? hash as Page : 'chat'; });
  const [mediaTaskId, setMediaTaskId] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [deletion, setDeletion] = useState<Project | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const assetPageSize = 100;
  const [assetOffset, setAssetOffset] = useState(0);
  const [assetTotal, setAssetTotal] = useState(0);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
  // 工作台视图与当前素材随会话存活：切页会卸载工作台，这两项留在页面里就会丢。
  const [workbenchView, setWorkbenchView] = useState<'images' | 'video'>('images');
  const [activeAssetId, setActiveAssetId] = useState<string | null>(null);
  // 正在跟踪的抽帧任务同样随会话存活，用户中途离开工作台再回来不会丢掉进度卡与自动导入。
  const [mediaJob, setMediaJob] = useState<{ id: string; temporarySource?: string } | null>(null);
  const assetLocation = useRef({ projectId: '', offset: 0 });
  const assetRevision = useRef(0);
  /**
   * 页面切换 / 打开项目的互斥锁。用令牌而不是布尔值：只有持锁的那次操作才能释放它，
   * 否则「先发起、后结束」的导航会把另一次操作刚上的锁清掉，两条流程叠着跑，页面最终落在谁那里就不确定了。
   */
  const transitionOwner = useRef<symbol | null>(null);
  const beginTransition = useCallback(() => { const token = Symbol('transition'); transitionOwner.current = token; return token; }, []);
  const endTransition = useCallback((token: symbol) => { if (transitionOwner.current === token) transitionOwner.current = null; }, []);
  const [prefs, setPrefs] = useState<Preferences>(defaultPreferences);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [chats, setChats] = useState<Record<string, ChatSession>>({});
  const [chatSessions, setChatSessions] = useState<ChatSessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState('');
  const [engine, setEngine] = useState<EngineStatus>({ state: 'starting' });
  const [reconnecting, setReconnecting] = useState(false);
  const [events, setEvents] = useState<EngineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [help, setHelp] = useState(false);
  const [commandPalette, setCommandPalette] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [commandSelection, setCommandSelection] = useState(0);
  const [toast, setToast] = useState<{ id: number; message: string; error: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const guard = useRef<null | (() => Promise<void>)>(null);
  const dirtySources = useRef(new Set<string>());
  const syncWindowDirtySource = useCallback((source: string, dirty: boolean) => {
    if (isDemo) return;
    if (dirty) dirtySources.current.add(source); else dirtySources.current.delete(source);
    void getBridge().then(bridge => bridge.setWindowDirty(dirtySources.current.size > 0)).catch(() => {});
  }, []);
  const notify = useCallback((message: string, error = false) => { clearTimeout(toastTimer.current); setToast({ id: Date.now(), message, error }); toastTimer.current = setTimeout(() => setToast(null), error ? 9000 : 4500); }, []);
  const refreshProjects = useCallback(async () => { const list = await request<Project[]>('project.list'); setProjects(list); setProject(current => current ? list.find(p => p.id === current.id) ?? current : current); }, []);
  const refreshProviders = useCallback(async () => { setProviders(await request<Provider[]>('provider.list')); }, []);
  const refreshChatSessions = useCallback(async (projectId?: string) => {
    const result = await request<ChatHistoryList>('chat.history.list', projectId ? { projectId } : {});
    setChatSessions(result.sessions);
  }, []);
  const openJumper = useCallback(() => { setCommandQuery(''); setCommandSelection(0); setCommandPalette(true); }, []);
  const openHelp = useCallback(() => setHelp(true), []);
  const refreshAssets = useCallback(async () => {
    const { projectId, offset } = assetLocation.current;
    if (!projectId || transitionOwner.current) return;
    const revision = ++assetRevision.current;
    let result = await request<{ items: Asset[]; total: number }>('asset.list', { projectId, offset, limit: assetPageSize });
    const nextOffset = Math.min(offset, Math.max(0, Math.ceil(result.total / assetPageSize) - 1) * assetPageSize);
    if (nextOffset !== offset) result = await request('asset.list', { projectId, offset: nextOffset, limit: assetPageSize });
    if (revision !== assetRevision.current) return;
    assetLocation.current = { projectId, offset: nextOffset };
    setAssets(result.items); setAssetOffset(nextOffset); setAssetTotal(result.total);
  }, []);
  const loadAssetPage = useCallback(async (offset: number) => {
    if (transitionOwner.current) throw new Error('素材正在切换，请稍后。');
    const { projectId } = assetLocation.current;
    if (!projectId) return [];
    const token = beginTransition(); setAssetsLoading(true); ++assetRevision.current;
    try {
      // 先封住新的编辑，再排空当前草稿；读取失败时保留原页和选中图片。
      await guard.current?.();
      let nextOffset = Math.max(0, Math.floor(offset / assetPageSize) * assetPageSize);
      let result = await request<{ items: Asset[]; total: number }>('asset.list', { projectId, offset: nextOffset, limit: assetPageSize });
      const lastOffset = Math.max(0, Math.ceil(result.total / assetPageSize) - 1) * assetPageSize;
      if (nextOffset > lastOffset) { nextOffset = lastOffset; result = await request('asset.list', { projectId, offset: nextOffset, limit: assetPageSize }); }
      assetLocation.current = { projectId, offset: nextOffset };
      setAssets(result.items); setAssetOffset(nextOffset); setAssetTotal(result.total);
      return result.items;
    } finally { endTransition(token); setAssetsLoading(false); }
  }, [beginTransition, endTransition]);
  // 设置页每次进入都会重挂载，落点区块只能由这里记住；`section` 由调用方按需指定，未指定即回到默认区块。
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('appearance');
  const navigate = useCallback(async (next: Page, section?: SettingsSection) => {
    if (transitionOwner.current) return;
    const token = beginTransition(); setAssetsLoading(true);
    try { await guard.current?.(); clearTimeout(toastTimer.current); setToast(null); setPage(next); setSettingsSection(section ?? 'appearance'); history.replaceState(null, '', `#${next}`); }
    catch (e) { notify(`草稿未保存，已保留当前页面。${errorMessage(e)}`, true); }
    finally { endTransition(token); setAssetsLoading(false); }
  }, [notify, beginTransition, endTransition]);
  /**
   * 打开项目 = 进入该项目的会话上下文，而不是落到某个页面上。
   * 会话必须属于项目：优先接着这个项目最近的会话，没有就开一条新的；带 firstMessage 时新会话会把这条消息自动发出去。
   */
  const openProject = useCallback(async (selected: Project, firstMessage?: string) => {
    if (transitionOwner.current) throw new Error('素材正在切换，请稍后。');
    const token = beginTransition(); setAssetsLoading(true); ++assetRevision.current;
    try {
      await guard.current?.();
      const opened = await request<Project>('project.open', { projectId: selected.id });
      const data = await request<{ items: Asset[]; total: number }>('asset.list', { projectId: selected.id, offset: 0, limit: assetPageSize });
      assetLocation.current = { projectId: selected.id, offset: 0 };
      setSelectedAssetIds([]); setAssetOffset(0); setAssetTotal(data.total); setAssets(data.items);
      // 换项目等同于换上下文：视图与当前素材必须重置，否则会带着上一个项目的选择进来。
      setWorkbenchView('images'); setActiveAssetId(null); setMediaJob(null);
      clearTimeout(toastTimer.current); setToast(null); setProject(opened);
      const recent = firstMessage ? undefined : chatSessions.filter(session => session.projectId === opened.id)
        .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))[0];
      if (recent) setActiveSessionId(recent.id);
      else {
        const id = crypto.randomUUID();
        setChats(state => ({ ...state, [id]: { ...blankChatSession(id, 'project'), ...(firstMessage ? { input: firstMessage, sendOnOpen: true } : {}) } }));
        setActiveSessionId(id);
        await request('chat.history.ensure', { sessionId: id, projectId: opened.id, projectName: opened.name, title: firstMessage ?? '新对话' });
      }
      await refreshChatSessions();
      setPage('chat'); history.replaceState(null, '', '#chat');
    } finally { endTransition(token); setAssetsLoading(false); }
  }, [chatSessions, refreshChatSessions, beginTransition, endTransition]);
  /**
   * 新建对话只能发生在项目内：这里只是把界面交回欢迎页，由用户描述要标注什么，
   * 再由欢迎页建好项目并开会话（会话不脱离项目存在）。
   */
  const startProjectChat = useCallback(async () => {
    setActiveSessionId('');
    await navigate('chat');
  }, [navigate]);
  const requestDeleteProject = useCallback((target: Project) => setDeletion(target), []);
  /** 删除完成后清理状态：被删除的项目不再保持打开，工作台回到对话主页；对话历史仍保留。 */
  const projectDeleted = useCallback(async (projectId: string) => {
    await refreshProjects().catch(() => undefined);
    setProject(current => current?.id === projectId ? null : current);
    await refreshChatSessions().catch(() => undefined);
    await navigate('chat');
  }, [refreshProjects, refreshChatSessions, navigate]);
  const savePrefs = useCallback(async (next: Preferences) => { await request('settings.save', { settings: next }); setPrefs(next); }, []);
  useEffect(() => {
    let disposed = false; const unsubscribe: Array<() => void> = [];
    const seen = new Set<number>();
    async function load() {
      try {
        const bridge = await getBridge();
        if (disposed) return;
        let statusRevision = 0;
        unsubscribe.push(bridge.onEngineStatus(status => { statusRevision++; setEngine(status); if (status.state === 'ready') { void refreshProjects().catch(e => notify(errorMessage(e), true)); void refreshProviders().catch(() => {}); void refreshChatSessions().catch(() => {}); } }));
        unsubscribe.push(bridge.onEvent(event => { if (seen.has(event.sequence)) return; seen.add(event.sequence); if (seen.size > 2000) seen.delete(seen.values().next().value!); setEvents(list => [...list, event].slice(-200)); }));
        const initialRevision = statusRevision;
        const initial = await Promise.allSettled([bridge.engineStatus(), request<Project[]>('project.list'), request<Preferences>('settings.get'), request<Provider[]>('provider.list'), request<EngineEvent[]>('event.list', { after: 0 }), request<ChatHistoryList>('chat.history.list')]);
        if (disposed) return;
        const [status, list, settings, ps, historyEvents, history] = initial;
        // 初始化请求可能早于握手完成，不能覆盖订阅已收到的更新状态。
        if (status.status === 'fulfilled' && statusRevision === initialRevision) setEngine(status.value);
        if (list.status === 'fulfilled') setProjects(list.value); else notify(errorMessage(list.reason), true);
        if (settings.status === 'fulfilled') setPrefs({ ...defaultPreferences, ...settings.value });
        if (ps.status === 'fulfilled') setProviders(ps.value);
        if (historyEvents.status === 'fulfilled' && Array.isArray(historyEvents.value)) setEvents(current => [...new Map([...historyEvents.value, ...current].map(e => [e.sequence, e])).values()].sort((a,b) => a.sequence - b.sequence).slice(-200));
        // 启动只恢复会话列表；不预先选中任何一条，首屏才会停在欢迎页（选会话是用户的动作）。
        if (history.status === 'fulfilled') setChatSessions(history.value.sessions);
        else notify(errorMessage(history.reason), true);
      } catch (e) { if (!disposed) notify(errorMessage(e), true); }
      finally { if (!disposed) setLoading(false); }
    }
    void load();
    return () => { disposed = true; unsubscribe.forEach(fn => fn()); };
  }, [notify, refreshProjects, refreshProviders, refreshChatSessions]);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { document.documentElement.dataset.theme = prefs.theme === 'system' ? (media.matches ? 'dark' : 'light') : prefs.theme; document.documentElement.dataset.reducedMotion = String(prefs.reducedMotion); };
    apply(); media.addEventListener('change', apply); return () => media.removeEventListener('change', apply);
  }, [prefs.theme, prefs.reducedMotion]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault(); setCommandQuery(''); setCommandSelection(0); setCommandPalette(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  const commandItems = navAll.filter(entry => !commandQuery.trim() || entry.label.includes(commandQuery.trim()));
  useEffect(() => {
    if (!commandPalette) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setCommandPalette(false); return; }
      if (event.key === 'ArrowDown' && commandItems.length) { event.preventDefault(); setCommandSelection(index => (index + 1) % commandItems.length); return; }
      if (event.key === 'ArrowUp' && commandItems.length) { event.preventDefault(); setCommandSelection(index => (index - 1 + commandItems.length) % commandItems.length); return; }
      if (event.key === 'Enter' && commandItems.length) { event.preventDefault(); const entry = commandItems[commandSelection] ?? commandItems[0]; setCommandPalette(false); void navigate(entry.key); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [commandPalette, commandItems, commandSelection, navigate]);
  const busyChat = Object.values(chats).find(chat => chat.busy);
  async function reconnect() {
    if (reconnecting) return;
    setReconnecting(true);
    try { setEngine(await (await getBridge()).restartEngine()); }
    catch (e) { notify(errorMessage(e), true); }
    finally { setReconnecting(false); }
  }
  return <Context.Provider value={{ page, navigate, settingsSection, mediaTaskId, setMediaTaskId, projects, project, assets, assetOffset, assetTotal, assetPageSize, assetsLoading, loadAssetPage, selectedAssetIds, setSelectedAssetIds, setAssets, setProject, openProject, refreshProjects, refreshAssets, workbenchView, setWorkbenchView, activeAssetId, setActiveAssetId, mediaJob, setMediaJob, prefs, setPrefs, savePrefs, providers, refreshProviders, syncWindowDirtySource, events, engine, loading, notify, guard, chats, setChats, chatSessions, refreshChatSessions, activeSessionId, setActiveSessionId, startProjectChat, openJumper, openHelp, requestDeleteProject }}>
    <div className={`app-shell ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <Sidebar />
      {deletion && <ProjectDeletionDialog project={deletion} onClose={() => setDeletion(null)} onDeleted={projectId => void projectDeleted(projectId)} />}
      <section className="app-main"><header className="topbar" onDoubleClick={e => { if (!isDemo && !(e.target as HTMLElement).closest('button,input,select,textarea')) void getBridge().then(b => b.windowAction('maximize')); }}><div className="breadcrumb"><IconButton label={collapsed ? '展开侧栏' : '收起侧栏'} onClick={() => setCollapsed(v => !v)}>{collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}</IconButton><span>{navLabel(page)}</span>{project && page !== 'chat' && <><ChevronRight size={13} /><span className="muted truncate">{project.name}</span></>}</div><div className="topbar-actions">{isDemo && <span className="demo-indicator">演示模式</span>}{!isDemo && <span className={`engine-chip ${engine.state}`} role={engine.state === 'error' ? 'alert' : 'status'} title={engine.message || '本地引擎状态'}><span className="status-dot" />{engine.state === 'ready' ? '引擎已连接' : engine.state === 'starting' ? '引擎启动中' : engine.state === 'disconnected' ? '引擎已中断' : engine.state === 'stopped' ? '引擎已停止' : '引擎异常'}</span>}<button className="command-trigger" onClick={openJumper}><Search size={14} /><span>快速跳转</span><kbd>Ctrl K</kbd></button><IconButton label="快捷键与帮助" onClick={openHelp}><CircleHelp size={17} /></IconButton>{!isDemo && <div className="window-actions">{(['minimize', 'maximize', 'close'] as const).map((action, index) => <button key={action} aria-label={['最小化窗口', '最大化窗口', '关闭窗口'][index]} onClick={() => void getBridge().then(b => b.windowAction(action)).catch(e => notify(errorMessage(e), true))}>{index === 0 ? <Minus size={13} /> : index === 1 ? <Square size={11} /> : <X size={14} />}</button>)}</div>}</div></header>
        {!isDemo && engine.state !== 'ready' && <div className="connection-banner" role={engine.state === 'error' ? 'alert' : 'status'} aria-live="polite" aria-busy={reconnecting}><AlertCircle size={14} />{reconnecting ? '正在重新连接本地引擎…' : engine.message || '本地引擎尚未就绪，数据操作暂不可用。'}<button disabled={reconnecting} onClick={() => void reconnect()}>{reconnecting ? '连接中…' : '重新连接'}</button></div>}
        <main className={`page page-${page}`} key={page} aria-busy={loading || assetsLoading}>
          {loading ? <div className="page-loading" role="status"><LoaderCircle className="spin" size={20} />加载工作空间…</div> : <Suspense fallback={<div className="page-loading" role="status"><LoaderCircle className="spin" size={20} />加载工作区…</div>}>
            {page === 'chat' ? (activeSessionId ? <ChatPanel /> : <ChatHome />) : page === 'overview' ? <ProjectOverview /> : page === 'tasks' ? <Tasks /> : <Settings />}
          </Suspense>}
        </main>
      </section>
    </div>
    {toast && <div key={toast.id} className={`toast ${toast.error ? 'error' : ''}`} role={toast.error ? 'alert' : 'status'}>{toast.error ? <AlertCircle size={17} /> : <Check size={17} />}<span>{toast.message}</span><IconButton label="关闭提示" onClick={() => setToast(null)}><X size={14} /></IconButton></div>}
    {help && <Modal title="快捷键与帮助" onClose={() => setHelp(false)}><div className="help-content"><Keyboard size={26} /><p>人工标注在素材预览里完成：打开项目概览或对话结果中的任意素材，点「编辑标注」进入画布；画完点「保存」写入正式标注，核对无误再点「保存并确认」。也可以直接在对话里说明要改什么。</p><dl className="shortcuts">{[['完成当前多边形', 'Enter'], ['取消当前绘制', 'Escape'], ['删除选中的多边形顶点', 'Delete'], ['发送对话消息', 'Ctrl + Enter'], ['打开快速跳转', 'Ctrl + K'], ['切换到前九个对话', 'Ctrl + 1…9']].map(([label,key]) => <div key={label}><dt>{label}</dt><dd><kbd>{key}</kbd></dd></div>)}</dl><p className="muted">{isDemo ? '当前为隔离的浏览器演示。图片与标注保存在本浏览器；API 调用、真实任务及 YOLO 导出需要桌面引擎。' : '图片坐标以引擎提供的基准图为准。模型候选与人工确认分别记录。'}</p></div></Modal>}
    {commandPalette && <Modal title="快速跳转" onClose={() => setCommandPalette(false)}><div className="command-palette"><label className="command-search"><Search size={16} /><input autoFocus value={commandQuery} onChange={event => { setCommandQuery(event.target.value); setCommandSelection(0); }} placeholder="搜索页面…" /></label><div className="command-list">{commandItems.map((entry, index) => <button key={entry.key} className={index === commandSelection ? 'selected' : ''} aria-selected={index === commandSelection} onMouseEnter={() => setCommandSelection(index)} onClick={() => { setCommandPalette(false); void navigate(entry.key); }}><span className="command-icon"><entry.icon size={16} /></span><span>{entry.label}</span><ArrowRight size={14} /></button>)}{!commandItems.length && <p className="quiet-empty">没有匹配的页面。</p>}</div><p className="command-hint"><kbd>↑↓</kbd> 选择 · <kbd>Enter</kbd> 打开 · <kbd>Esc</kbd> 关闭</p></div></Modal>}
    {busyChat && <div className="global-chat-status" role="status"><LoaderCircle size={14} className="spin" /><span>助手执行中 · {busyChat.runningScope}</span><ButtonCancel id={busyChat.id} notify={notify} /></div>}
  </Context.Provider>;
}
function ButtonCancel({ id, notify }: { id: string; notify: (message: string, error?: boolean) => void }) { return <button onClick={() => void request('agent.cancel', { sessionId: id }).catch(e => notify(errorMessage(e), true))}>停止</button>; }
