import { randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  CHAT_TITLE_LIMIT, CHAT_TRASH_RETENTION_DAYS, type ChatHistoryList, type ChatHistoryStatus, type ChatMessage,
  type ChatMutationResult, type ChatRole, type ChatSession, type ChatSessionSummary, type ChatTrashEntry, type ChatTrashList,
} from '../shared/chat';
import { DesktopError } from './validation';

const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const roles = new Set<ChatRole>(['system', 'user', 'assistant', 'tool']);
const DAY_MS = 24 * 60 * 60 * 1000;

function validId(value: unknown): string {
  if (typeof value !== 'string' || !idPattern.test(value)) throw new DesktopError('CHAT_SESSION_INVALID', '对话标识无效');
  return value;
}

/** 首条用户消息压成单行并截断；侧栏单行展示不再二次处理。 */
export function autoTitle(text: string): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > CHAT_TITLE_LIMIT ? `${flat.slice(0, CHAT_TITLE_LIMIT)}…` : flat;
}

function nowIso(): string { return new Date().toISOString(); }

async function atomicWrite(filename: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = filename + '.tmp';
  const file = await open(temporary, 'w');
  try { await file.writeFile(JSON.stringify(data)); await file.sync(); } finally { await file.close(); }
  await rename(temporary, filename);
}

async function readJson<T>(filename: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(filename, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
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
    status: item.status === 'deleted-project' ? 'deleted-project' : 'active',
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

  /** 索引与消息数保持一致的唯一入口；重复提交同一轮不会产生重复消息。 */
  private async createEntry(input: { sessionId: string; projectId?: string; title: string; providerId: string; model: string; titleSource?: 'auto' | 'user' }): Promise<ChatSessionSummary> {
    const at = nowIso();
    return {
      id: input.sessionId, title: input.title, titleSource: input.titleSource ?? 'auto', pinned: false, pinOrder: 0,
      ...(input.projectId ? { projectId: input.projectId } : {}), providerId: input.providerId, model: input.model,
      createdAt: at, updatedAt: at, lastMessageAt: at, messageCount: 0, status: 'active',
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
      return { ...entry, messages: await this.readMessages(id) };
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
      const id = `${target.id}-${Date.now()}-${randomUUID().slice(0, 8)}`;
      await atomicWrite(path.join(this.trashDirectory(), `${id}.json`), { id, sessionId: target.id, summary: target, messages, deletedAt: nowIso() });
      staged.push({ file: this.messageFile(target.id), id: target.id });
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
        const raw = await readJson<{ summary?: unknown; messages?: unknown[] }>(file);
        const summary = normalizeSummary(raw?.summary);
        if (!summary) continue;
        if (sessions.some(item => item.id === summary.id)) throw new DesktopError('CHAT_RESTORE_CONFLICT', `「${summary.title}」已存在，无法从回收站恢复`);
        const messages = (raw?.messages ?? []).map(normalizeMessage).filter((item): item is ChatMessage => !!item);
        await mkdir(this.directory(), { recursive: true });
        await atomicWrite(this.messageFile(summary.id), messages.map(message => JSON.stringify(message)).join('\n') + (messages.length ? '\n' : ''));
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
      for (const entry of sessions) bundle.push({ ...entry, messages: await this.readMessages(entry.id) });
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
   * 一次对话完成后幂等落盘：按 messageCount 追加未记录的消息，再追加助手回复。
   * 失败调用同样记一条带 error 的助手消息，保证索引计数与文件内容一致。
   */
  record(input: ChatRecordInput): Promise<void> {
    return this.serial(async () => {
      const id = validId(input.sessionId);
      const sessions = await this.readIndex();
      const messages = input.messages.map(value => ({ role: value.role, content: value.content }));
      const firstUser = messages.find(value => value.role === 'user')?.content ?? '';
      let entry = sessions.find(item => item.id === id);
      if (!entry) {
        entry = await this.createEntry({ sessionId: id, ...(input.projectId ? { projectId: input.projectId } : {}),
          title: autoTitle(firstUser) || new Date().toISOString().slice(0, 16).replace('T', ' '), providerId: input.providerId, model: input.model });
        sessions.push(entry);
      }
      const pending = messages.slice(entry.messageCount);
      if (!pending.length && entry.messageCount > 0) {
        // 同一轮重复提交：索引已包含该轮，直接返回，避免重复消息。
        await this.writeIndex(ChatStore.sorted(sessions));
        return;
      }
      const at = nowIso();
      const appended: ChatMessage[] = pending.map(message => ({ role: roles.has(message.role as ChatRole) ? message.role as ChatRole : 'user', content: message.content, createdAt: at }));
      appended.push(input.error
        ? { role: 'assistant', content: input.reply ?? '', createdAt: at, status: 'error', error: input.error }
        : { role: 'assistant', content: input.reply ?? '', createdAt: at });
      // 用户改过标题则保持人工标题；自动标题只在首次写入时确定。
      if (entry.titleSource === 'auto') {
        const generated = autoTitle(firstUser);
        if (generated) entry.title = generated;
      }
      entry.providerId = input.providerId; entry.model = input.model;
      if (input.projectId) entry.projectId = input.projectId;
      entry.messageCount += appended.length;
      entry.lastMessageAt = at; entry.updatedAt = at;
      await mkdir(this.directory(), { recursive: true });
      await appendFile(this.messageFile(id), appended.map(message => JSON.stringify(message)).join('\n') + '\n');
      await this.writeIndex(ChatStore.sorted(sessions));
    });
  }

  /** 项目删除后历史仍可查看，仅标记来源项目已删除。 */
  markProjectDeleted(projectId: string): Promise<number> {
    return this.serial(async () => {
      const sessions = await this.readIndex();
      let changed = 0;
      for (const entry of sessions) {
        if (entry.projectId !== projectId || entry.status === 'deleted-project') continue;
        entry.status = 'deleted-project'; entry.updatedAt = nowIso(); changed++;
      }
      if (changed) await this.writeIndex(ChatStore.sorted(sessions));
      return changed;
    });
  }
}
