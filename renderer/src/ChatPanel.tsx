import { resolveConfiguration } from '../../shared/configuration';
import ConfigurationView from './ConfigurationView';
import ReferencePicker from './ReferencePicker';
import { useEffect } from 'react';
import { MessageSquare, Settings2, FolderOpen, Sparkles } from 'lucide-react';
import { useApp, type ChatSession } from './context';
import { useAiConfigured } from './AiSetup';
import { request, getBridge, isDemo, errorMessage } from './bridge';
import { Composer, Button, Empty } from './ui';

export default function ChatPanel({ compact = false, assetId }: { compact?: boolean; assetId?: string }) {
  const { project, prefs, notify, navigate, chats, setChats, assets, assetTotal, selectedAssetIds, assetsLoading, providers, events } = useApp();
  const chatConfig=resolveConfiguration('chat',prefs,project?.settings);
  const annotationConfig=resolveConfiguration('annotation',prefs,project?.settings);
  const aiConfigured = useAiConfigured();
  const projectKey = project?.id ?? 'global';
  const session = chats[projectKey];
  useEffect(() => { setChats(state => state[projectKey] ? state : { ...state, [projectKey]: { id: crypto.randomUUID(), messages: [], input: '', busy: false, exportDir: '', scope: 'current', autoExecute: true } }); }, [projectKey,setChats]);
  function update(next: Partial<ChatSession>) { setChats(state => ({ ...state, [projectKey]: { ...state[projectKey], ...next } })); }
  async function send() {
    if (!session?.input.trim() || session.busy || assetsLoading) return;
    if (!chatConfig.providerId || !chatConfig.model || chatConfig.issues.length) { notify('请在模型中心选择对话接口与对话模型。', true); return; }
    if (session.scope === 'current' && !assetId) { notify('请先打开要处理的图片。', true); return; }
    const assetIds = session.scope === 'current' ? [assetId!] : session.scope === 'page' ? assets.map(a => a.id) : session.scope === 'selected' ? [...selectedAssetIds] : undefined;
    if (assetIds && !assetIds.length) { notify('当前处理范围没有素材，请先选择图片。', true); return; }
    const next = [...session.messages, { role: 'user' as const, content: session.input.trim() }];
    const streamSinceSequence = events.at(-1)?.sequence ?? -1;
    const scopeLabel = session.scope === 'current' ? assets.find(a => a.id === assetId)?.name ?? '当前图片' : session.scope === 'project' ? `全项目 · ${assetTotal} 张` : `${session.scope === 'page' ? '当前页' : '已勾选（跨页）'} · ${assetIds!.length} 张`;
    update({ messages: next, input: '', busy: true, cancelRequested: false, runningScope: scopeLabel, streamingText: '', streamSinceSequence });
    try {
      const result = await request<{ content: string; status: string }>('agent.chat', {
        sessionId: session.id, projectId: project?.id, providerId: chatConfig.providerId, model: chatConfig.model,
        messages: next, autoExecute: session.autoExecute, stream: true,
        context: { ...(session.referenceResources?.length?{referenceResources:session.referenceResources}:{}), ...(assetIds ? { assetIds } : {}), ...(annotationConfig.providerId&&annotationConfig.model ? { annotationProviderId:annotationConfig.providerId,annotationModel:annotationConfig.model } : {}), ...(annotationConfig.prompt?{prompt:annotationConfig.prompt}:{}), ...(session.exportDir ? { exportDir: session.exportDir } : {}), ...(annotationConfig.maxRequests!==undefined ? { maxRequests:annotationConfig.maxRequests } : {}), ...(annotationConfig.concurrency?{concurrency:annotationConfig.concurrency}:{}) },
      });
      update({ messages: [...next, { role: 'assistant', content: result.content || (result.status === 'cancelled' ? '对话已停止。' : '接口未返回文本。') }], streamingText: undefined, streamSinceSequence: undefined });
    } catch (e) { update({ messages: [...next, { role: 'assistant', content: `本次调用未完成：${errorMessage(e)}` }], streamingText: undefined, streamSinceSequence: undefined }); notify(errorMessage(e), true); }
    finally { update({ busy: false, cancelRequested: false }); }
  }
  useEffect(() => {
    if (!session?.busy) return;
    const deltas = events.filter(event => event.type === 'call.delta' && event.payload.sessionId === session.id && event.sequence > (session.streamSinceSequence ?? -1))
      .sort((a, b) => a.sequence - b.sequence).map(event => typeof event.payload.delta === 'string' ? event.payload.delta : '').filter(Boolean);
    if (!deltas.length) return;
    const latest = events.filter(event => event.type === 'call.delta' && event.payload.sessionId === session.id).at(-1)?.sequence;
    setChats(state => {
      const current = state[projectKey];
      if (!current?.busy || (latest !== undefined && latest <= (current.streamSinceSequence ?? -1))) return state;
      return { ...state, [projectKey]: { ...current, streamingText: `${current.streamingText ?? ''}${deltas.join('')}`, streamSinceSequence: latest } };
    });
  }, [events, projectKey, session?.busy, session?.id, session?.streamSinceSequence, setChats]);
  if (!session) return null;
  return <div className={`chat-panel ${compact ? 'compact' : ''}`}>
    <div className="chat-messages" aria-live="polite">{!session.messages.length && !compact ? <Empty icon={<MessageSquare size={23} />} title="一起完成标注" description={isDemo ? '人工编辑可直接使用。对话与工具执行需连接桌面引擎和模型。' : '描述目标、类别和标注规则，助手会检查需要的信息。'}><Button onClick={() => void navigate('models')}><Settings2 size={14} />配置对话模型</Button></Empty> : session.messages.map((message,i) => <div className={`chat-message ${message.role}`} key={i}><div className="chat-message-head"><span className={`chat-avatar ${message.role}`} aria-hidden="true">{message.role === 'assistant' ? <Sparkles size={12} /> : '你'}</span><small>{message.role === 'user' ? '你' : '标注助手'}</small></div><p>{message.content}</p></div>)}{session.busy && session.streamingText && <div className="chat-message assistant streaming"><div className="chat-message-head"><span className="chat-avatar assistant" aria-hidden="true"><Sparkles size={12} /></span><small>标注助手</small></div><p>{session.streamingText}</p></div>}{session.busy && <div className="chat-wait"><span className="waiting-dots">•••</span>{session.cancelRequested ? '正在请求停止 · 已发送请求的结果仍需核对' : chatStatus(events, session.id)} · {session.runningScope}</div>}</div>
    {project&&<ReferencePicker project={project} value={session.referenceResources??[]} onChange={referenceResources=>update({referenceResources})} disabled={session.busy}/>}<ConfigurationView value={chatConfig} providers={providers} compact/><div className="chat-scope"><select aria-label="助手处理范围" disabled={session.busy} value={session.scope} onChange={e => update({ scope: e.target.value as ChatSession['scope'] })}><option value="current">当前图片</option><option value="project">全项目 · {assetTotal} 张</option><option value="page">当前页 · {assets.length} 张</option><option value="selected">已勾选（跨页）· {selectedAssetIds.length} 张</option></select><select aria-label="助手执行方式" disabled={session.busy} value={String(session.autoExecute)} onChange={e => update({ autoExecute: e.target.value === 'true' })}><option value="true">直接执行</option><option value="false">先看方案</option></select></div>
    <Composer value={session.input} onChange={input => update({ input })} onSend={() => void send()} placeholder="描述你的标注任务…" busy={session.busy} onCancel={() => { if (session.cancelRequested) return; update({ cancelRequested: true }); void request('agent.cancel', { sessionId: session.id }).catch(e => { update({ cancelRequested: false }); notify(errorMessage(e), true); }); }}><div className="chat-options"><button title={session.exportDir || '授权本次对话的导出目录'} onClick={() => void getBridge().then(b => b.chooseFiles({ kind: 'directory' })).then(paths => { if (paths[0]) update({ exportDir: paths[0] }); }).catch(e => notify(errorMessage(e), true))}><FolderOpen size={13} />{session.exportDir ? '已选目录' : '导出目录'}</button>{chatConfig.model ? <span>{chatConfig.model}</span> : <button onClick={() => void navigate('models')}>{aiConfigured ? '选择模型' : '配置 AI'}</button>}</div></Composer>
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
