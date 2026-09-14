import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  StoragePathCandidate, StoragePathEntry, StoragePathKind, StoragePathMigrationPlan, StoragePathMigrationResult,
  StoragePathProbe, StoragePathSource, StoragePathsState,
} from '../shared/storage';
import type { DesktopPreferences } from './storage';
import { DesktopError } from './validation';

/** 落盘键名与 kind 的固定映射；设置页与主进程共用一份，避免出现两套命名。 */
export const PATH_SETTING_KEYS = { root: 'storageRoot', datasets: 'datasetsRoot', uploads: 'uploadsRoot', chats: 'chatsRoot' } as const;
export type PathSlot = keyof typeof PATH_SETTING_KEYS;
export const PATH_KINDS: StoragePathKind[] = ['datasets', 'uploads', 'chats'];
export const PATH_LABELS: Record<StoragePathKind, string> = {
  datasets: '划分好的训练集', uploads: '用户上传的训练集', chats: '对话记录',
};
export const ROOT_SUBDIRECTORY = 'AutoLabelData';
/** 上一次生效路径的快照，用于「迁移已有数据」；不参与默认值判定。 */
export const PREVIOUS_PATHS_KEY = 'storagePathsPrevious';

const samePath = (left: string, right: string) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
/** 相同或互为父子；用于目录互斥校验。 */
const overlaps = (left: string, right: string) => {
  const a = path.resolve(left).toLowerCase(), b = path.resolve(right).toLowerCase();
  return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
};

function assertUsablePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new DesktopError('STORAGE_PATH_INVALID', `${label}不能为空`);
  if (value.includes('\0') || !path.isAbsolute(value)) throw new DesktopError('STORAGE_PATH_NOT_ABSOLUTE', `${label}必须使用绝对路径`);
  const resolved = path.resolve(value);
  if (path.parse(resolved).root === resolved) throw new DesktopError('STORAGE_PATH_IS_ROOT', `${label}不能使用磁盘根目录`);
  return resolved;
}

/** 建目录并做真实写入探测；不复用「目录存在即视为可写」的乐观判断。 */
async function ensureWritable(directory: string, label: string): Promise<void> {
  let info;
  try { info = await stat(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new DesktopError('STORAGE_PATH_UNAVAILABLE', `${label}无法访问，请检查路径与权限`);
    try { await mkdir(directory, { recursive: true }); }
    catch { throw new DesktopError('STORAGE_PATH_UNAVAILABLE', `${label}无法创建，请检查路径与权限`); }
    info = await stat(directory);
  }
  if (!info.isDirectory()) throw new DesktopError('STORAGE_PATH_NOT_DIRECTORY', `${label}已存在且不是文件夹`);
  const marker = path.join(directory, `.autolabel-write-${randomUUID()}.tmp`);
  try { await writeFile(marker, 'autolabel'); }
  catch { throw new DesktopError('STORAGE_PATH_NOT_WRITABLE', `${label}不可写，请改选其他位置`); }
  finally { await rm(marker, { force: true }); }
}

/** 安装目录不可写时的受管回退位置，与数据库目录分离但仍属当前 Windows 用户。 */
export function userFallbackRoot(): string {
  const base = process.env.LOCALAPPDATA || process.env.APPDATA || path.join(os.homedir(), '.autolabel');
  return path.join(base, '自动标注小助手', ROOT_SUBDIRECTORY);
}

export function defaultRootFor(installDirectory: string): string {
  return path.join(installDirectory, ROOT_SUBDIRECTORY);
}

interface Probed { path: string; source: StoragePathSource; reason?: string }

/** 探测首选目录；不可用时回退到受管位置并把原因带回，不静默接受失败路径。 */
async function probeWithFallback(primary: string, fallback: string, label: string, sourceOnSuccess: StoragePathSource): Promise<Probed> {
  try { await ensureWritable(primary, label); return { path: primary, source: sourceOnSuccess }; }
  catch (error) {
    if (samePath(primary, fallback)) throw error;
    await ensureWritable(fallback, label);
    const detail = error instanceof DesktopError ? error.message : `${label}不可用`;
    return { path: fallback, source: 'fallback', reason: `${detail}，已回退到当前用户目录` };
  }
}

export interface ResolvedPaths extends StoragePathsState { entries: StoragePathEntry[] }

/**
 * 解析三类数据的实际生效路径并创建目录。
 * 自定义路径校验失败或运行中变得不可写时回退到受管位置，并把原因带回界面，不静默降级。
 */
export async function resolveStoragePaths(preferences: DesktopPreferences, installDirectory: string, dataDirectory: string): Promise<ResolvedPaths> {
  const saved = preferences.value;
  const defaultRoot = defaultRootFor(installDirectory);
  const fallbackRoot = userFallbackRoot();
  const savedValue = (slot: PathSlot) => {
    const value = saved[PATH_SETTING_KEYS[slot]];
    return typeof value === 'string' && value.trim() ? path.resolve(value) : undefined;
  };
  const savedRoot = savedValue('root');
  const rootDecision = savedRoot
    ? await probeWithFallback(savedRoot, fallbackRoot, '存储根目录', 'custom')
    : await probeWithFallback(defaultRoot, fallbackRoot, '存储根目录', 'default');
  const entries: StoragePathEntry[] = [];
  for (const kind of PATH_KINDS) {
    const label = PATH_LABELS[kind];
    const savedKind = savedValue(kind);
    const managed = path.join(rootDecision.path, kind);
    const decision = savedKind
      ? await probeWithFallback(savedKind, path.join(fallbackRoot, kind), label, 'custom')
      : await probeWithFallback(managed, path.join(fallbackRoot, kind), label, 'default');
    entries.push({
      kind, label, path: decision.path, custom: decision.source === 'custom', source: decision.source,
      ...(decision.reason ? { reason: decision.reason } : {}), bytes: 0, files: 0,
    });
  }
  return {
    installDirectory, defaultRoot, fallbackRoot, root: rootDecision.path, rootSource: rootDecision.source,
    ...(rootDecision.reason ? { rootReason: rootDecision.reason } : {}), dataDirectory, entries, writable: true,
  };
}

async function measure(directory: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0, files = 0;
  const visit = async (current: string) => {
    let items; try { items = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      const child = path.join(current, item.name);
      let info; try { info = await lstat(child); } catch { continue; }
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) { await visit(child); continue; }
      if (info.isFile()) { bytes += info.size; files++; }
    }
  };
  await visit(directory);
  return { bytes, files };
}

export function storagePathsState(paths: ResolvedPaths): StoragePathsState {
  return {
    installDirectory: paths.installDirectory, defaultRoot: paths.defaultRoot, fallbackRoot: paths.fallbackRoot,
    root: paths.root, rootSource: paths.rootSource, ...(paths.rootReason ? { rootReason: paths.rootReason } : {}),
    dataDirectory: paths.dataDirectory, entries: paths.entries.map(entry => ({ ...entry })), writable: paths.writable,
  };
}

export async function storagePathsWithUsage(paths: ResolvedPaths): Promise<StoragePathsState> {
  const entries: StoragePathEntry[] = [];
  for (const entry of paths.entries) entries.push({ ...entry, ...await measure(entry.path) });
  return { ...storagePathsState(paths), entries };
}

/** 保存前校验：三类有效目录不得相同或互相嵌套，也不得落在数据库目录内部。 */
function validateSet(kinds: Record<StoragePathKind, string>, dataDirectory: string): void {
  for (const [left, right] of [['datasets', 'uploads'], ['datasets', 'chats'], ['uploads', 'chats']] as Array<[StoragePathKind, StoragePathKind]>) {
    if (overlaps(kinds[left], kinds[right])) throw new DesktopError('STORAGE_PATH_OVERLAP', `${PATH_LABELS[left]}与${PATH_LABELS[right]}的目录不能相同或相互嵌套`);
  }
  const base = path.resolve(dataDirectory).toLowerCase();
  for (const kind of PATH_KINDS) {
    const target = path.resolve(kinds[kind]).toLowerCase();
    if (target === base || target.startsWith(base + path.sep)) throw new DesktopError('STORAGE_PATH_INSIDE_DATA', `${PATH_LABELS[kind]}不能位于当前数据目录内`);
  }
}

export interface StoragePathUpdate {
  storageRoot?: string | null;
  datasetsRoot?: string | null;
  uploadsRoot?: string | null;
  chatsRoot?: string | null;
}

/**
 * 保存自定义路径。留空或显式 null 表示跟随存储根；目标已有内容时沿用不清空。
 * 校验与建目录全部成功后才写入配置，失败不留下半套设置。
 */
export class StoragePathSettings {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    private preferences: DesktopPreferences,
    private installDirectory: () => string,
    private dataDirectory: () => string,
  ) {}

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation);
    this.pending = next.catch(() => undefined);
    return next;
  }

  current(): Promise<ResolvedPaths> {
    return this.serial(() => resolveStoragePaths(this.preferences, this.installDirectory(), this.dataDirectory()));
  }

  status(): Promise<StoragePathsState> {
    return this.serial(async () => storagePathsWithUsage(await resolveStoragePaths(this.preferences, this.installDirectory(), this.dataDirectory())));
  }

  probe(target: unknown): Promise<StoragePathProbe> {
    return this.serial(async () => {
      let resolved: string;
      try { resolved = assertUsablePath(target, '目标目录'); }
      catch (error) {
        return { path: typeof target === 'string' ? target : '', absolute: false, exists: false, created: false, writable: false,
          reason: error instanceof DesktopError ? error.message : '路径无效' };
      }
      let exists = false;
      try { exists = (await stat(resolved)).isDirectory(); } catch { exists = false; }
      try { await ensureWritable(resolved, '目标目录'); return { path: resolved, absolute: true, exists, created: !exists, writable: true }; }
      catch (error) { return { path: resolved, absolute: true, exists, created: false, writable: false,
        reason: error instanceof DesktopError ? error.message : '目标目录不可写' }; }
    });
  }

  save(update: StoragePathUpdate): Promise<StoragePathsState> {
    return this.serial(async () => {
      const before = await resolveStoragePaths(this.preferences, this.installDirectory(), this.dataDirectory());
      if (this.preferences.value[PREVIOUS_PATHS_KEY] === undefined) {
        // 首次保存前记录当前生效位置，使「迁移已有数据」可以找到旧目录。
        await this.preferences.update({ [PREVIOUS_PATHS_KEY]: { root: before.root, entries: before.entries.map(entry => ({ kind: entry.kind, path: entry.path })) } });
      }
      const patch: Record<string, unknown> = {};
      const savedValue = (slot: PathSlot) => {
        const value = this.preferences.value[PATH_SETTING_KEYS[slot]];
        return typeof value === 'string' && value.trim() ? path.resolve(value) : undefined;
      };
      const rootOnly = update.storageRoot !== undefined && PATH_KINDS.every(kind => update[`${kind}Root` as keyof StoragePathUpdate] === undefined);
      // 只调整存储根时，未单独覆盖的三类目录跟随新根移动；单独提交过的目录保持原设置。
      const root = update.storageRoot === undefined ? before.root
        : update.storageRoot === null ? defaultRootFor(this.installDirectory()) : assertUsablePath(update.storageRoot, '存储根目录');
      if (update.storageRoot !== undefined) patch[PATH_SETTING_KEYS.root] = update.storageRoot === null ? null : root;
      const kinds = {} as Record<StoragePathKind, string>;
      for (const kind of PATH_KINDS) {
        const submitted = update[`${kind}Root` as keyof StoragePathUpdate];
        if (submitted === undefined) {
          const followRoot = rootOnly && savedValue(kind) === undefined;
          kinds[kind] = followRoot ? path.join(root, kind) : before.entries.find(entry => entry.kind === kind)!.path;
          if (followRoot) patch[PATH_SETTING_KEYS[kind]] = null;
          continue;
        }
        if (submitted === null || submitted === '') { patch[PATH_SETTING_KEYS[kind]] = null; kinds[kind] = path.join(root, kind); continue; }
        kinds[kind] = assertUsablePath(submitted, PATH_LABELS[kind]); patch[PATH_SETTING_KEYS[kind]] = kinds[kind];
      }
      validateSet(kinds, this.dataDirectory());
      await ensureWritable(root, '存储根目录');
      for (const kind of PATH_KINDS) await ensureWritable(kinds[kind], PATH_LABELS[kind]);
      await this.preferences.update(patch);
      return storagePathsWithUsage(await resolveStoragePaths(this.preferences, this.installDirectory(), this.dataDirectory()));
    });
  }

  /** 列出可迁移项：上一次生效且与当前不同的目录，且源目录真实存在。 */
  migration(): Promise<StoragePathMigrationPlan> {
    return this.serial(async () => {
      const previous = this.preferences.value[PREVIOUS_PATHS_KEY] as { entries?: Array<{ kind: StoragePathKind; path: string }> } | undefined;
      const current = await resolveStoragePaths(this.preferences, this.installDirectory(), this.dataDirectory());
      const candidates: StoragePathCandidate[] = [];
      for (const entry of current.entries) {
        const source = previous?.entries?.find(item => item.kind === entry.kind)?.path;
        if (!source || samePath(source, entry.path)) continue;
        let info; try { info = await stat(source); } catch { continue; }
        if (!info.isDirectory()) continue;
        const size = await measure(source);
        if (!size.files) continue;
        candidates.push({ kind: entry.kind, label: entry.label, from: source, to: entry.path, files: size.files, bytes: size.bytes });
      }
      return { candidates };
    });
  }

  /** 迁移只复制、不删除源目录；逐文件核对大小，某个目录失败时回滚该目录本次已复制的文件。 */
  migrate(): Promise<StoragePathMigrationResult> {
    return this.serial(async () => {
      const plan = await this.migration();
      const result: StoragePathMigrationResult = { copiedFiles: 0, copiedBytes: 0, skipped: 0, failures: [], sourcesRetained: true };
      for (const candidate of plan.candidates) {
        const copied: Array<{ path: string; bytes: number }> = [];
        const rollback = async () => {
          for (const file of copied) { try { await rm(file.path, { force: true }); } catch { /* 回滚失败时保留文件，源目录始终保留。 */ } }
          result.copiedFiles -= copied.length;
          result.copiedBytes -= copied.reduce((sum, file) => sum + file.bytes, 0);
          copied.length = 0;
        };
        try {
          const walk = async (directory: string, relative: string): Promise<void> => {
            for (const item of await readdir(directory, { withFileTypes: true })) {
              const source = path.join(directory, item.name), target = path.join(candidate.to, relative, item.name);
              if (item.isDirectory()) { await mkdir(target, { recursive: true }); await walk(source, path.join(relative, item.name)); continue; }
              if (!item.isFile()) continue;
              const origin = await stat(source);
              let existing; try { existing = await stat(target); } catch { existing = undefined; }
              if (existing && existing.size === origin.size) { result.skipped++; continue; }
              await mkdir(path.dirname(target), { recursive: true });
              await copyFile(source, target);
              const after = await stat(target);
              if (after.size !== origin.size) throw new DesktopError('STORAGE_MIGRATION_VERIFY_FAILED', `${path.basename(source)} 复制后大小不一致`);
              copied.push({ path: target, bytes: after.size }); result.copiedFiles++; result.copiedBytes += after.size;
            }
          };
          await walk(candidate.from, '');
        } catch (error) {
          await rollback();
          result.failures.push({ kind: candidate.kind, path: candidate.from, message: error instanceof DesktopError ? error.message : '迁移未完成，已保留源目录' });
        }
      }
      return result;
    });
  }
}
