import { useState } from 'react';
import { Image as ImageIcon, MessageSquare } from 'lucide-react';
import { useApp } from './context';
import { request, errorMessage, getBridge } from './bridge';
import { Composer } from './ui';
import { AiSetupNotice } from './AiSetup';

/**
 * Codex 式欢迎页：启动即落在这里，居中输入框 + 欢迎语 + 建议 chips。
 * 发送或点建议项都会立刻开会话（标题取首条消息摘要），随后由会话页接管消息流，
 * 所以这里不做消息渲染，只负责把对话「开起来」。
 */
export default function ChatHome() {
  const { chatSessions, projects, project, setChats, setActiveSessionId, refreshChatSessions, refreshProjects, openProject, notify } = useApp();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const recent = [...chatSessions].sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt)).slice(0, 4);
  // 「继续 <最近项目>」按最近打开的项目走，没有项目时这一项不出现。
  const lastProject = [...projects].sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))[0];

  /** 开会话并把首条消息交给会话页自动发出：欢迎页是对话的入口，不再要求先点「新建对话」。 */
  async function start(message: string) {
    const text = message.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const id = crypto.randomUUID();
      await request('chat.history.ensure', { sessionId: id, ...(project ? { projectId: project.id, projectName: project.name } : {}), title: text });
      // 处理范围按项目走：欢迎页没有「当前图片」这个概念，锁定单图只会挡住首条消息。
      setChats(state => ({ ...state, [id]: { id, messages: [], input: text, busy: false, exportDir: '', scope: 'project', autoExecute: true, sendOnOpen: true } }));
      setActiveSessionId(id);
      await refreshChatSessions();
    } catch (e) { notify(errorMessage(e), true); }
    finally { setBusy(false); }
  }

  /** 「导入图片开始标注」：有项目就直接导入并随即开会话；没有项目则先开一条对话，由用户描述要建什么项目。 */
  async function importImages() {
    if (busy) return;
    if (!project) { await start('导入图片开始标注'); return; }
    setBusy(true);
    try {
      const paths = await (await getBridge()).chooseFiles({ kind: 'images', multiple: true });
      if (!paths.length) return;
      const result = await request<{ imported: number; skipped: number }>('asset.import', { projectId: project.id, paths, mode: 'copy' });
      await refreshProjects();
      notify(`已导入 ${result.imported} 张，跳过 ${result.skipped} 张。`);
      await start(`刚导入了 ${result.imported} 张图片，请开始标注`);
    } catch (e) { notify(errorMessage(e), true); }
    finally { setBusy(false); }
  }

  return <div className="chat-home">
    <div className="chat-welcome">
      <h1>今天要标注什么？</h1>
      <AiSetupNotice />
      <Composer value={input} onChange={setInput} onSend={() => void start(input)} placeholder="描述要标注的图片、类别与规则…" busy={busy}>
        <span className="composer-hint">Ctrl + Enter 发送 · 发送后自动新建对话</span>
      </Composer>
      <div className="chat-suggestions" aria-label="建议">
        <button disabled={busy} onClick={() => void importImages()}><ImageIcon size={14} />导入图片开始标注</button>
        {lastProject && <button disabled={busy} onClick={() => void openProject(lastProject).catch(e => notify(errorMessage(e), true))}>继续 {lastProject.name}</button>}
      </div>
    </div>
    {recent.length > 0 && <div className="content chat-home-recent">
      <div className="sidebar-group-title">最近会话</div>
      <div className="chat-session-strip" aria-label="最近会话">
        {recent.map(session => <button key={session.id} className="chat-session-card" title={session.title} onClick={() => setActiveSessionId(session.id)}>
          <MessageSquare size={14} /><span className="truncate">{session.title}</span>{session.status === 'deleted-project' && <small>项目已删除</small>}
        </button>)}
      </div>
    </div>}
  </div>;
}
