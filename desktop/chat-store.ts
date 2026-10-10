import { randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  CHAT_TITLE_LIMIT, CHAT_TRASH_RETENTION_DAYS, type ChatHistoryList, type ChatHistoryStatus, type ChatMessage,
  type ChatMaterialContext, type ChatMemoryConversation, type ChatMemorySnapshot, type ChatMutationResult, type ChatRole,
  type ChatSession, type ChatSessionSummary, type ChatTrashEntry, type ChatTrashList,
} from '../shared/chat';
import { assertProjectId, UNASSIGNED_PROJECT_ID } from './project-workspace';
import { DesktopError } from './validation';

const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const roles = new Set<ChatRole>(['system', 'user', 'assistant', 'tool']);
const scopes = new Set<ChatMaterialContext['scope']>(['current', 'project', 'page', 'selected']);
const MEMORY_LIMIT = 60000;
const MEMORY_TEXT_LIMIT = 1200;
const DAY_MS = 24 * 60 * 60 * 1000;

function validId(value: unknown): string {
  if (typeof value !== 'string' || !idPattern.test(value)) throw new DesktopError('CHAT_SESSION_INVALID', '对话标识无效');
  return value;
}

/** 首条用户消息压成单行并截断；侧栏单行展示不再二次处理。标题只取首行，消息尾部附带的素材括注不会进标题。 */
export function autoTitle(text: string): string {
  const firstLine = String(text ?? '').split('\n').map(line => line.trim()).find(Boolean) ?? '';
  const flat = firstLine.replace(/\s+/g, ' ').trim();
  return flat.length > CHAT_TITLE_LIMIT ? `${flat.slice(0, CHAT_TITLE_LIMIT)}…` : flat;
}

function nowIso(): string { return new Date().toISOString(); }

async function atomicWriteText(filename: string, text: string): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = filename + '.tmp';
  const file = await open(temporary, 'w');
  try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
  await rename(temporary, filename);
}

async function atomicWrite(filename: string, data: unknown): Promise<void> {
  await atomicWriteText(filename, JSON.stringify(data));
}

async function readJson<T>(filename: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(filename, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

function normalizedIds(value: unknown, limit = 5000): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = [...new Set(value.filter(item => typeof item === 'string' && idPattern.test(item)))].slice(0, limit) as string[];
  return values.length ? values : [];
}

function normalizeContext(raw: unknown): ChatMaterialContext | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const item = raw as Record<string, unknown>;
  if (!scopes.has(item.scope as ChatMaterialContext['scope'])) return undefined;
  const context: ChatMaterialContext = { scope: item.scope as ChatMaterialContext['scope'] };
  const assetIds = normalizedIds(item.assetIds);
  const referenceAssetIds = normalizedIds(item.referenceAssetIds, 63);
  if (assetIds !== undefined) context.assetIds = assetIds;
  if (referenceAssetIds !== undefined) context.referenceAssetIds = referenceAssetIds;
  if (Array.isArray(item.referenceResources)) {
    context.referenceResources = item.referenceResources.flatMap(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const resource = value as Record<string, unknown>;
      if (typeof resource.resourceId !== 'string' || !idPattern.test(resource.resourceId)) return [];
      const version = resource.version === undefined ? undefined
        : Number.isInteger(resource.version) && Number(resource.version) >= 0 ? Number(resource.version) : undefined;
      const classMap = resource.classMap && typeof resource.classMap === 'object' && !Array.isArray(resource.classMap)
        ? Object.fromEntries(Object.entries(resource.classMap).filter(([from, to]) => idPattern.test(from) && typeof to === 'string' && idPattern.test(to)))
        : undefined;
      return [{ resourceId: resource.resourceId, ...(version === undefined ? {} : { version }), ...(classMap ? { classMap } : {}) }];
    }).slice(0, 63);
  }
  return context;
}

function trimMemoryText(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  return text.length > MEMORY_TEXT_LIMIT ? `${text.slice(0, MEMORY_TEXT_LIMIT)}…` : text;
}

function normalizeMemory(raw: unknown): ChatMemorySnapshot | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.projectId !== 'string' || !idPattern.test(value.projectId) || !Array.isArray(value.conversations)) return undefined;
  const conversations: ChatMemoryConversation[] = value.conversations.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== 'string' || !idPattern.test(entry.id) || typeof entry.projectId !== 'string' || !idPattern.test(entry.projectId)) return [];
    return [{
      id: entry.id, projectId: entry.projectId,
      title: typeof entry.title === 'string' && entry.title ? entry.title : '未命名对话',
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : nowIso(),
      messageCount: Number.isInteger(entry.messageCount) && Number(entry.messageCount) >= 0 ? Number(entry.messageCount) : 0,
      ...(trimMemoryText(typeof entry.firstUser === 'string' ? entry.firstUser : undefined) ? { firstUser: trimMemoryText(entry.firstUser as string) } : {}),
      ...(trimMemoryText(typeof entry.lastAssistant === 'string' ? entry.lastAssistant : undefined) ? { lastAssistant: trimMemoryText(entry.lastAssistant as string) } : {}),
      ...(normalizeContext(entry.context) ? { context: normalizeContext(entry.context) } : {}),
    }];
  });
  return {
    projectId: value.projectId,
    generatedAt: typeof value.generatedAt === 'string' ? value.generatedAt : nowIso(),
    conversations,
    truncatedCount: Number.isInteger(value.truncatedCount) && Number(value.truncatedCount) >= 0 ? Number(value.truncatedCount) : 0,
  };
}

function normalizeSummary(raw: unknown): ChatSessionSummary | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== 'string' || !idPattern.test(item.id)) return undefined;
  const createdAt = typeof item.createdAt === 'string' ? item.createdAt : nowIso();
  const lastMessageAt = typeof item.lastMessageAt === 'string' ? item.lastMessageAt : createdAt;
  return {
    id: item.id,
    title: typeof item.title === 'string' && item.title ? item.title : autoTitle('') || '未命名对话',
    titleSource: item.titleSource === 'user' ? 'user' : 'auto',
    pinned: item.pinned === true,
    pinOrder: Number.isInteger(item.pinOrder) ? Number(item.pinOrder) : 0,
    ...(typeof item.projectId === 'string' && item.projectId ? { projectId: item.projectId } : {}),
    providerId: typeof item.providerId === 'string' ? item.providerId : '',
    model: typeof item.model === 'string' ? item.model : '',
    createdAt,
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : createdAt,
    lastMessageAt,
    messageCount: Number.isInteger(item.messageCount) && Number(item.messageCount) >= 0 ? Number(item.messageCount) : 0,
    ...(normalizeContext(item.context) ? { context: normalizeContext(item.context) } : {}),
  };
}

function normalizeMessage(raw: unknown): ChatMessage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const item = raw as Record<string, unknown>;
  const role = roles.has(item.role as ChatRole) ? item.role as ChatRole : 'assistant';
  return {
    role,
    content: typeof item.content === 'string' ? item.content : '',
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : nowIso(),
    ...(item.status === 'error' ? { status: 'error' as const } : {}),
    ...(typeof item.error === 'string' ? { error: item.error } : {}),
  };
}

export interface ChatRecordInput {
  sessionId: string;
  projectId?: string;
  providerId: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  context?: ChatMaterialContext;
  reply?: string;
  error?: string;
}

/**
 * 对话记录落盘：**一项目一目录**。
 *
 * 每个项目下 `chats/index.json` 保存该项目的会话索引，`<sessionId>.jsonl` 逐条追加消息。
 * 索引与消息文件必须成对处理，删除一律先入 `.trash/`，避免误删不可恢复。
 *
 * 隔离带来两个必须处理的后果：
 * 1. 跨项目查询（全局列表、回收站、按 id 找会话）要遍历各项目目录，因此这里维护一份
 *    `sessionId -> projectId` 路由缓存，且**只在写操作后失效**，读路径不重复扫盘；
 * 2. 会话可能被重新归属项目（例如先在收容目录创建、后并入项目），
 *    因此记录落盘时若发现会话已存在但归属不同，会搬迁文件而不是各写一份。
 */
export class ChatStore {
  private pending: Promise<unknown> = Promise.resolve();
  private warning?: string;
  private purgedAt = 0;
  /** 会话归属路由缓存；写操作后置空，读路径按需重建。 */
  private routing?: Map<string, string>;
  constructor(private root: () => string) {}

  private directory(): string {
    const root = this.root();
    if (!root) throw new DesktopError('CHAT_STORAGE_UNAVAILABLE', '项目文件夹尚未就绪，请在设置中检查存储位置');
    return root;
  }
  /** 某个项目的对话目录；未指定归属的会话统一进收容目录，不会混进真实项目。 */
  private chatsDirectory(projectId?: string): string {
    const id = projectId ? assertProjectId(projectId) : UNASSIGNED_PROJECT_ID;
    return path.join(this.directory(), 'projects', id, 'chats');
  }
  private indexFile(projectId?: string): string { return path.join(this.chatsDirectory(projectId), 'index.json'); }
  private messageFile(projectId: string, sessionId: string): string { return path.join(this.chatsDirectory(projectId), `${sessionId}.jsonl`); }
  private memoryFile(projectId: string, sessionId: string): string { return path.join(this.chatsDirectory(projectId), `${sessionId}.memory.json`); }
  private trashDirectory(projectId?: string): string { return path.join(this.chatsDirectory(projectId), '.trash'); }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation);
    this.pending = next.catch(() => undefined);
    return next;
  }

  /** 已知项目目录；损坏或缺失的目录跳过，不让单个坏项目挡住全局列表。 */
  private async projectIds(): Promise<string[]> {
    let items;
    try { items = await readdir(path.join(this.directory(), 'projects'), { withFileTypes: true }); }
    catch { return []; }
    return items.filter(item => item.isDirectory() && idPattern.test(item.name)).map(item => item.name);
  }

  private async readIndex(projectId?: string): Promise<ChatSessionSummary[]> {
    const file = this.indexFile(projectId);
    let raw: unknown;
    try { raw = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      // 索引损坏时保留原文件供人工恢复，不静默丢弃历史。
      const damaged = `${file}.damaged-${Date.now()}`;
      try { await rename(file, damaged); this.warning = `对话索引无法解析，已保留为 ${path.basename(damaged)} 并重新建立索引`; }
      catch { /* 无法保留原文件时继续使用空索引，避免阻塞对话。 */ }
      return [];
    }
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeSummary).filter((item): item is ChatSessionSummary => !!item);
  }
  private async writeIndex(projectId: string | undefined, sessions: ChatSessionSummary[]): Promise<void> {
    await atomicWrite(this.indexFile(projectId), sessions);
    // 索引变了，路由缓存随之失效：会话可能刚被创建、删除或改归属。
    this.routing = undefined;
  }
  private static sorted(sessions: ChatSessionSummary[]): ChatSessionSummary[] {
    return [...sessions].sort((a, b) => (a.lastMessageAt === b.lastMessageAt ? a.id.localeCompare(b.id) : b.lastMessageAt.localeCompare(a.lastMessageAt)));
  }
  private async readMessages(projectId: string, sessionId: string): Promise<ChatMessage[]> {
    let text: string;
    try { text = await readFile(this.messageFile(projectId, sessionId), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    return text.split('\n').map(line => line.trim()).filter(Boolean)
      .map(line => { try { return normalizeMessage(JSON.parse(line)); } catch { return undefined; } })
      .filter((item): item is ChatMessage => !!item);
  }

  private async readMemory(projectId: string, sessionId: string): Promise<ChatMemorySnapshot | undefined> {
    try {
      const raw = await readJson<unknown>(this.memoryFile(projectId, sessionId));
      const memory = normalizeMemory(raw);
      if (!memory) return undefined;
      return memory;
    } catch {
      // 快照损坏不能阻断当前会话；保留索引和消息，下一次派生会重新生成。
      this.warning = '部分对话历史摘要无法读取，已跳过损坏快照';
      return undefined;
    }
  }

  /** 遍历所有项目索引建立 `会话 -> 项目` 路由；只读路径复用同一份缓存。 */
  private async locate(sessionId: string): Promise<{ projectId: string; entry: ChatSessionSummary } | undefined> {
    const id = validId(sessionId);
    if (!this.routing) {
      const routing = new Map<string, string>();
      for (const projectId of await this.projectIds()) {
        for (const entry of await this.readIndex(projectId)) routing.set(entry.id, projectId);
      }
      this.routing = routing;
    }
    const projectId = this.routing.get(id);
    if (!projectId) return undefined;
    const entry = (await this.readIndex(projectId)).find(item => item.id === id);
    return entry ? { projectId, entry } : undefined;
  }

  /** 索引与消息数保持一致的唯一入口；重复提交同一轮不会产生重复消息。 */
  private async createEntry(input: { sessionId: string; projectId: string; title: string; providerId: string; model: string; titleSource?: 'auto' | 'user'; context?: ChatMaterialContext }): Promise<ChatSessionSummary> {
    const at = nowIso();
    return {
      id: input.sessionId, title: input.title, titleSource: input.titleSource ?? 'auto', pinned: false, pinOrder: 0,
      projectId: input.projectId, providerId: input.providerId, model: input.model,
      createdAt: at, updatedAt: at, lastMessageAt: at, messageCount: 0,
      ...(input.context ? { context: input.context } : {}),
    };
  }

  list(projectId?: string): Promise<ChatHistoryList> {
    return this.serial(async () => {
      await this.purgeExpiredTrash();
      // 指定项目时只读该项目目录：项目之间的数据互不干扰，读路径也不跨目录。
      const ids = projectId ? [assertProjectId(projectId)] : await this.projectIds();
      const sessions = ChatStore.sorted((await Promise.all(ids.map(async id => await this.readIndex(id)))).flat())
        .filter(item => !projectId || item.projectId === projectId);
      return { sessions, total: sessions.length, ...(this.warning ? { warning: this.warning } : {}) };
    });
  }

  get(sessionId: unknown): Promise<ChatSession> {
    return this.serial(async () => {
      const found = await this.locate(sessionId as string);
      if (!found) throw new DesktopError('CHAT_SESSION_NOT_FOUND', '对话不存在或已删除');
      const memory = await this.readMemory(found.projectId, found.entry.id);
      return { ...found.entry, messages: await this.readMessages(found.projectId, found.entry.id), ...(memory ? { memory } : {}) };
    });
  }

  /**
   * 从项目派生独立会话：历史只生成摘要快照，最近有消息会话的素材范围作为新会话初始上下文。
   * 快照与当前消息文件分开，避免旧对话被重复展示或后续修改相互污染。
   */
  fork(input: { sessionId: string; projectId: string; projectName?: string; sourceSessionId?: string; providerId?: string; model?: string }): Promise<ChatSession> {
    return this.serial(async () => {
      const id = validId(input.sessionId);
      const projectId = assertProjectId(input.projectId);
      const existing = await this.locate(id);
      if (existing) {
        const memory = await this.readMemory(existing.projectId, existing.entry.id);
        return { ...existing.entry, messages: await this.readMessages(existing.projectId, existing.entry.id), ...(memory ? { memory } : {}) };
      }
      const candidates = ChatStore.sorted(await this.readIndex(projectId)).filter(item => item.messageCount > 0);
      const source = input.sourceSessionId
        ? candidates.find(item => item.id === validId(input.sourceSessionId))
        : candidates[0];
      if (input.sourceSessionId && !source) throw new DesktopError('CHAT_SESSION_NOT_FOUND', '指定的源对话不存在或不属于当前项目');
      const conversations: ChatMemoryConversation[] = [];
      let used = 0;
      let truncatedCount = 0;
      for (const entry of candidates) {
        const messages = await this.readMessages(projectId, entry.id);
        const firstUser = messages.find(message => message.role === 'user')?.content;
        const lastAssistant = [...messages].reverse().find(message => message.role === 'assistant')?.content;
        const conversation: ChatMemoryConversation = {
          id: entry.id, projectId, title: entry.title, updatedAt: entry.updatedAt, messageCount: entry.messageCount,
          ...(firstUser ? { firstUser: trimMemoryText(firstUser) } : {}),
          ...(lastAssistant ? { lastAssistant: trimMemoryText(lastAssistant) } : {}),
          ...(entry.context ? { context: entry.context } : {}),
        };
        const weight = JSON.stringify(conversation).length;
        if (used + weight > MEMORY_LIMIT) { truncatedCount++; continue; }
        conversations.push(conversation); used += weight;
      }
      const memory: ChatMemorySnapshot = { projectId, generatedAt: nowIso(), conversations, truncatedCount };
      const title = autoTitle('新对话') || `${input.projectName ? `${input.projectName} · ` : ''}新对话`;
      const entry = await this.createEntry({ sessionId: id, projectId, title, providerId: input.providerId ?? '', model: input.model ?? '',
        ...(source?.context ? { context: source.context } : {}) });
      const sessions = await this.readIndex(projectId);
      sessions.push(entry);
      await this.writeIndex(projectId, ChatStore.sorted(sessions));
      await atomicWrite(this.memoryFile(projectId, id), memory);
      return { ...entry, messages: [], memory };
    });
  }

  /** 新建会话占位；标题为空时按「项目名 + 时间」回退。 */
  ensure(input: { sessionId: string; projectId?: string; title?: string; projectName?: string; providerId?: string; model?: string }): Promise<ChatSessionSummary> {
    return this.serial(async () => {
      const id = validId(input.sessionId);
      const target = input.projectId ? assertProjectId(input.projectId) : undefined;
      const existing = await this.locate(id);
      if (existing) {
        // 会话已存在但归属不同（例如先建在收容目录、后并入项目）：改归属并搬迁文件，
        // 不能在两个项目下各留一份索引，那会让侧栏出现重名会话。
        if (target && existing.projectId !== target) return this.moveSession(existing.projectId, target, existing.entry, next => ({ ...next, projectId: target }));
        return existing.entry;
      }
      const projectId = target ?? UNASSIGNED_PROJECT_ID;
      const title = autoTitle(input.title ?? '')
        || `${input.projectName ? `${input.projectName} · ` : ''}${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
      const entry = await this.createEntry({ sessionId: id, projectId, title, providerId: input.providerId ?? '', model: input.model ?? '' });
      const sessions = await this.readIndex(projectId);
      sessions.push(entry);
      await this.writeIndex(projectId, ChatStore.sorted(sessions));
      return entry;
    });
  }

  /** 会话改归属：搬移消息与摘要文件，并把索引从源项目迁到目标项目。 */
  private async moveSession(fromProjectId: string, toProjectId: string, entry: ChatSessionSummary, patch: (value: ChatSessionSummary) => ChatSessionSummary): Promise<ChatSessionSummary> {
    const next = patch(entry);
    for (const name of [`${entry.id}.jsonl`, `${entry.id}.memory.json`]) {
      const source = path.join(this.chatsDirectory(fromProjectId), name);
      try {
        await mkdir(this.chatsDirectory(toProjectId), { recursive: true });
        await rename(source, path.join(this.chatsDirectory(toProjectId), name));
      } catch (error) {
        // 源文件不存在时继续：空会话本来就只有索引，没有消息文件。
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const from = (await this.readIndex(fromProjectId)).filter(item => item.id !== entry.id);
    await this.writeIndex(fromProjectId, ChatStore.sorted(from));
    const to = await this.readIndex(toProjectId);
    to.push(next);
    await this.writeIndex(toProjectId, ChatStore.sorted(to));
    return next;
  }

  /** 更新会话的素材范围；新对话继承项目级共享上下文时走这里。 */
  async setContext(sessionId: unknown, context: ChatMaterialContext): Promise<ChatSessionSummary> {
    return this.serial(async () => {
      const found = await this.locate(sessionId as string);
      if (!found) throw new DesktopError('CHAT_SESSION_NOT_FOUND', '对话不存在或已删除');
      const sessions = await this.readIndex(found.projectId);
      const entry = sessions.find(item => item.id === found.entry.id)!;
      entry.context = context; entry.updatedAt = nowIso();
      await this.writeIndex(found.projectId, sessions);
      return entry;
    });
  }

  async rename(sessionId: unknown, title: unknown): Promise<ChatSessionSummary> {
    return this.serial(async () => {
      const text = typeof title === 'string' ? title.trim() : '';
      if (!text || text.length > 120) throw new DesktopError('CHAT_TITLE_INVALID', '对话名称需为 1 至 120 个字符');
      const found = await this.locate(sessionId as string);
      if (!found) throw new DesktopError('CHAT_SESSION_NOT_FOUND', '对话不存在或已删除');
      // 用户重命名后不再被自动标题覆盖。
      const sessions = await this.readIndex(found.projectId);
      const entry = sessions.find(item => item.id === found.entry.id)!;
      entry.title = text; entry.titleSource = 'user'; entry.updatedAt = nowIso();
      await this.writeIndex(found.projectId, sessions);
      return entry;
    });
  }

  async pin(sessionId: unknown, pinned: unknown): Promise<ChatSessionSummary> {
    return this.serial(async () => {
      const id = validId(sessionId);
      if (typeof pinned !== 'boolean') throw new DesktopError('CHAT_PIN_INVALID', '置顶参数无效');
      const found = await this.locate(id);
      if (!found) throw new DesktopError('CHAT_SESSION_NOT_FOUND', '对话不存在或已删除');
      const sessions = await this.readIndex(found.projectId);
      const entry = sessions.find(item => item.id === id)!;
      entry.pinned = pinned;
      entry.pinOrder = pinned ? Math.max(0, ...sessions.map(item => item.pinOrder)) + 1 : 0;
      entry.updatedAt = nowIso();
      await this.writeIndex(found.projectId, sessions);
      return entry;
    });
  }

  /** 回收站是项目内的：删除只影响本项目，别的项目目录不会被碰到。 */
  private async moveToTrash(projectId: string, targets: ChatSessionSummary[]): Promise<number> {
    const sessions = await this.readIndex(projectId);
    const kept = sessions.filter(item => !targets.some(target => target.id === item.id));
    const staged: string[] = [];
    await mkdir(this.trashDirectory(projectId), { recursive: true });
    for (const target of targets) {
      const messages = await this.readMessages(projectId, target.id);
      const memory = await this.readMemory(projectId, target.id);
      const id = `${target.id}-${Date.now()}-${randomUUID().slice(0, 8)}`;
      // 归属显式写进回收站条目：恢复时项目可能已被删除，摘要里的 projectId 只是当时的副本。
      await atomicWrite(path.join(this.trashDirectory(projectId), `${id}.json`), { id, sessionId: target.id, projectId, summary: target, messages,
        ...(memory ? { memory } : {}), deletedAt: nowIso() });
      staged.push(this.messageFile(projectId, target.id), this.memoryFile(projectId, target.id));
    }
    // 先写索引再删文件：宁可留下孤立消息文件，也不让索引指向缺失文件。
    await this.writeIndex(projectId, kept);
    for (const file of staged) { try { await rm(file, { force: true }); } catch { /* 孤立文件由清理流程处理。 */ } }
    return targets.length;
  }

  /** 按 id 删除：先定位归属再分组，逐项目入回收站。 */
  async delete(sessionIds: unknown): Promise<ChatMutationResult> {
    return this.serial(async () => {
      if (!Array.isArray(sessionIds) || !sessionIds.length || sessionIds.length > 500) throw new DesktopError('CHAT_SELECTION_INVALID', '请选择要删除的对话');
      const ids = new Set(sessionIds.map(value => validId(value)));
      const groups = new Map<string, ChatSessionSummary[]>();
      for (const projectId of await this.projectIds()) {
        const targets = (await this.readIndex(projectId)).filter(item => ids.has(item.id));
        if (targets.length) groups.set(projectId, targets);
      }
      let removed = 0;
      for (const [projectId, targets] of groups) removed += await this.moveToTrash(projectId, targets);
      return { removed };
    });
  }

  /** 清空全部对话：跨所有项目逐个入各自的回收站。 */
  clear(before?: unknown): Promise<ChatMutationResult> {
    return this.serial(async () => {
      const cutoff = typeof before === 'string' && before ? before : undefined;
      let removed = 0;
      for (const projectId of await this.projectIds()) {
        const sessions = await this.readIndex(projectId);
        const targets = cutoff ? sessions.filter(item => item.lastMessageAt < cutoff) : sessions;
        if (targets.length) removed += await this.moveToTrash(projectId, targets);
      }
      return { removed };
    });
  }

  trashList(): Promise<ChatTrashList> {
    return this.serial(async () => {
      await this.purgeExpiredTrash();
      const entries = (await Promise.all((await this.projectIds()).map(async projectId => await this.readTrash(projectId)))).flat();
      return { entries: entries.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt)), retentionDays: CHAT_TRASH_RETENTION_DAYS };
    });
  }

  private async readTrash(projectId: string): Promise<ChatTrashEntry[]> {
    let names: string[];
    try { names = await readdir(this.trashDirectory(projectId)); } catch { return []; }
    const entries: ChatTrashEntry[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const raw = await readJson<Record<string, unknown>>(path.join(this.trashDirectory(projectId), name));
      const deletedAt = typeof raw?.deletedAt === 'string' ? raw.deletedAt : nowIso();
      const summary = normalizeSummary(raw?.summary);
      if (!raw || typeof raw.id !== 'string' || !summary) continue;
      entries.push({ id: raw.id, sessionId: summary.id, title: summary.title,
        // 归属以回收站条目落盘时的项目为准：项目后来被删除也不影响恢复定位。
        projectId: typeof raw.projectId === 'string' ? raw.projectId : summary.projectId ?? UNASSIGNED_PROJECT_ID,
        messageCount: summary.messageCount, deletedAt,
        expiresAt: new Date(new Date(deletedAt).getTime() + CHAT_TRASH_RETENTION_DAYS * DAY_MS).toISOString() });
    }
    return entries;
  }

  async restore(trashIds: unknown): Promise<ChatMutationResult> {
    return this.serial(async () => {
      if (!Array.isArray(trashIds) || !trashIds.length || trashIds.length > 500) throw new DesktopError('CHAT_SELECTION_INVALID', '请选择要恢复的对话');
      const wanted = new Set(trashIds.map(value => validId(value)));
      let restored = 0;
      for (const projectId of await this.projectIds()) {
        const sessions = await this.readIndex(projectId);
        for (const entry of await this.readTrash(projectId)) {
          if (!wanted.has(entry.id)) continue;
          const file = path.join(this.trashDirectory(projectId), `${entry.id}.json`);
          const raw = await readJson<{ summary?: unknown; messages?: unknown[]; memory?: unknown }>(file);
          const summary = normalizeSummary(raw?.summary);
          if (!summary) continue;
          if (sessions.some(item => item.id === summary.id)) throw new DesktopError('CHAT_RESTORE_CONFLICT', `「${summary.title}」已存在，无法从回收站恢复`);
          const messages = (raw?.messages ?? []).map(normalizeMessage).filter((item): item is ChatMessage => !!item);
          await mkdir(this.chatsDirectory(projectId), { recursive: true });
          // 消息文件是逐行 JSONL，用文本写入；atomicWrite 会把入参整体 JSON.stringify，套在这里会把消息双重编码成一行。
          await atomicWriteText(this.messageFile(projectId, summary.id), messages.map(message => JSON.stringify(message)).join('\n') + (messages.length ? '\n' : ''));
          const memory = normalizeMemory(raw?.memory);
          if (memory) await atomicWrite(this.memoryFile(projectId, summary.id), memory);
          sessions.push({ ...summary, projectId, messageCount: messages.length });
          await this.writeIndex(projectId, ChatStore.sorted(sessions));
          await rm(file, { force: true });
          restored++;
        }
      }
      return { removed: 0, restored };
    });
  }

  purge(all?: unknown): Promise<ChatMutationResult> {
    return this.serial(async () => {
      this.purgedAt = Date.now();
      let removed = 0;
      for (const projectId of await this.projectIds()) removed += await this.removeTrash(projectId, all === true ? undefined : Date.now() - CHAT_TRASH_RETENTION_DAYS * DAY_MS);
      return { removed };
    });
  }
  private async removeTrash(projectId: string, cutoff?: number): Promise<number> {
    let names: string[];
    try { names = await readdir(this.trashDirectory(projectId)); } catch { return 0; }
    let removed = 0;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(this.trashDirectory(projectId), name);
      if (cutoff !== undefined) {
        const raw = await readJson<{ deletedAt?: string }>(file);
        const deletedAt = raw?.deletedAt ? new Date(raw.deletedAt).getTime() : Date.now();
        if (!Number.isFinite(deletedAt) || deletedAt > cutoff) continue;
      }
      try { await rm(file, { force: true }); removed++; } catch { /* 保留无法删除的条目，下次重试。 */ }
    }
    return removed;
  }
  /** 过期清理每小时最多执行一次，避免每次列表都扫描回收站。 */
  private async purgeExpiredTrash(): Promise<void> {
    if (Date.now() - this.purgedAt < 60 * 60 * 1000) return;
    this.purgedAt = Date.now();
    for (const projectId of await this.projectIds()) await this.removeTrash(projectId, Date.now() - CHAT_TRASH_RETENTION_DAYS * DAY_MS);
  }

  bundle(sessionIds?: unknown): Promise<{ exportedAt: string; version: number; sessions: ChatSession[] }> {
    return this.serial(async () => {
      const wanted = Array.isArray(sessionIds) && sessionIds.length ? new Set(sessionIds.map(value => validId(value))) : undefined;
      const all = ChatStore.sorted((await Promise.all((await this.projectIds()).map(async projectId => await this.readIndex(projectId)))).flat())
        .filter(item => !wanted || wanted.has(item.id));
      const bundle: ChatSession[] = [];
      for (const entry of all) {
        const projectId = (await this.locate(entry.id))?.projectId ?? UNASSIGNED_PROJECT_ID;
        const memory = await this.readMemory(projectId, entry.id);
        bundle.push({ ...entry, messages: await this.readMessages(projectId, entry.id), ...(memory ? { memory } : {}) });
      }
      return { exportedAt: nowIso(), version: 1, sessions: bundle };
    });
  }

  status(): Promise<ChatHistoryStatus> {
    return this.serial(async () => {
      const projectIds = await this.projectIds();
      const sessions = (await Promise.all(projectIds.map(async id => await this.readIndex(id)))).flat();
      let bytes = 0;
      const visit = async (directory: string) => {
        let items; try { items = await readdir(directory, { withFileTypes: true }); } catch { return; }
        for (const item of items) {
          const child = path.join(directory, item.name);
          let info; try { info = await lstat(child); } catch { continue; }
          if (info.isSymbolicLink()) continue;
          if (info.isDirectory()) { await visit(child); continue; }
          if (info.isFile()) bytes += info.size;
        }
      };
      let trashBytes = 0, trashEntries = 0;
      for (const projectId of projectIds) {
        for (const entry of await this.readTrash(projectId)) {
          trashEntries++;
          try { trashBytes += (await lstat(path.join(this.trashDirectory(projectId), `${entry.id}.json`))).size; } catch { /* 条目已被并发清理。 */ }
        }
      }
      return { root: this.directory(), sessions: sessions.length, messages: sessions.reduce((sum, item) => sum + item.messageCount, 0),
        bytes, trash: { entries: trashEntries, bytes: trashBytes, retentionDays: CHAT_TRASH_RETENTION_DAYS },
        ...(this.warning ? { warning: this.warning } : {}) };
    });
  }

  /**
   * 一次对话完成后幂等落盘：本次提交的完整消息列表与已落库内容按前缀对齐，只追加未记录的消息，再追加助手回复。
   * 按内容对齐而不是按索引计数截断：界面历史一旦比落库短（读盘失败、会话列表被清理），
   * 计数截断会把新一轮发送连同回复整段丢掉；重复提交同一轮时两者等价，都不会产生重复消息。
   * 失败调用同样记一条带 error 的助手消息，保证索引计数与文件内容一致。
   */
  async record(input: ChatRecordInput): Promise<void> {
    return this.serial(async () => {
      const id = validId(input.sessionId);
      const target = input.projectId ? assertProjectId(input.projectId) : undefined;
      let found = await this.locate(id);
      // 会话落在收容目录、这次带了项目归属：先搬迁再落盘，避免同一轮对话被拆到两个目录。
      if (found && target && found.projectId !== target) {
        await this.moveSession(found.projectId, target, found.entry, next => ({ ...next, projectId: target }));
        found = { projectId: target, entry: { ...found.entry, projectId: target } };
      }
      const projectId = found?.projectId ?? target ?? UNASSIGNED_PROJECT_ID;
      let sessions = await this.readIndex(projectId);
      const messages = input.messages.map(value => ({ role: value.role, content: value.content }));
      let entry = sessions.find(item => item.id === id);
      const recorded = await this.readMessages(projectId, id);
      if (!entry) {
        const firstUser = (recorded.find(value => value.role === 'user') ?? messages.find(value => value.role === 'user'))?.content ?? '';
        entry = await this.createEntry({ sessionId: id, projectId,
          title: autoTitle(firstUser) || new Date().toISOString().slice(0, 16).replace('T', ' '), providerId: input.providerId, model: input.model });
        sessions.push(entry);
      }
      let indexChanged = false;
      if (input.context) {
        entry.context = input.context;
        indexChanged = true;
      }
      let aligned = 0;
      while (aligned < messages.length && aligned < recorded.length) {
        const role = roles.has(messages[aligned].role as ChatRole) ? messages[aligned].role as ChatRole : 'user';
        if (recorded[aligned].role !== role || recorded[aligned].content !== messages[aligned].content) break;
        aligned++;
      }
      const pending = messages.slice(aligned);
      if (!pending.length) {
        // 本次提交的每一条消息都已落库（同一轮重复提交）：直接返回，避免重复消息。
        if (indexChanged) await this.writeIndex(projectId, ChatStore.sorted(sessions));
        return;
      }
      const at = nowIso();
      const appended: ChatMessage[] = pending.map(message => ({ role: roles.has(message.role as ChatRole) ? message.role as ChatRole : 'user', content: message.content, createdAt: at }));
      appended.push(input.error
        ? { role: 'assistant', content: input.reply ?? '', createdAt: at, status: 'error', error: input.error }
        : { role: 'assistant', content: input.reply ?? '', createdAt: at });
      // 用户改过标题则保持人工标题；自动标题跟随落库内容的最早一条用户消息，历史短于落库时也不会漂移。
      if (entry.titleSource === 'auto') {
        const firstUser = (recorded.find(value => value.role === 'user') ?? messages.find(value => value.role === 'user'))?.content ?? '';
        const generated = autoTitle(firstUser);
        if (generated) entry.title = generated;
      }
      entry.providerId = input.providerId; entry.model = input.model;
      if (input.projectId) entry.projectId = input.projectId;
      entry.messageCount = recorded.length + appended.length;
      entry.lastMessageAt = at; entry.updatedAt = at;
      await mkdir(this.chatsDirectory(projectId), { recursive: true });
      await appendFile(this.messageFile(projectId, id), appended.map(message => JSON.stringify(message)).join('\n') + '\n');
      await this.writeIndex(projectId, ChatStore.sorted(sessions));
    });
  }

  /**
   * 项目删除时，该项目下的对话一并移入回收站：已删除的项目不再出现在侧栏，也不再长期保留会话。
   * 移入回收站（而非直接抹掉）沿用「删除先进回收站」的统一规则，7 天内可从设置里恢复。
   */
  async deleteByProject(projectId: string): Promise<number> {
    return this.serial(async () => {
      const id = assertProjectId(projectId);
      // 会话可能被改过归属，以索引里实际记录的归属为准逐个清理。
      let removed = 0;
      for (const candidate of await this.projectIds()) {
        const targets = (await this.readIndex(candidate)).filter(item => item.projectId === id);
        if (targets.length) removed += await this.moveToTrash(candidate, targets);
      }
      return removed;
    });
  }
}