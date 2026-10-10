import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChatMaterialContext } from '../shared/chat';
import { DesktopError } from './validation';

/**
 * 项目工作区：把一个项目的对话记录、共享上下文与项目文件收进同一个文件夹。
 *
 * 设计取舍：标注、素材索引等业务数据仍由引擎的单个 SQLite 库持有——
 * 按项目拆库会牵动全部查询、外键与备份链路，收益远小于风险。
 * 因此「按项目隔离」落在**文件层**：对话与项目上下文天然一项目一份，
 * 拆开没有一致性代价；库内记录仍带 project_id，查询口径不变。
 * 素材文件同样按项目落盘（引擎侧 projectMediaRoot），文件层面的隔离才真正成立。
 */

/** 顶层目录名，位于存储根之下，与 datasets / uploads / chats 并列。 */
export const PROJECTS_SUBDIRECTORY = 'projects';
/** 未归属项目的对话（历史遗留）单独收容，避免与真实项目混在一起。 */
export const UNASSIGNED_PROJECT_ID = '_unassigned';
/**
 * 迁移完成标记。
 *
 * 不能拿「`projects/` 目录存在」当迁移过的证据：正常使用时 ensure() 就会建出这个目录，
 * 升级后的用户只要碰过一次项目文件夹，旧数据就会被误判成「已迁移」而永远留在原地。
 * 因此由迁移流程在收尾时显式落这个标记文件。
 */
export const MIGRATION_MARKER = '.layout-migrated';
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const CONTEXT_FILENAME = 'context.json';

export interface ProjectWorkspacePaths {
  projectId: string;
  /** 项目根目录：对话、上下文与项目素材都落在这里。 */
  root: string;
  chats: string;
  files: string;
  /** 引擎写入的项目素材目录；桌面侧只用于展示与校验，不直接落盘。 */
  media: string;
  context: string;
}

/**
 * 项目级共享上下文：新对话从这里继承默认素材范围与配置。
 * 只描述 ID 与范围，不携带素材内容，也不授权项目外路径。
 */
export interface ProjectContext {
  projectId: string;
  /** 最近一次实际使用的素材范围，作为新对话的初始上下文。 */
  context?: ChatMaterialContext;
  updatedAt: string;
}

/** 项目文件夹的占用情况，供设置页与概览展示。 */
export interface ProjectWorkspaceStatus extends ProjectWorkspacePaths {
  exists: boolean;
  conversations: number;
  bytes: number;
}

export function assertProjectId(value: unknown): string {
  if (typeof value !== 'string' || !idPattern.test(value)) throw new DesktopError('PROJECT_ID_INVALID', '项目标识无效');
  return value;
}

function nowIso(): string { return new Date().toISOString(); }

async function measure(directory: string): Promise<number> {
  let bytes = 0;
  const visit = async (current: string): Promise<void> => {
    let items;
    try { items = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      const child = path.join(current, item.name);
      if (item.isDirectory()) { await visit(child); continue; }
      if (!item.isFile()) continue;
      try { bytes += (await stat(child)).size; } catch { /* 统计期间被删除的文件跳过即可。 */ }
    }
  };
  await visit(directory);
  return bytes;
}

/**
 * 解析单个项目的工作区路径。目录按需创建，不做写入探测：
 * 这里只计算路径，真正的可写性由对话存储在落盘时报错，避免每次列项目都写一次磁盘。
 */
export class ProjectWorkspace {
  constructor(private root: () => string) {}

  /** 项目工作区总根：`<存储根>/projects`。 */
  base(): string {
    const root = this.root();
    if (!root) throw new DesktopError('PROJECT_STORAGE_UNAVAILABLE', '项目文件夹尚未就绪，请在设置中检查存储位置');
    return path.join(root, PROJECTS_SUBDIRECTORY);
  }

  paths(projectId: string): ProjectWorkspacePaths {
    const id = assertProjectId(projectId);
    const root = path.join(this.base(), id);
    return { projectId: id, root, chats: path.join(root, 'chats'), files: path.join(root, 'files'), media: path.join(root, 'media'), context: path.join(root, CONTEXT_FILENAME) };
  }

  /** 建好项目工作区的骨架；已存在时不做任何事。 */
  async ensure(projectId: string): Promise<ProjectWorkspacePaths> {
    const paths = this.paths(projectId);
    await mkdir(paths.chats, { recursive: true });
    await mkdir(paths.files, { recursive: true });
    return paths;
  }

  /** 项目文件夹不存在即视为没有历史数据，不当作错误。 */
  async exists(projectId: string): Promise<boolean> {
    try { return (await stat(this.paths(projectId).root)).isDirectory(); }
    catch { return false; }
  }

  async list(): Promise<string[]> {
    let items;
    try { items = await readdir(this.base(), { withFileTypes: true }); }
    catch { return []; }
    return items.filter(item => item.isDirectory()).map(item => item.name).filter(name => idPattern.test(name));
  }

  /**
   * 删除项目工作区目录。调用方必须已经完成业务数据删除：
   * 这里只清理本模块拥有的文件。删除项目是显式确认过的破坏性动作，不做回收站化。
   */
  async remove(projectId: string): Promise<void> {
    await rm(this.paths(projectId).root, { recursive: true, force: true });
  }

  /**
   * 项目删除后的文件夹回收：**保留 chats/**。
   *
   * 对话先进回收站、7 天内可恢复是既有承诺，而回收站就落在 chats/.trash 里；
   * 连目录一起删掉会让「已删除项目的对话还能恢复」变成空话。
   * 因此这里只清素材、项目文件与上下文，chats 留给对话存储自己管理，
   * 并在它彻底空掉之后才把项目目录摘掉。
   */
  async removeAfterDelete(projectId: string): Promise<void> {
    const paths = this.paths(projectId);
    for (const target of [paths.media, paths.files, paths.context]) {
      await rm(target, { recursive: true, force: true });
    }
    // 剩下 chats 与项目根。这里刻意**不递归删除**：目录非空就说明回收站里还有待恢复的对话，
    // rm 会直接抛错，正好用来表达「保留」；空目录则顺利摘掉，不给用户留空壳。
    await rm(paths.chats, { recursive: false, force: false }).catch(() => undefined);
    await rm(paths.root, { recursive: false, force: false }).catch(() => undefined);
  }

  private async readContextFile(projectId: string): Promise<Record<string, unknown> | undefined> {
    try { return JSON.parse(await readFile(this.paths(projectId).context, 'utf8')) as Record<string, unknown>; }
    catch {
      // 上下文损坏不该挡住新对话创建：它只是默认值来源，退回空上下文比报错更符合预期。
      return undefined;
    }
  }

  async readContext(projectId: string): Promise<ProjectContext | undefined> {
    const id = assertProjectId(projectId);
    const raw = await this.readContextFile(id);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const scope = raw.context as ChatMaterialContext | undefined;
    return {
      projectId: id,
      ...(scope && typeof scope === 'object' && !Array.isArray(scope) && typeof scope.scope === 'string' ? { context: scope } : {}),
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(),
    };
  }

  /** 原子写入项目上下文：先写临时文件再改名，避免中途崩溃留下半个 JSON。 */
  async writeContext(projectId: string, context?: ChatMaterialContext): Promise<ProjectContext> {
    const paths = await this.ensure(projectId);
    const next: ProjectContext = { projectId: paths.projectId, ...(context ? { context } : {}), updatedAt: nowIso() };
    const temporary = `${paths.context}.tmp`;
    await writeFile(temporary, JSON.stringify(next, null, 2));
    await rename(temporary, paths.context);
    return next;
  }
/**
   * 项目文件夹占用：对话条数与磁盘占用。
   * conversations 由对话存储提供（它才知道索引怎么读），这里只负责目录与体积。
   */
  async status(projectId: string, conversations: number): Promise<ProjectWorkspaceStatus> {
    const paths = this.paths(projectId);
    const present = await this.exists(projectId);
    return { ...paths, exists: present, conversations, bytes: present ? await measure(paths.root) : 0 };
  }
}

/**
 * 把旧版扁平对话目录（单一 index.json + <sessionId>.jsonl）迁移到项目工作区。
 *
 * 迁移只做「复制」，不删除源目录：对话是用户资产，
 * 升级后残留一份可人工核对的旧文件，比迁移失败时把历史弄丢要好得多。
 */
export interface ChatLayoutMigrationResult {
  /** 已迁入真实项目工作区的会话数。 */
  migrated: number;
  /** 归属到未归属项目收容目录的会话数。 */
  unassigned: number;
  /** 源目录（保留未删除）。 */
  source: string;
  /** 目标总根目录。 */
  target: string;
  skipped: boolean;
  failures: string[];
}

/** 旧版扁平布局里一条会话的最小形状；只取迁移需要的字段。 */
export interface LegacyChatSession {
  id: string;
  projectId?: string;
  title?: string;
  messages?: unknown[];
  memory?: unknown;
}

const samePath = (left: string, right: string) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();

/**
 * 旧版扁平布局识别：源目录有 `index.json`，且尚未落过迁移完成标记。
 * 参数 `workspaceBase` 与 ProjectWorkspace.base() 同义（`<存储根>/projects`），
 * 读写标记必须用同一个基准，否则「写到了别处、读的是这里」会永远判定为未迁移。
 */
export async function detectLegacyChatLayout(chatsRoot: string, workspaceBase: string): Promise<boolean> {
  if (samePath(chatsRoot, workspaceBase)) return false;
  try { await stat(path.join(chatsRoot, 'index.json')); } catch { return false; }
  try { await stat(path.join(workspaceBase, MIGRATION_MARKER)); return false; }
  catch { return true; }
}

/**
 * 执行对话布局迁移。
 *
 * 每条会话按 projectId 落到对应项目文件夹；没有 projectId 的历史会话进入
 * `_unassigned` 收容目录，仍然可读可删，不会因为没有归属而消失。
 */
export async function migrateLegacyChatLayout(
  chatsRoot: string,
  workspace: ProjectWorkspace,
  readSessions: () => Promise<LegacyChatSession[]>,
): Promise<ChatLayoutMigrationResult> {
  const target = workspace.base();
  const result: ChatLayoutMigrationResult = { migrated: 0, unassigned: 0, source: chatsRoot, target, skipped: false, failures: [] };
  if (!await detectLegacyChatLayout(chatsRoot, target)) { result.skipped = true; return result; }
  let sessions: LegacyChatSession[];
  try { sessions = await readSessions(); }
  catch (error) {
    result.failures.push(error instanceof DesktopError ? error.message : '旧版对话索引无法读取');
    return result;
  }
  for (const session of sessions) {
    if (typeof session.id !== 'string' || !idPattern.test(session.id)) continue;
    const projectId = session.projectId && idPattern.test(session.projectId) ? session.projectId : UNASSIGNED_PROJECT_ID;
    try {
      const paths = await workspace.ensure(projectId);
      const lines = (session.messages ?? []).map(message => JSON.stringify(message)).join('\n');
      await writeFile(path.join(paths.chats, `${session.id}.jsonl`), lines ? `${lines}\n` : '');
      if (session.memory) await writeFile(path.join(paths.chats, `${session.id}.memory.json`), JSON.stringify(session.memory));
      if (projectId === UNASSIGNED_PROJECT_ID) result.unassigned++; else result.migrated++;
    } catch (error) {
      result.failures.push(`${session.id}：${error instanceof DesktopError ? error.message : '写入失败'}`);
    }
  }
  // 只在没有任何一条失败时落完成标记：有失败就保持未迁移状态，下次升级或重试仍会再搬一次。
  if (!result.failures.length) {
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, MIGRATION_MARKER), nowIso());
  }
  return result;
}