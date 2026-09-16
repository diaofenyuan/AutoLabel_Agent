import { resolveConfiguration } from '../../shared/configuration';
import type { ChatSession as StoredChatSession } from '../../shared/chat';
import ConfigurationView from './ConfigurationView';
import ReferencePicker from './ReferencePicker';
import { useEffect, useRef } from 'react';
import { MessageSquare, Settings2, FolderOpen, Sparkles } from 'lucide-react';
import { blankChatSession, useApp, type ChatSession } from './context';
import { thinkingDepthNames, type ThinkingDepth } from './types';
import { useAiConfigured } from './AiSetup';
import { request, getBridge, isDemo, errorMessage } from './bridge';
import { Composer, Button, Empty } from './ui';

/**
 * 会话页：一条会话一个消息流，状态按会话标识存放。
 * 消息落盘由主进程负责，这里只在首次打开某条会话时读回一次，之后以内存状态为准。
 */
export default function ChatPanel({ compact = false, assetId, sessionId }: { compact?: boolean; assetId?: string; sessionId?: string }) {
  const { project, prefs, notify, navigate, chats, setChats, assets, assetTotal, selectedAssetIds, assetsLoading, providers, events, activeSessionId, refreshChatSessions } = useApp();
  const chatConfig=resolveConfiguration('chat',prefs,project?.settings);
  const annotationConfig=resolveConfiguration('annotation',prefs,project?.settings);
  const aiConfigured = useAiConfigured();
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
  useEffect(() => {
    if (!key || !session?.sendOnOpen || autoSentKey.current === key) return;
    autoSentKey.current = key;
    update({ sendOnOpen: false });
    void send();
  }, [key, session?.sendOnOpen]);
  async function send() {
    if (!session?.input.trim() || session.busy || assetsLoading) return;
    if (!selectedProviderId || !selectedModel) { notify('请先在设置里选择对话接口与对话模型。', true); return; }
    // 模型校验按本次实际使用的接口来，配置里的其它问题（并发、请求上限）照旧拦下。
    const configIssue = chatConfig.issues.find(issue => issue.field !== 'model');
    if (configIssue) { notify(configIssue.message, true); return; }
    if (session.scope === 'current' && !assetId) { notify('请先在项目里打开要处理的图片。', true); return; }
    const assetIds = session.scope === 'current' ? [assetId!] : session.scope === 'page' ? assets.map(a => a.id) : session.scope === 'selected' ? [...selectedAssetIds] : undefined;
    if (assetIds && !assetIds.length) { notify('当前处理范围没有素材，请先选择图片。', true); return; }
    const next = [...session.messages, { role: 'user' as const, content: session.input.trim() }];
    const streamSinceSequence = events.at(-1)?.sequence ?? -1;
    const scopeLabel = session.scope === 'current' ? assets.find(a => a.id === assetId)?.name ?? '当前图片' : session.scope === 'project' ? `全项目 · ${assetTotal} 张` : `${session.scope === 'page' ? '当前页' : '已勾选（跨页）'} · ${assetIds!.length} 张`;
    update({ messages: next, input: '', busy: true, cancelRequested: false, runningScope: scopeLabel, streamingText: '', streamSinceSequence });
    try {
      const result = await request<{ content: string; status: string }>('agent.chat', {
        sessionId: session.id, projectId: project?.id, providerId: selectedProviderId, model: selectedModel,
        messages: next, autoExecute: session.autoExecute,
        context: { depth, ...(session.referenceResources?.length?{referenceResources:session.referenceResources}:{}), ...(assetIds ? { assetIds } : {}), ...(annotationConfig.providerId&&annotationConfig.model ? { annotationProviderId:annotationConfig.providerId,annotationModel:annotationConfig.model } : {}), ...(annotationConfig.prompt?{prompt:annotationConfig.prompt}:{}), ...(session.exportDir ? { exportDir: session.exportDir } : {}), ...(annotationConfig.maxRequests!==undefined ? { maxRequests:annotationConfig.maxRequests} : {}), ...(annotationConfig.concurrency?{concurrency:annotationConfig.concurrency}:{}) },
      });
      update({ messages: [...next, { role: 'assistant', content: result.content || (result.status === 'cancelled' ? '对话已停止。' : '接口未返回文本。') }], streamingText: undefined, streamSinceSequence: undefined });
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
  // 可选模型来自「已保存凭据的接口 × 该接口的默认模型」；当前选中项一定在列表里，避免下拉把已选模型吃掉。
  const options: Array<{ key: string; label: string }> = [];
  const known = new Set<string>();
  const addModel = (providerId?: string, model?: string) => {
    if (!providerId || !model) return;
    const optionKey = `${providerId}|${model}`;
    if (known.has(optionKey)) return;
    known.add(optionKey);
    options.push({ key: optionKey, label: `${providers.find(item => item.id === providerId)?.name ?? providerId} · ${model}` });
  };
  for (const provider of providers) if (provider.hasCredential) addModel(provider.id, provider.model);
  addModel(selectedProviderId, selectedModel);
  return <div className={`chat-panel ${compact ? 'compact' : ''}`}>
    <div className="chat-messages" aria-live="polite">{!session.messages.length && !compact ? <Empty icon={<MessageSquare size={23} />} title="一起完成标注" description={isDemo ? '人工编辑可直接使用。对话与工具执行需连接桌面引擎和模型。' : '描述目标、类别和标注规则，助手会检查需要的信息。'}><Button onClick={() => void navigate('settings')}><Settings2 size={14} />配置对话模型</Button></Empty> : session.messages.map((message,i) => <div className={`chat-message ${message.role}`} key={i}><div className="chat-message-head"><span className={`chat-avatar ${message.role}`} aria-hidden="true">{message.role === 'assistant' ? <Sparkles size={12} /> : '你'}</span><small>{message.role === 'user' ? '你' : '标注助手'}</small></div><p>{message.content}</p></div>)}{session.busy && session.streamingText && <div className="chat-message assistant streaming"><div className="chat-message-head"><span className="chat-avatar assistant" aria-hidden="true"><Sparkles size={12} /></span><small>标注助手</small></div><p>{session.streamingText}</p></div>}{session.busy && <div className="chat-wait"><span className="waiting-dots">•••</span>{session.cancelRequested ? '正在请求停止 · 已发送请求的结果仍需核对' : chatStatus(events, session.id)} · {session.runningScope}</div>}</div>
    {project&&<ReferencePicker project={project} value={session.referenceResources??[]} onChange={referenceResources=>update({referenceResources})} disabled={session.busy}/>}<ConfigurationView value={chatConfig} providers={providers} compact/><div className="chat-scope"><select aria-label="助手处理范围" disabled={session.busy} value={session.scope} onChange={e => update({ scope: e.target.value as ChatSession['scope'] })}>{assetId && <option value="current">当前图片</option>}<option value="project">全项目 · {assetTotal} 张</option><option value="page">当前页 · {assets.length} 张</option><option value="selected">已勾选（跨页）· {selectedAssetIds.length} 张</option></select><select aria-label="助手执行方式" disabled={session.busy} value={String(session.autoExecute)} onChange={e => update({ autoExecute: e.target.value === 'true' })}><option value="true">直接执行</option><option value="false">先看方案</option></select></div>
    <Composer value={session.input} onChange={input => update({ input })} onSend={() => void send()} placeholder="描述你的标注任务…" busy={session.busy} onCancel={() => { if (session.cancelRequested) return; update({ cancelRequested: true }); void request('agent.cancel', { sessionId: session.id }).catch(e => { update({ cancelRequested: false }); notify(errorMessage(e), true); }); }}><div className="chat-options"><button title={session.exportDir || '授权本次对话的导出目录'} onClick={() => void getBridge().then(b => b.chooseFiles({ kind: 'directory' })).then(paths => { if (paths[0]) update({ exportDir: paths[0] }); }).catch(e => notify(errorMessage(e), true))}><FolderOpen size={13} />{session.exportDir ? '已选目录' : '导出目录'}</button>{options.length
        ? <select aria-label="对话模型" title="本次对话使用的模型" disabled={session.busy} value={`${selectedProviderId}|${selectedModel}`} onChange={e => { const [providerId, model] = e.target.value.split('|'); update({ providerId, model }); }}>{options.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}</select>
        : <button onClick={() => void navigate('settings')}>{aiConfigured ? '选择模型' : '配置 AI'}</button>}
      <select aria-label="思考深度" title="助手投入的思考与自检力度" disabled={session.busy} value={depth} onChange={e => update({ depth: e.target.value as ThinkingDepth })}>{(['fast', 'standard', 'deep'] as const).map(key => <option key={key} value={key}>{thinkingDepthNames[key]}</option>)}</select></div></Composer>
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
