import { MessageSquare, Plus } from 'lucide-react';
import { useApp } from './context';
import { Button } from './ui';
import { Projects } from './Projects';

/**
 * 对话主页：取代项目中心成为默认落地页。
 * 顶部提供「新建对话」与最近会话入口，下方直接复用现有 Projects 组件，
 * 让项目列表 + 搜索、新建项目、打开示例、描述式创建等能力不丢失。
 */
export default function ChatHome() {
  const { chatSessions, activeSessionId, newChatSession, navigate, setActiveSessionId } = useApp();
  const recent = [...chatSessions].sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt)).slice(0, 6);
  return <div className="chat-home">
    <div className="content chat-home-head">
      <div className="page-heading">
        <div><h1>对话</h1><p>与标注助手协作，或从下方项目列表继续工作。</p></div>
        <div className="actions"><Button className="primary" onClick={() => void newChatSession()}><Plus size={15} />新建对话</Button></div>
      </div>
      {recent.length > 0 && <div className="chat-session-strip" aria-label="最近对话">
        {recent.map(session => <button key={session.id} className={`chat-session-card ${session.id === activeSessionId ? 'selected' : ''}`} title={session.title} onClick={() => { setActiveSessionId(session.id); void navigate('chat'); }}>
          <MessageSquare size={14} /><span className="truncate">{session.title}</span>{session.status === 'deleted-project' && <small>项目已删除</small>}
        </button>)}
      </div>}
    </div>
    <Projects />
  </div>;
}
