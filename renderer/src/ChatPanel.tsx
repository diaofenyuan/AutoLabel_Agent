import { resolveConfiguration } from '../../shared/configuration';
import type { ChatSession as StoredChatSession } from '../../shared/chat';
import ConfigurationView from './ConfigurationView';
import ReferencePicker from './ReferencePicker';
import ResultCard from './ResultCard';
import VideoImport from './VideoImport';
import { AgentSteps, PlanCard, useAgentSteps, type AgentStep } from './AgentActivity';
import { TaskCards } from './TaskCards';
import ModelPicker from './ModelPicker';
import FlowPicker from './FlowPicker';
import LocalModelPicker from './LocalModelPicker';
import ClassPicker from './ClassPicker';
import DirectRun from './DirectRun';
import { DropOverlay } from './fileDrop';
import { VideoPickList, useChatFileDrop, importAttachments } from './chatDrop';
import { RichText } from './chatText';
import { useEffect, useRef, useState } from 'react';
import { MessageSquare, Settings2, FolderOpen, Sparkles, ChevronDown } from 'lucide-react';
import { blankChatSession, useApp, type ChatSession } from './context';
import { request, getBridge, isDemo, errorMessage } from './bridge';
import { Composer, Button, Empty } from './ui';

type ChatMessageData = { role: 'user' | 'assistant'; content: string };

/**
 * 空会话的起手式：不是模板，只是把「一句话能说清什么」摆给第一次用的人。
 * 点一下填进输入框，用户仍然可以在发送前改。
 */
const sampleRequests = [
  '把这些图里的车辆和行人框出来',
  '先筛掉模糊和重复的图，再标注剩下的',
  '把已确认的标注导出成 YOLO 数据集',
];

function ChatMessage({ message, previousUser, onEdit, onRetry, onCopy }: { message: ChatMessageData; previousUser?: string; onEdit: (text: string) => void; onRetry: (text: string) => void; onCopy: (text: string) => void }) {
  const failed = message.role === 'assistant' && message.content.startsWith('本次调用未完成：');
  return <div className={`chat-message ${message.role} ${failed ? 'chat-message-failed' : ''}`}>
    <div className="chat-message-head"><span className={`chat-avatar ${message.role}`} aria-hidden="true">{message.role === 'assistant' ? <Sparkles size={12} /> : '你'}</span><small>{message.role === 'user' ? '你' : '标注助手'}</small></div>
    <div className="chat-text">{failed&&<span className="chat-error-label">这次没有完成</span>}<RichText text={message.content}/></div>
    <div className="chat-message-actions" aria-label="消息操作">
      <button type="button" onClick={() => onCopy(message.content)}>复制</button>
      {message.role === 'user' && <button type="button" onClick={() => onEdit(message.content)}>编辑</button>}
      {message.role === 'assistant' && previousUser && <button type="button" onClick={() => onRetry(previousUser)}>重试上一条</button>}
    </div>
  </div>;
}

/**
 * 会话页：一条会话一个消息流，状态按会话标识存放。
 * 消息落盘由主进程负责，这里只在首次打开某条会话时读回一次，之后以内存状态为准。
 */
export default function ChatPanel({ compact = false, assetId, sessionId }: { compact?: boolean; assetId?: string; sessionId?: string }) {
  const { project, setProject, prefs, notify, navigate, startProjectChat, chats, setChats, assets, assetTotal, selectedAssetIds, assetsLoading, providers, events, activeSessionId, refreshChatSessions, refreshAssets, setMediaJob, setMediaTaskId, pendingVideoImports, setPendingVideoImports } = useApp();
  const chatConfig=resolveConfiguration('chat',prefs,project?.settings);
  const annotationConfig=resolveConfiguration('annotation',prefs,project?.settings);
  // 拖入文件只在会话页生效；工作台里的紧凑面板由工作台自己管导入。
  // 拖进来的文件先挂进当前会话的附件条，发送时才导入项目。
  const drop = useChatFileDrop(items => {
    if (!key) return;
    setChats(state => {
      const current = state[key] ?? blankChatSession(key);
      const known = new Set((current.attachments ?? []).map(item => item.path));
      const fresh = items.filter(item => !known.has(item.path));
      if (!fresh.length) return state;
      return { ...state, [key]: { ...current, attachments: [...(current.attachments ?? []), ...fresh] } };
    });
  });
  const dropActive = compact ? false : drop.active;
  const key = sessionId ?? activeSessionId;
  const sessionOverride = key ? chats[key] : undefined;
  // 会话级覆盖优先，未改过就用设置里的默认值（见实施计划 6.2）。
  const selectedProviderId = sessionOverride?.providerId ?? chatConfig.providerId;
  const selectedModel = sessionOverride?.model ?? chatConfig.model;
  const depth = sessionOverride?.depth ?? prefs.chatThinkingDepth;
  // 新建会话先渲染空态，消息在首次发送或读盘后写入；工作台里的内嵌面板仍然以「当前图片」为默认范围。
  const session = key ? chats[key] ?? blankChatSession(key, compact && assetId ? 'current' : 'project') : undefined;
  const chatsRef = useRef(chats); chatsRef.current = chats;
  const loadedKey = useRef('');
  const autoSentKey = useRef('');
  function update(next: Partial<ChatSession>) {
    if (!key) return;
    setChats(state => ({ ...state, [key]: { ...(state[key] ?? blankChatSession(key)), ...next } }));
  }
  // 工具步骤流按会话累积：组件重挂载后仍能读到这一轮已经发生过的步骤。
  const steps = useAgentSteps(key);
  /**
   * 输入卡工具行默认收起成一行摘要：处理范围与执行方式对第一次用的人是两个答不上来的问题，
   * 点开才需要回答，收起时只把当前的答案写出来。模型选择器保持独立触发，它随时可能要改。
   */
  const [toolsOpen, setToolsOpen] = useState(false);
  const scopeRoot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!toolsOpen) return;
    const onPointerDown = (event: MouseEvent) => { if (!scopeRoot.current?.contains(event.target as Node)) setToolsOpen(false); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setToolsOpen(false); };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('mousedown', onPointerDown); document.removeEventListener('keydown', onKeyDown); };
  }, [toolsOpen]);
  useEffect(() => {
    if (!key || loadedKey.current === key) return;
    loadedKey.current = key;
    if (chatsRef.current[key]) return;
    let active = true;
    void request<StoredChatSession>('chat.history.get', { sessionId: key }).then(record => {
      if (!active) return;
      const messages = record.messages.filter(message => message.role === 'user' || message.role === 'assistant')
        .map(message => ({ role: message.role as 'user' | 'assistant', content: message.content }));
      setChats(state => {
        // 读盘可能晚于本次会话的第一轮发送，已经有内容时不要用历史覆盖。
        const current = state[key];
        if (current?.messages.length) return state;
        return { ...state, [key]: { ...(current ?? blankChatSession(key)), messages } };
      });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [key, setChats]);
  // 欢迎页把首条消息随会话交过来：挂载后自动发出一次，用户不必再按一次发送。
  // 条件还没就绪（例如打开项目时素材仍在切换）就先留着，等条件满足再发，不能白白把这次发送丢掉。
  useEffect(() => {
    if (!key || !session?.sendOnOpen || autoSentKey.current === key) return;
    if (session.busy || assetsLoading || !session.input.trim()) return;
    autoSentKey.current = key;
    update({ sendOnOpen: false });
    void send();
  }, [key, session?.sendOnOpen, session?.busy, session?.input, assetsLoading]);
  // 欢迎页发送时拖了视频：项目在那里落不了抽帧面板，把队列带到会话页打开。
  useEffect(() => {
    if (!pendingVideoImports || compact) return;
    const target = pendingVideoImports;
    setPendingVideoImports(null);
    if (target.files.length === 1) drop.openVideo({ projectId: target.projectId, path: target.files[0] });
    else drop.openPicks({ projectId: target.projectId, files: target.files });
  }, [pendingVideoImports, compact, drop, setPendingVideoImports]);
  async function send(overrides: { autoExecute?: boolean; message?: string } = {}) {
    if (!session) return;
    // 只拖了文件没打字也可以发送：附件导入项目后用一句默认说明开场。
    const attachments = session.attachments ?? [];
    const text = (overrides.message ?? session.input).trim() || (attachments.length ? `刚添加了 ${attachments.length} 个文件，请核对项目素材。` : '');
    if (!text || session.busy || assetsLoading) return;
    if (!selectedProviderId || !selectedModel) { notify('请先在设置里选择对话接口与对话模型。', { error: true, action: { label: '去配置', run: () => void navigate('settings', 'ai') } }); return; }
    // 模型校验按本次实际使用的接口来，配置里的其它问题（并发、请求上限）照旧拦下。
    const configIssue = chatConfig.issues.find(issue => issue.field !== 'model');
    if (configIssue) { notify(configIssue.message, { error: true, action: { label: '去配置', run: () => void navigate('settings', 'ai') } }); return; }
    if (effectiveScope === 'current' && !assetId) { notify('请先在项目里打开要处理的图片。', { error: true, action: { label: '去打开', run: () => void navigate('overview') } }); return; }
    // 附件随消息一起落库：图片与目录进项目，视频转交抽帧流程（一个面板只跑一个视频）。
    if (attachments.length) {
      if (!project) { notify('请先选择项目。', { error: true, action: { label: '回到欢迎页', run: () => void startProjectChat() } }); return; }
      const result = await importAttachments(project.id, attachments);
      update({ attachments: [] });
      if (result.imported || result.skipped) { await refreshAssets(); notify(`已导入 ${result.imported} 张${result.skipped ? `，已在项目里 ${result.skipped} 张` : ''}。`); }
      if (result.videos.length === 1) drop.openVideo({ projectId: project.id, path: result.videos[0] });
      else if (result.videos.length > 1) drop.openPicks({ projectId: project.id, files: result.videos });
    }
    const assetIds = effectiveScope === 'current' ? [assetId!] : effectiveScope === 'page' ? assets.map(a => a.id) : effectiveScope === 'selected' ? [...selectedAssetIds] : undefined;
    if (assetIds && !assetIds.length) { notify('当前处理范围没有素材，请先选择图片。', { error: true, action: { label: '去勾选', run: () => void navigate('overview') } }); return; }
    const next = [...session.messages, { role: 'user' as const, content: text }];
    const streamSinceSequence = events.at(-1)?.sequence ?? -1;
    const scopeLabel = effectiveScope === 'current' ? assets.find(a => a.id === assetId)?.name ?? '当前图片' : effectiveScope === 'project' ? `全项目 · ${assetTotal} 张` : `${effectiveScope === 'page' ? '当前页' : '已勾选（跨页）'} · ${assetIds!.length} 张`;
    update({ messages: next, input: '', busy: true, cancelRequested: false, runningScope: scopeLabel, streamingText: '', streamSinceSequence, planned: undefined });
    try {
      const result = await request<{ content: string; status: string; actions?: AgentStep[] }>('agent.chat', {
        sessionId: session.id, projectId: project?.id, providerId: selectedProviderId, model: selectedModel,
        messages: next, autoExecute: overrides.autoExecute ?? session.autoExecute,
        context: { depth, ...(session.referenceResources?.length?{referenceResources:session.referenceResources}:{}), ...(assetIds ? { assetIds } : {}), ...(annotationConfig.providerId&&annotationConfig.model ? { annotationProviderId:annotationConfig.providerId,annotationModel:annotationConfig.model } : {}), ...(annotationConfig.prompt?{prompt:annotationConfig.prompt}:{}), ...(session.exportDir ? { exportDir: session.exportDir } : {}), ...(annotationConfig.maxRequests!==undefined ? { maxRequests:annotationConfig.maxRequests} : {}), ...(annotationConfig.concurrency?{concurrency:annotationConfig.concurrency}:{}) },
      });
      // 先看方案时 agent 只给出待执行的操作：确认卡片据此渲染，写操作一个都没跑。
      update({ messages: [...next, { role: 'assistant', content: result.content || (result.status === 'cancelled' ? '对话已停止。' : '接口未返回文本。') }], planned: result.actions?.filter(action => action.status === 'planned'), streamingText: undefined, streamSinceSequence: undefined });
    } catch (e) { update({ messages: [...next, { role: 'assistant', content: `本次调用未完成：${errorMessage(e)}` }], streamingText: undefined, streamSinceSequence: undefined }); notify(errorMessage(e), true); }
    finally { update({ busy: false, cancelRequested: false }); void refreshChatSessions().catch(() => undefined); }
  }
  useEffect(() => {
    if (!key || !session?.busy) return;
    const deltas = events.filter(event => event.type === 'call.delta' && event.payload.sessionId === key && event.sequence > (session.streamSinceSequence ?? -1))
      .sort((a, b) => a.sequence - b.sequence).map(event => typeof event.payload.delta === 'string' ? event.payload.delta : '').filter(Boolean);
    if (!deltas.length) return;
    const latest = events.filter(event => event.type === 'call.delta' && event.payload.sessionId === key).at(-1)?.sequence;
    setChats(state => {
      const current = state[key];
      if (!current?.busy || (latest !== undefined && latest <= (current.streamSinceSequence ?? -1))) return state;
      return { ...state, [key]: { ...current, streamingText: `${current.streamingText ?? ''}${deltas.join('')}`, streamSinceSequence: latest } };
    });
  }, [events, key, session?.busy, session?.streamSinceSequence, setChats]);
  if (!session) return null;
  /**
   * 范围下拉只列当前真的选得出来的项：没有勾选素材时不显示「已勾选」，没有素材时不显示「当前页」，
   * 免得用户对着一个永远 0 张的选项猜。「全项目」是唯一始终有效的口径，也是无从选择时的回退。
   */
  const effectiveScope = session.scope === 'selected' && !selectedAssetIds.length ? 'project'
    : session.scope === 'page' && !assets.length ? 'project'
    : session.scope === 'current' && !assetId ? 'project' : session.scope;
  /** 只列当前真的选得出来的范围：收起态与展开态共用这一份，避免两处口径漂移。 */
  const scopeOptions: Array<{ value: ChatSession['scope']; label: string }> = [
    ...(assetId ? [{ value: 'current' as const, label: '当前图片' }] : []),
    { value: 'project' as const, label: `全项目 · ${assetTotal} 张` },
    ...(assets.length ? [{ value: 'page' as const, label: `当前页 · ${assets.length} 张` }] : []),
    ...(selectedAssetIds.length ? [{ value: 'selected' as const, label: `已勾选（跨页）· ${selectedAssetIds.length} 张` }] : []),
  ];
  const scopeLabel = scopeOptions.find(option => option.value === effectiveScope)?.label ?? '全项目';
  const configReady = Boolean(chatConfig.providerId && chatConfig.model && !chatConfig.issues.length);
  function editComposer(text: string) {
    update({ input: text });
    window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.chat-panel textarea')?.focus());
  }
  function copyMessage(text: string) {
    if (!navigator.clipboard) {
      notify('当前环境不支持自动复制，请手动选择文本。', true);
      return;
    }
    void navigator.clipboard.writeText(text).then(() => notify('消息已复制。')).catch(() => notify('复制失败，请手动选择文本。', true));
  }
  function retryMessage(text: string) {
    if (!session || session.busy) return;
    void send({ message: text });
  }
  return <div className={`chat-panel ${compact ? 'compact' : ''} ${dropActive ? 'drop-active' : ''}`} {...(compact ? {} : drop.handlers)}>
    {!compact && <DropOverlay visible={dropActive} />}
    <div className="chat-messages" role="log" aria-label="对话消息">{!session.messages.length && !compact ? <Empty icon={<MessageSquare size={23} />} title="一起完成标注" description={isDemo ? '人工编辑可直接使用。对话与工具执行需连接桌面引擎和模型。' : '描述目标、类别和标注规则，助手会检查需要的信息。'}><Button onClick={() => void navigate('settings', 'ai')}><Settings2 size={14} />配置对话模型</Button><div className="chat-examples">{sampleRequests.map(text => <button key={text} type="button" onClick={() => editComposer(text)}>{text}</button>)}</div></Empty> : session.messages.map((message, i) => {
      const previousUser = [...session.messages.slice(0, i)].reverse().find(item => item.role === 'user')?.content;
      return <ChatMessage key={i} message={message} previousUser={previousUser} onEdit={editComposer} onRetry={retryMessage} onCopy={copyMessage} />;
    })}{session.busy && session.streamingText && <div className="chat-message assistant streaming"><div className="chat-message-head"><span className="chat-avatar assistant" aria-hidden="true"><Sparkles size={12} /></span><small>标注助手</small></div><div className="chat-text"><RichText text={session.streamingText}/></div></div>}{session.busy && <div className="chat-wait" role="status" aria-live="polite"><span className="waiting-dots">•••</span>{session.cancelRequested ? '正在请求停止 · 已发送请求的结果仍需核对' : chatStatus(events, session.id)} · {session.runningScope}</div>}
      {/* 结果卡片跟着会话走：已经有回复且绑定了项目时才展开实际结果，避免空转读取。 */}
      {!compact && <AgentSteps steps={steps} busy={session.busy} />}
      {!compact && session.planned?.length ? <PlanCard actions={session.planned} busy={session.busy}
        onRefine={() => { document.querySelector<HTMLTextAreaElement>('.chat-panel textarea')?.focus(); }}
        onConfirm={() => {
          const lastUser = [...session.messages].reverse().find(message => message.role === 'user')?.content ?? '';
          update({ autoExecute: true });
          void send({ autoExecute: true, message: lastUser });
        }} /> : null}
      {!compact && <TaskCards steps={steps} onUseModel={instruction => {
        update({ input: instruction });
        const box = document.querySelector<HTMLTextAreaElement>('.chat-panel textarea');
        box?.focus(); box?.scrollIntoView({ block: 'center' });
      }} />}
      {!compact && project && session.messages.some(message => message.role === 'assistant') && <ResultCard project={project} />}</div>
    {/* 输入区固定在页面最下方：上面只有消息在滚动，控制项与模型选择跟着输入框走。 */}
    <footer className="chat-dock">
      {/* 配置就绪时不再占一行：模型选择器里已经有「调整配置」，重复一行只会把输入区往下压。 */}
      {!configReady && <ConfigurationView value={chatConfig} providers={providers} compact onConfigure={() => void navigate('settings', 'ai')}/>}
      <Composer value={session.input} onChange={input => update({ input })} onSend={() => void send()} placeholder="描述你的标注任务…" busy={session.busy}
        attachments={session.attachments} onRemoveAttachment={id => update({ attachments: (session.attachments ?? []).filter(item => item.id !== id) })}
        onCancel={() => { if (session.cancelRequested) return; update({ cancelRequested: true }); void request('agent.cancel', { sessionId: session.id }).catch(e => { update({ cancelRequested: false }); notify(errorMessage(e), true); }); }}>
        <div className="chat-options">
          <div className="composer-scope" ref={scopeRoot}>
            <button type="button" className="composer-summary" disabled={session.busy} aria-haspopup="dialog" aria-expanded={toolsOpen} onClick={() => setToolsOpen(value => !value)}>
              <span className="truncate">{scopeLabel} · {session.autoExecute ? '直接执行' : '先看方案'}</span><ChevronDown size={12} />
            </button>
            {toolsOpen && <div className="picker-popover composer-popover" role="dialog" aria-label="处理范围与执行方式">
              <p className="muted tiny">这次让助手处理哪些图片</p>
              <div className="composer-choices">{scopeOptions.map(option => <button key={option.value} type="button" className={effectiveScope === option.value ? 'selected' : ''} aria-pressed={effectiveScope === option.value} onClick={() => update({ scope: option.value })}>{option.label}</button>)}</div>
              <p className="muted tiny">发出的请求怎么处理</p>
              <div className="composer-choices">{([['true', '直接执行'], ['false', '先看方案']] as const).map(([value, label]) => <button key={value} type="button" className={String(session.autoExecute) === value ? 'selected' : ''} aria-pressed={String(session.autoExecute) === value} onClick={() => update({ autoExecute: value === 'true' })}>{label}</button>)}</div>
              {/* 「直接执行」会真的发出请求并可能计费，这句话必须留在能改这个开关的地方。 */}
              <p className="muted tiny">直接执行会真的发出请求，可能产生费用；先看方案只列出将要做的操作，你确认后才跑。</p>
              <div className="composer-extra">
                <FlowPicker disabled={session.busy} onPick={prompt => { update({ input: prompt }); document.querySelector<HTMLTextAreaElement>('.chat-panel textarea')?.focus(); }} />
                {/* 本机模型入口：与云端接口并列，选的是当前项目的类别做映射预览。 */}
                <LocalModelPicker project={project} disabled={session.busy} onPick={prompt => { update({ input: prompt }); document.querySelector<HTMLTextAreaElement>('.chat-panel textarea')?.focus(); }} />
                {/* 类别放在输入卡这一层：不经过对话模型也能看清、能改「要标什么」。 */}
                {project && <ClassPicker project={project} disabled={session.busy} onUpdated={setProject} />}
                <button title={session.exportDir || '授权本次对话的导出目录'} onClick={() => void getBridge().then(b => b.chooseFiles({ kind: 'directory' })).then(paths => { if (paths[0]) update({ exportDir: paths[0] }); }).catch(e => notify(errorMessage(e), true))}><FolderOpen size={12} />{session.exportDir ? '已选目录' : '导出目录'}</button>
                {project && <ReferencePicker project={project} value={session.referenceResources ?? []} onChange={referenceResources => update({ referenceResources })} disabled={session.busy} />}
              </div>
            </div>}
          </div>
          <ModelPicker providers={providers} providerId={selectedProviderId} model={selectedModel} depth={depth} disabled={session.busy}
            onChange={choice => update({ providerId: choice.providerId, model: choice.model })}
            onDepthChange={next => update({ depth: next })} onConfigure={() => void navigate('settings', 'ai')} />
          {/* 直达标注：对话模型没配或不能调工具时，这里是唯一能真正开跑的路。 */}
          {project && <DirectRun project={project} annotationConfig={annotationConfig} selectedAssetIds={selectedAssetIds} disabled={session.busy} />}
        </div>
        <span className="composer-hint">Enter 换行 · Ctrl + Enter 发送{session.attachments?.length ? ` · 已添加 ${session.attachments.length} 个文件` : ''}</span>
      </Composer>
    </footer>
    {/* 拖入多个视频时先给候选清单：原先只打开第一个，其余文件名连提都不提。 */}
    <VideoPickList picks={drop.picks} onChoose={drop.chooseVideo} onClose={drop.closePicks} />
    {drop.video && <VideoImport key={drop.video.path} projectId={drop.video.projectId} initialSourcePath={drop.video.path} onClose={drop.closeVideo}
      onCreated={(job, temporarySource) => {
        setMediaTaskId(job.id); setMediaJob({ id: job.id, temporarySource }); drop.closeVideo();
        // 抽帧是异步的，留在对话里只会盯着一句提示干等；直接送到概览，素材进来就能看见、能勾选。
        notify('已创建抽帧任务，素材入库后出现在这里；进度可在侧栏「任务」里查看。');
        void navigate('overview');
      }} />}
  </div>;
}

function chatStatus(events: Array<{ type: string; payload: Record<string, unknown> }>, sessionId: string): string {
  const event = [...events].reverse().find(value => value.payload.sessionId === sessionId);
  if (!event) return '等待响应';
  if (event.type === 'call.queued') return '请求已排队';
  if (event.type === 'call.sent') return '接口已发送，等待返回';
  if (event.type === 'call.delta') return '正在接收响应';
  return '等待接口返回';
}
