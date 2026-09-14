/** 对话记录共享类型：主进程按此落盘，界面按此分组与展示。 */
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';
export type ChatTitleSource = 'auto' | 'user';
export type ChatSessionStatus = 'active' | 'deleted-project';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  createdAt: string;
  status?: 'ok' | 'error';
  error?: string;
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  titleSource: ChatTitleSource;
  pinned: boolean;
  /** 置顶顺序，数值小的排前面；未置顶为 0。 */
  pinOrder: number;
  projectId?: string;
  providerId: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  messageCount: number;
  status: ChatSessionStatus;
  /** 仅供侧栏悬浮预览，不参与长期存储。 */
  preview?: string;
}

export interface ChatSession extends ChatSessionSummary { messages: ChatMessage[] }

export interface ChatHistoryList {
  sessions: ChatSessionSummary[];
  total: number;
  warning?: string;
}

export interface ChatTrashEntry {
  id: string;
  sessionId: string;
  title: string;
  projectId?: string;
  messageCount: number;
  deletedAt: string;
  expiresAt: string;
}

export interface ChatTrashList { entries: ChatTrashEntry[]; retentionDays: number }

export interface ChatHistoryStatus {
  root: string;
  sessions: number;
  messages: number;
  bytes: number;
  trash: { entries: number; bytes: number; retentionDays: number };
  warning?: string;
}

export interface ChatMutationResult { removed: number; restored?: number }

export const CHAT_TRASH_RETENTION_DAYS = 7;
/** 自动标题截断长度，与侧栏单行展示宽度匹配。 */
export const CHAT_TITLE_LIMIT = 24;
