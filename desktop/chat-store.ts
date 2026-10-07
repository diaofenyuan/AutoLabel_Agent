import { randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  CHAT_TITLE_LIMIT, CHAT_TRASH_RETENTION_DAYS, type ChatHistoryList, type ChatHistoryStatus, type ChatMessage,
  type ChatMaterialContext, type ChatMemoryConversation, type ChatMemorySnapshot, type ChatMutationResult, type ChatRole,
  type ChatSession, type ChatSessionSummary, type ChatTrashEntry, type ChatTrashList,
} from '../shared/chat';
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
 * 对话记录落盘：`index.json` 保存会话索引，`<sessionId>.jsonl` 逐条追加消息。
 * 索引与消息文件必须成对处理，删除一律先入 `.trash/`，避免误删不可恢复。
 */
export class ChatStore {
  private pending: Promise<unknown> = Promise.resolve();
  private warning?: string;
  private purgedAt = 0;
  constructor(private root: () => string) {}

  private directory(): string {
    const root = this.root();
    if (!root) throw new DesktopError('CHAT_STORAGE_UNAVAILABLE', '对话记录目录尚未就绪，请在设置中检查存储位置');
    return root;
  }
  private indexFile(): string { return path.join(this.directory(), 'index.json'); }
  private messageFile(sessionId: string): string { return path.join(this.directory(), `${sessionId}.jsonl`); }
  private memoryFile(sessionId: string): string { return path.join(this.directory(), `${sessionId}.memory.json`); }
  private trashDirectory(): string { return path.join(this.directory(), '.trash'); }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation);
    this.pending = next.catch(() => undefined);
    return next;
  }

  private async readIndex(): Promise<ChatSessionSummary[]> {
    let raw: unknown;
    try { raw = JSON.parse(await readFile(this.indexFile(), 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      // 索引损坏时保留原文件供人工恢复，不静默丢弃历史。
      const damaged = `${this.indexFile()}.damaged-${Date.now()}`;
      try { await rename(this.indexFile(), damaged); this.warning = `对话索引无法解析，已保留为 ${path.basename(damaged)} 并重新建立索引`; }
      catch { /* 无法保留原文件时继续使用空索引，避免阻塞对话。 */ }
      return [];
    }
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeSummary).filter((item): item is ChatSessionSummary => !!item);
  }
  private writeIndex(sessions: ChatSessionSummary[]): Promise<void> { return atomicWrite(this.indexFile(), sessions); }
  private static sorted(sessions: ChatSessionSummary[]): ChatSessionSummary[] {
    return [...sessions].sort((a, b) => (a.lastMessageAt === b.lastMessageAt ? a.id.localeCompare(b.id) : b.lastMessageAt.localeCompare(a.lastMessageAt)));
  }
  private async readMessages(sessionId: string): Promise<ChatMessage[]> {
    let text: string;
    try { text = await readFile(this.messageFile(sessionId), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    return text.split('\n').map(line => line.trim()).filter(Boolean)
      .map(line => { try { return normalizeMessage(JSON.parse(line)); } catch { return undefined; } })
      .filter((item): item is ChatMessage => !!item);
  }

  private async readMemory(sessionId: string): Promise<ChatMemorySnapshot | undefined> {
    try {
      const raw = await readJson<unknown>(this.memoryFile(sessionId));
      const memory = normalizeMemory(raw);
      if (!memory) return undefined;
      return memory;
    } catch {
      // 快照损坏不能阻断当前会话；保留索引和消息，下一次派生会重新生成。
      this.warning = '部分对话历史摘要无法读取，已跳过损坏快照';
      return undefined;
    }
  }

  /** 索引与消息数保持一致的唯一入口；重复提交同一轮不会产生重复消息。 */
  private async createEntry(input: { sessionId: string; projectId?: string; title: string; providerId: string; model: string; titleSource?: 'auto' | 'user'; context?: ChatMaterialContext }): Promise<ChatSessionSummary> {
    const at = nowIso();
    return {
      id: input.sessionId, title: input.title, titleSource: input.titleSource ?? 'auto', pinned: false, pinOrder: 0,
      ...(input.projectId ? { projectId: input.projectId } : {}), providerId: input.providerId, model: input.model,
      createdAt: at, updatedAt: at, lastMessageAt: at, messageCount: 0,
      ...(input.context ? { context: input.context } : {}),
    };
  }

  list(projectId?: string): Promise<ChatHistoryList> {
    return this.serial(async () => {
      await this.purgeExpiredTrash();
      const sessions = ChatStore.sorted(await this.readIndex()).filter(item => !projectId || item.projectId === projectId);
      return { sessions, total: sessions.length, ...(this.warning ? { warning: this.warning } : {}) };
    });
  }

  get(sessionId: unknown): Promise<ChatSession> {
    return this.serial(async () => {
      const id = validId(sessionId);
      const entry = (await this.readIndex()).find(item => item.id === id);
      if (!entry) throw new DesktopError('CHAT_SESSION_NOT_FOUND', '对话不存在或已删除');
      const memory = await this.readMemory(id);
      return { ...entry, messages: await this.readMessages(id), ...(memory ? { memory } : {}) };
    });
  }

  /**
   * 从项目派生独立会话：历史只生成摘要快照，最近有消息会话的素材范围作为新会话初始上下文。
   * 快照与当前消息文件分开，避免旧对话被重复展示或后续修改相互污染。
   */
  fork(input: { sessionId: string; projectId: string; projectName?: string; sourceSessionId?: string; providerId?: string; model?: string }): Promise<ChatSession> {
    return this.serial(async () => {
      const id = validId(input.sessionId);
      const projectId = validId(input.projectId);
      const sessions = await this.readIndex();
      const existing = sessions.find(item => item.id === id);
      if (existing) {
        const memory = await this.readMemory(id);
        return { ...existing, messages: await this.readMessages(id), ...(memory ? { memory } : {}) };
      }
      const candidates = ChatStore.sorted(sessions).filter(item => item.projectId === projectId && item.messageCount > 0);
      const source = input.sourceSessionId
        ? candidates.find(item => item.id === validId(input.sourceSessionId))
        : candidates[0];
      if (input.sourceSessionId && !source) throw new DesktopError('CHAT_SESSION_NOT_FOUND', '指定的源对话不存在或不属于当前项目');
      const conversations: ChatMemoryConversation[] = [];
      let used = 0;
      let truncatedCount = 0;
      for (const entry of candidates) {
        const messages = await this.readMessages(entry.id);
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
      sessions.push(entry);
      await this.writeIndex(ChatStore.sorted(sessions));
      await atomicWrite(this.memoryFile(id), memory);
      return { ...entry, messages: [], memory };
    });
  }

  /** 新建会话占位；标题为空时按「项目名 + 时间」回退。 */
  ensure(input: { sessionId: string; projectId?: string; title?: string; projectName?: string; providerId?: string; model?: string }): Promise<ChatSessionSummary> {
    return this.serial(async () => {
      const id = validId(input.sessionId);
      const sessions = await this.readIndex();
      const existing = sessions.find(item => item.id === id);
      if (existing) {
        const next = { ...existing, ...(input.projectId ? { projectId: input.projectId } : {}) };
        if (next.projectId !== existing.projectId) { Object.assign(existing, next); await this.writeIndex(sessions); }
        return existing;
      }
      const title = autoTitle(input.title ?? '')
        || `${input.projectName ? `${input.projectName} · ` : ''}${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
      const entry = await this.createEntry({ sessionId: id, ...(input.projectId ? { projectId: input.projectId } : {}), title,
        providerId: input.providerId ?? '', model: input.model ?? '' });
      sessions.push(entry);
      await this.writeIndex(ChatStore.sorted(sessions));
      return entry;
    });
  }

  rename(sessionId: unknown, title: unknown): Promise<ChatSessionSummary> {
    return this.serial(async () => {
      const id = validId(sessionId);
      const text = typeof title === 'string' ? title.trim() : '';
      if (!text || text.length > 120) throw new DesktopError('CHAT_TITLE_INVALID', '对话名称需为 1 至 120 个字符');
      const sessions = await this.readIndex();
      const entry = sessions.find(item => item.id === id);
      if (!entry) throw new DesktopError('CHAT_SESSION_NOT_FOUND', '对话不存在或已删除');
      // 用户重命名后不再被自动标题覆盖。
      entry.title = text; entry.titleSource = 'user'; entry.updatedAt = nowIso();
      await this.writeIndex(sessions);
      return entry;
    });
  }

  pin(sessionId: unknown, pinned: unknown): Promise<ChatSessionSummary> {
    return this.serial(async () => {
      const id = validId(sessionId);
      if (typeof pinned !== 'boolean') throw new DesktopError('CHAT_PIN_INVALID', '置顶参数无效');
      const sessions = await this.readIndex();
      const entry = sessions.find(item => item.id === id);
      if (!entry) throw new DesktopError('CHAT_SESSION_NOT_FOUND', '对话不存在或已删除');
      entry.pinned = pinned;
      entry.pinOrder = pinned ? Math.max(0, ...sessions.map(item => item.pinOrder)) + 1 : 0;
      entry.updatedAt = nowIso();
      await this.writeIndex(sessions);
      return entry;
    });
  }

  private async moveToTrash(sessions: ChatSessionSummary[], targets: ChatSessionSummary[]): Promise<number> {
    const kept = sessions.filter(item => !targets.some(target => target.id === item.id));
    const staged: Array<{ file: string; id: string }> = [];
    await mkdir(this.trashDirectory(), { recursive: true });
    for (const target of targets) {
      const messages = await this.readMessages(target.id);
      const memory = await this.readMemory(target.id);
      const id = `${target.id}-${Date.now()}-${randomUUID().slice(0, 8)}`;
      await atomicWrite(path.join(this.trashDirectory(), `${id}.json`), { id, sessionId: target.id, summary: target, messages,
        ...(memory ? { memory } : {}), deletedAt: nowIso() });
      staged.push({ file: this.messageFile(target.id), id: target.id });
      staged.push({ file: this.memoryFile(target.id), id: target.id });
    }
    // 先写索引再删文件：宁可留下孤立消息文件，也不让索引指向缺失文件。
    await this.writeIndex(kept);
    for (const item of staged) { try { await rm(item.file, { force: true }); } catch { /* 孤立文件由清理流程处理。 */ } }
    return targets.length;
  }

  delete(sessionIds: unknown): Promise<ChatMutationResult> {
    return this.serial(async () => {
      if (!Array.isArray(sessionIds) || !sessionIds.length || sessionIds.length > 500) throw new DesktopError('CHAT_SELECTION_INVALID', '请选择要删除的对话');
      const ids = new Set(sessionIds.map(value => validId(value)));
      const sessions = await this.readIndex();
      const targets = sessions.filter(item => ids.has(item.id));
      return { removed: await this.moveToTrash(sessions, targets) };
    });
  }

  clear(before?: unknown): Promise<ChatMutationResult> {
    return this.serial(async () => {
      const cutoff = typeof before === 'string' && before ? before : undefined;
      const sessions = await this.readIndex();
      const targets = cutoff ? sessions.filter(item => item.lastMessageAt < cutoff) : sessions;
      return { removed: await this.moveToTrash(sessions, targets) };
    });
  }

  trashList(): Promise<ChatTrashList> {
    return this.serial(async () => {
      await this.purgeExpiredTrash();
      return { entries: await this.readTrash(), retentionDays: CHAT_TRASH_RETENTION_DAYS };
    });
  }

  private async readTrash(): Promise<ChatTrashEntry[]> {
    let names: string[];
    try { names = await readdir(this.trashDirectory()); } catch { return []; }
    const entries: ChatTrashEntry[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const raw = await readJson<Record<string, unknown>>(path.join(this.trashDirectory(), name));
      const deletedAt = typeof raw?.deletedAt === 'string' ? raw.deletedAt : nowIso();
      const summary = normalizeSummary(raw?.summary);
      if (!raw || typeof raw.id !== 'string' || !summary) continue;
      entries.push({ id: raw.id, sessionId: summary.id, title: summary.title,
        ...(summary.projectId ? { projectId: summary.projectId } : {}), messageCount: summary.messageCount, deletedAt,
        expiresAt: new Date(new Date(deletedAt).getTime() + CHAT_TRASH_RETENTION_DAYS * DAY_MS).toISOString() });
    }
    return entries.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  }

  restore(trashIds: unknown): Promise<ChatMutationResult> {
    return this.serial(async () => {
      if (!Array.isArray(trashIds) || !trashIds.length || trashIds.length > 500) throw new DesktopError('CHAT_SELECTION_INVALID', '请选择要恢复的对话');
      const wanted = new Set(trashIds.map(value => validId(value)));
      const sessions = await this.readIndex();
      let restored = 0;
      for (const entry of await this.readTrash()) {
        if (!wanted.has(entry.id)) continue;
        const file = path.join(this.trashDirectory(), `${entry.id}.json`);
        const raw = await readJson<{ summary?: unknown; messages?: unknown[]; memory?: unknown }>(file);
        const summary = normalizeSummary(raw?.summary);
        if (!summary) continue;
        if (sessions.some(item => item.id === summary.id)) throw new DesktopError('CHAT_RESTORE_CONFLICT', `「${summary.title}」已存在，无法从回收站恢复`);
        const messages = (raw?.messages ?? []).map(normalizeMessage).filter((item): item is ChatMessage => !!item);
        await mkdir(this.directory(), { recursive: true });
        // 消息文件是逐行 JSONL，用文本写入；atomicWrite 会把入参整体 JSON.stringify，套在这里会把消息双重编码成一行。
        await atomicWriteText(this.messageFile(summary.id), messages.map(message => JSON.stringify(message)).join('\n') + (messages.length ? '\n' : ''));
        const memory = normalizeMemory(raw?.memory);
        if (memory) await atomicWrite(this.memoryFile(summary.id), memory);
        sessions.push({ ...summary, messageCount: messages.length });
        await this.writeIndex(ChatStore.sorted(sessions));
        await rm(file, { force: true });
        restored++;
      }
      return { removed: 0, restored };
    });
  }

  purge(all?: unknown): Promise<ChatMutationResult> {
    return this.serial(async () => {
      this.purgedAt = Date.now();
      return { removed: await this.removeTrash(all === true ? undefined : Date.now() - CHAT_TRASH_RETENTION_DAYS * DAY_MS) };
    });
  }
  private async removeTrash(cutoff?: number): Promise<number> {
    let names: string[];
    try { names = await readdir(this.trashDirectory()); } catch { return 0; }
    let removed = 0;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(this.trashDirectory(), name);
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
    await this.removeTrash(Date.now() - CHAT_TRASH_RETENTION_DAYS * DAY_MS);
  }

  bundle(sessionIds?: unknown): Promise<{ exportedAt: string; version: number; sessions: ChatSession[] }> {
    return this.serial(async () => {
      const wanted = Array.isArray(sessionIds) && sessionIds.length ? new Set(sessionIds.map(value => validId(value))) : undefined;
      const sessions = ChatStore.sorted(await this.readIndex()).filter(item => !wanted || wanted.has(item.id));
      const bundle: ChatSession[] = [];
      for (const entry of sessions) {
        const memory = await this.readMemory(entry.id);
        bundle.push({ ...entry, messages: await this.readMessages(entry.id), ...(memory ? { memory } : {}) });
      }
      return { exportedAt: nowIso(), version: 1, sessions: bundle };
    });
  }

  status(): Promise<ChatHistoryStatus> {
    return this.serial(async () => {
      const sessions = await this.readIndex();
      let bytes = 0, files = 0;
      const visit = async (directory: string) => {
        let items; try { items = await readdir(directory, { withFileTypes: true }); } catch { return; }
        for (const item of items) {
          const child = path.join(directory, item.name);
          let info; try { info = await lstat(child); } catch { continue; }
          if (info.isSymbolicLink()) continue;
          if (info.isDirectory()) { await visit(child); continue; }
          if (info.isFile()) { bytes += info.size; files++; }
        }
      };
      await visit(this.directory());
      let trashBytes = 0, trashEntries = 0;
      for (const entry of await this.readTrash()) {
        trashEntries++;
        try { trashBytes += (await lstat(path.join(this.trashDirectory(), `${entry.id}.json`))).size; } catch { /* 条目已被并发清理。 */ }
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
  record(input: ChatRecordInput): Promise<void> {
    return this.serial(async () => {
      const id = validId(input.sessionId);
      const sessions = await this.readIndex();
      const messages = input.messages.map(value => ({ role: value.role, content: value.content }));
      let entry = sessions.find(item => item.id === id);
      const recorded = await this.readMessages(id);
      if (!entry) {
        const firstUser = (recorded.find(value => value.role === 'user') ?? messages.find(value => value.role === 'user'))?.content ?? '';
        entry = await this.createEntry({ sessionId: id, ...(input.projectId ? { projectId: input.projectId } : {}),
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
        if (indexChanged) await this.writeIndex(ChatStore.sorted(sessions));
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
      await mkdir(this.directory(), { recursive: true });
      await appendFile(this.messageFile(id), appended.map(message => JSON.stringify(message)).join('\n') + '\n');
      await this.writeIndex(ChatStore.sorted(sessions));
    });
  }

  /**
   * 项目删除时，该项目下的对话一并移入回收站：已删除的项目不再出现在侧栏，也不再长期保留会话。
   * 移入回收站（而非直接抹掉）沿用「删除先进回收站」的统一规则，7 天内可从设置里恢复。
   */
  deleteByProject(projectId: string): Promise<number> {
    return this.serial(async () => {
      const sessions = await this.readIndex();
      const targets = sessions.filter(item => item.projectId === projectId);
      return this.moveToTrash(sessions, targets);
    });
  }
}
