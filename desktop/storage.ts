import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, open, readFile, realpath, rename, stat, lstat, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { EngineStatus } from '../shared/protocol';
import type { StorageCleanup, StorageUsage } from '../shared/storage';
import { DesktopError } from './validation';

export interface StorageLocation { dataDir: string; credentialScopeId: string }
export interface StorageEngine {
  status: EngineStatus;
  start(): Promise<EngineStatus>; stop(): Promise<void>;
  request(command: string, payload?: Record<string, unknown>, timeout?: number): Promise<unknown>;
  log(message: unknown): void;
}
export interface StorageBackend extends StorageLocation { engine: StorageEngine }
const scopePattern = /^[A-Za-z0-9_-]{1,128}$/;
const samePath = (left: string, right: string) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
const inside = (child: string, parent: string) => path.resolve(child).toLowerCase().startsWith(path.resolve(parent).toLowerCase() + path.sep);
const transientName = (relative: string) => relative === '.backup-work'
  || relative.startsWith('.backup-work' + path.sep)
  || /^evaluation-sets[\\/]\.partial-[A-Za-z0-9_-]+(?:[\\/]|$)/.test(relative)
  || /^media[\\/][^\\/]+\.tmp$/.test(relative)
  || /^media-jobs[\\/].+[\\/](?:[^\\/]+\.tmp|frames\.partial\.jsonl)$/.test(relative);
const top = (relative: string) => relative.split(/[\\/]/, 1)[0];

export class DesktopPreferences {
  value: Record<string, unknown> = {};
  private pending: Promise<unknown> = Promise.resolve();
  constructor(readonly filename: string) {}
  async load(): Promise<Record<string, unknown>> {
    try {
      const data = JSON.parse(await readFile(this.filename, 'utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
      return this.value = data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.value = {};
      throw new DesktopError('DESKTOP_SETTINGS_DAMAGED', '桌面配置无法读取，请恢复配置；未自动切换到空数据目录');
    }
  }
  update(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    const operation = this.pending.then(async () => {
      const next = { ...this.value, ...patch };
      await mkdir(path.dirname(this.filename), { recursive: true });
      const temporary = this.filename + '.tmp';
      const file = await open(temporary, 'w');
      try { await file.writeFile(JSON.stringify(next)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, this.filename);
      return this.value = next;
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }
}

export function scopedVaultPath(userData: string, scope: string): string {
  if (!scopePattern.test(scope)) throw new DesktopError('CREDENTIAL_SCOPE_INVALID', '凭据作用域无效');
  return path.join(userData, 'credentials', 'scopes', scope + '.enc.json');
}

export async function initializeStorageLocation(userData: string, preferences: DesktopPreferences): Promise<StorageLocation> {
  const saved = preferences.value;
  const defaultDir = path.join(userData, 'data');
  if (saved.dataDir !== undefined || saved.credentialScopeId !== undefined) {
    if (typeof saved.dataDir !== 'string' || !path.isAbsolute(saved.dataDir) || typeof saved.credentialScopeId !== 'string' || !scopePattern.test(saved.credentialScopeId)) {
      throw new DesktopError('STORAGE_CONFIG_INVALID', '保存的数据目录或凭据作用域无效');
    }
    try {
      const canonical = await realpath(saved.dataDir);
      if (!(await stat(canonical)).isDirectory() || !samePath(canonical, saved.dataDir)) throw new Error();
      if (saved.dataEstablished !== false && !(await stat(path.join(canonical, 'autolabel.db'))).isFile()) throw new Error();
      if (saved.dataEstablished === false && !samePath(canonical, defaultDir)) throw new Error();
      return { dataDir: canonical, credentialScopeId: saved.credentialScopeId };
    } catch { throw new DesktopError('STORAGE_LOCATION_MISSING', '保存的数据目录失联或位置已变化，请恢复目录；未创建空数据库'); }
  }
  await mkdir(defaultDir, { recursive: true });
  const location = { dataDir: await realpath(defaultDir), credentialScopeId: randomUUID() };
  const vault = scopedVaultPath(userData, location.credentialScopeId);
  await mkdir(path.dirname(vault), { recursive: true });
  // 仅初次升级默认目录时继承旧密文；外部恢复和未知 scope 永远不查询全局文件。
  try { await copyFile(path.join(userData, 'credentials', 'providers.enc.json'), vault, constants.COPYFILE_EXCL); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let dataEstablished = false;
  try { dataEstablished = (await stat(path.join(location.dataDir, 'autolabel.db'))).isFile(); } catch { /* 初次创建的数据目录尚无数据库。 */ }
  await preferences.update({ ...location, dataEstablished });
  return location;
}

interface Preparation extends StorageLocation {
  source: StorageBackend; parent: string; backupId: unknown; createdAt: number; rebind: boolean;
}
interface StorageOptions<T extends StorageBackend> {
  active: T; create(location: StorageLocation): T;
  commit(location: StorageLocation): Promise<unknown>;
  activate(backend: T): void;
  guard(): void;
}

export class DataStorage<T extends StorageBackend> {
  active: T;
  private preparations = new Map<string, Preparation>();
  private pending?: Promise<unknown>;
  private phase = 'idle';
  private maintenanceEnded = false;
  private unresolved?: { source: T; operationId: string; error?: { code: string; message: string } };
  private reconciling?: Promise<void>;
  constructor(private options: StorageOptions<T>) { this.active = options.active; }
  get busy(): boolean { return !!this.pending || !!this.unresolved; }
  status(): Record<string, unknown> { return { busy: this.busy, phase: this.phase, dataDir: this.active.dataDir, ...(this.unresolved ? { error: this.unresolved.error } : {}) }; }
  private async collectUsage(): Promise<{ usage: StorageUsage; candidates: Array<{ path: string; bytes: number }> }> {
    const totals = { totalBytes: 0, projectBytes: 0, processBytes: 0, databaseBytes: 0, cacheBytes: 0, otherBytes: 0 };
    const candidates: Array<{ path: string; bytes: number }> = [];
    const visit = async (directory: string, relative = ''): Promise<void> => {
      let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const child = path.join(directory, entry.name), childRelative = relative ? path.join(relative, entry.name) : entry.name;
        let info; try { info = await lstat(child); } catch { continue; }
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory()) { await visit(child, childRelative); continue; }
        if (!info.isFile()) continue;
        const bytes = info.size; totals.totalBytes += bytes;
        if (transientName(childRelative)) { totals.cacheBytes += bytes; candidates.push({ path: childRelative, bytes }); continue; }
        const section = top(childRelative);
        if (section === 'media' || section === 'originals' || section === 'examples' || section === 'evaluation-sets') totals.projectBytes += bytes;
        else if (section === 'media-jobs' || section === 'exports' || section === 'backups') totals.processBytes += bytes;
        else if (/^autolabel\.db(?:-wal|-shm)?$/.test(childRelative)) totals.databaseBytes += bytes;
        else totals.otherBytes += bytes;
      }
    };
    await visit(this.active.dataDir);
    return { usage: { ...totals, cacheCandidates: candidates }, candidates };
  }
  async usage(): Promise<StorageUsage> {
    return (await this.collectUsage()).usage;
  }
  async cleanup(): Promise<StorageCleanup> {
    return this.exclusive(() => this.owned(async () => {
      const before = await this.collectUsage();
      let removedBytes = 0; const removedPaths: string[] = [];
      // 维护锁阻止引擎新写入；候选仍限制在受管临时命名，避免碰到源素材和正式结果。
      const roots = new Set(before.candidates.map(item => item.path.split(/[\\/]/, 1)[0]));
      for (const root of roots) {
        const target = path.resolve(this.active.dataDir, root);
        if (!inside(target, this.active.dataDir) && !path.resolve(target).toLowerCase().startsWith(path.resolve(this.active.dataDir).toLowerCase() + path.sep)) continue;
        let info; try { info = await lstat(target); } catch { continue; }
        if (info.isSymbolicLink()) continue;
        // .backup-work 和未提交评测目录按整棵临时树移除，其余只删除明确临时文件。
        if (root === '.backup-work' || root === 'evaluation-sets') {
          if (root === 'evaluation-sets') {
            let entries; try { entries = await readdir(target, { withFileTypes: true }); } catch { continue; }
            for (const entry of entries) if (entry.name.startsWith('.partial-') && entry.isDirectory()) {
              const relative = path.join(root, entry.name); const item = before.candidates.find(candidate => candidate.path === relative || candidate.path.startsWith(relative + path.sep));
              if (item) { const candidatePath = path.resolve(this.active.dataDir, relative); let size = 0; try { size = (await this.collectPathBytes(candidatePath)); } catch { continue; } await rm(candidatePath, { recursive: true, force: true }); removedBytes += size; removedPaths.push(relative); }
            }
          } else {
            const size = await this.collectPathBytes(target); await rm(target, { recursive: true, force: true }); removedBytes += size; removedPaths.push(root);
          }
        }
      }
      for (const candidate of before.candidates) {
        if (candidate.path === '.backup-work' || candidate.path.startsWith('.backup-work' + path.sep) || candidate.path.startsWith('evaluation-sets' + path.sep)) continue;
        const target = path.resolve(this.active.dataDir, candidate.path); try { const info = await lstat(target); if (info.isFile() && !info.isSymbolicLink()) { await rm(target, { force: true }); removedBytes += candidate.bytes; removedPaths.push(candidate.path); } } catch { /* 并发删除或残留文件不可访问时保留诊断结果。 */ }
      }
      const after = await this.usage(); return { ...after, removedBytes, removedPaths };
    }));
  }
  private async collectPathBytes(target: string): Promise<number> {
    let info; try { info = await lstat(target); } catch { return 0; }
    if (info.isSymbolicLink()) return 0;
    if (info.isFile()) return info.size;
    if (!info.isDirectory()) return 0;
    let total = 0; let entries; try { entries = await readdir(target, { withFileTypes: true }); } catch { return 0; }
    for (const entry of entries) total += await this.collectPathBytes(path.join(target, entry.name));
    return total;
  }
  async whenIdle(timeoutMs = 30000): Promise<void> {
    await this.pending?.catch(() => undefined);
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (this.unresolved) {
      await this.reconcile();
      if (!this.unresolved || Date.now() >= deadline) return;
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, Math.max(1, deadline - Date.now()))));
    }
  }
  async reconcile(): Promise<void> {
    if (this.reconciling) return this.reconciling;
    this.reconciling = this.releaseOwner().finally(() => { this.reconciling = undefined; });
    return this.reconciling;
  }
  private async releaseOwner(): Promise<void> {
    const lease = this.unresolved; if (!lease) return;
    try {
      if (lease.source.engine.status.state === 'stopped') { this.unresolved = undefined; return; }
      const released = await lease.source.engine.request('system.cancelDataMaintenance', { operationId: lease.operationId }, 10000) as Record<string, unknown>;
      if (released.released !== true || released.locked !== false) throw new DesktopError('STORAGE_LOCK_INVALID', '维护锁释放结果无法确认');
      this.unresolved = undefined;
    } catch (error) {
      // 只认同 owner 的取消终态，瞬时无锁不能排除迟到的 prepare 请求。
      lease.error = { code: error instanceof DesktopError ? error.code : 'STORAGE_MAINTENANCE_UNCERTAIN',
        message: error instanceof DesktopError ? error.message : '数据维护状态待确认，暂不能开始其他操作' };
    } finally { this.phase = this.unresolved ? 'maintenance-uncertain' : this.pending ? this.phase : 'idle'; }
  }

  private exclusive<R>(action: () => Promise<R>): Promise<R> {
    if (this.busy) throw new DesktopError('STORAGE_BUSY', '数据维护正在进行，请等待完成');
    this.options.guard();
    const pending = Promise.resolve().then(action).finally(() => { this.pending = undefined; this.phase = this.unresolved ? 'maintenance-uncertain' : 'idle'; });
    this.pending = pending;
    return pending;
  }
  private async owned<R>(action: (operationId: string) => Promise<R>): Promise<R> {
    const source = this.active; const operationId = randomUUID(); let attempted = false; let originalError: unknown;
    this.phase = 'waiting'; this.maintenanceEnded = false;
    try {
      const deadline = Date.now() + 30000;
      while (true) {
        attempted = true;
        const state = await source.engine.request('system.prepareDataMaintenance', { operationId }, 10000) as Record<string, unknown>;
        if (state.mode !== 'data' || state.operationId !== operationId || state.locked !== true || state.dispatchPaused !== true) throw new DesktopError('STORAGE_LOCK_INVALID', '数据维护锁响应无效');
        if (state.ready === true) break;
        if (Date.now() >= deadline) throw new DesktopError('STORAGE_TASKS_ACTIVE', '真实在途操作尚未结束，请稍后重试数据维护');
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      return await action(operationId);
    } catch (error) { originalError = error; throw error;
    } finally {
      if (attempted && !this.maintenanceEnded) {
        this.unresolved = { source, operationId };
        await this.reconcile();
        if (this.unresolved && !originalError) throw new DesktopError('STORAGE_MAINTENANCE_UNCERTAIN', '数据操作已返回，但维护锁尚未确认释放，请等待状态恢复');
      }
    }
  }
  private async parentDirectory(value: string): Promise<string> {
    const directory = await realpath(value);
    if (!(await stat(directory)).isDirectory() || samePath(directory, this.active.dataDir) || inside(directory, this.active.dataDir)) {
      throw new DesktopError('STORAGE_TARGET_INVALID', '目标文件夹不能位于当前数据目录内');
    }
    return directory;
  }
  private async recordPrepared(result: unknown, parent: string, rebind: boolean): Promise<string> {
    const item = result as Record<string, unknown>;
    if (!item || typeof item.dataDir !== 'string' || !path.isAbsolute(item.dataDir) || typeof item.backupId !== 'string') throw new DesktopError('STORAGE_PREPARATION_INVALID', '恢复准备未返回有效目录');
    const dataDir = await realpath(item.dataDir);
    if (!samePath(await realpath(parent), parent) || !samePath(dataDir, item.dataDir) || !inside(dataDir, parent)
      || samePath(dataDir, this.active.dataDir) || inside(dataDir, this.active.dataDir) || inside(this.active.dataDir, dataDir)
      || !(await stat(path.join(dataDir, 'autolabel.db'))).isFile()) throw new DesktopError('STORAGE_PREPARATION_INVALID', '恢复目录不在所选位置或缺少数据库');
    const preparationId = randomUUID();
    this.preparations.set(preparationId, { dataDir, parent, backupId: item.backupId, source: this.active,
      credentialScopeId: rebind ? randomUUID() : this.active.credentialScopeId, createdAt: Date.now(), rebind });
    return preparationId;
  }
  /**
   * 供项目删除等需要独占数据目录的操作复用同一套维护锁与在途任务检查。
   * 动作必须拿到本次维护锁的 operationId：引擎只接受携带当前锁归属的破坏性动作。
   */
  withMaintenance<R>(action: (operationId: string) => Promise<R>): Promise<R> {
    return this.exclusive(() => this.owned(operationId => action(operationId)));
  }
  async createBackup(outputDir: string): Promise<unknown> {
    return this.exclusive(() => this.owned(async operationId => {
      const directory = await this.parentDirectory(outputDir); this.phase = 'backing-up';
      return this.active.engine.request('backup.create', { outputDir: directory, operationId });
    }));
  }
  async prepareRestore(backupPath: string, targetParent: string): Promise<Record<string, unknown>> {
    return this.exclusive(() => this.owned(async operationId => {
      const parent = await this.parentDirectory(targetParent); this.phase = 'preparing';
      const result = await this.active.engine.request('restore.prepare', { backupPath, targetParent: parent, operationId });
      const preparationId = await this.recordPrepared(result, parent, true);
      return { preparationId, backupId: this.preparations.get(preparationId)!.backupId, credentialRebindRequired: true };
    }));
  }
  async activate(preparationId: string): Promise<Record<string, unknown>> {
    return this.exclusive(() => this.owned(() => this.switchPrepared(preparationId)));
  }
  async migrate(targetParent: string): Promise<Record<string, unknown>> {
    return this.exclusive(() => this.owned(async operationId => {
      const parent = await this.parentDirectory(targetParent); this.phase = 'backing-up';
      const backup = await this.active.engine.request('backup.create', { outputDir: parent, operationId }) as { backupPath: string };
      if (typeof backup.backupPath !== 'string' || !inside(await realpath(backup.backupPath), parent)) throw new DesktopError('STORAGE_BACKUP_INVALID', '本地迁移备份未写入所选目录');
      this.phase = 'preparing';
      const result = await this.active.engine.request('restore.prepare', { backupPath: backup.backupPath, targetParent: parent, operationId });
      return this.switchPrepared(await this.recordPrepared(result, parent, false));
    }));
  }
  private async switchPrepared(preparationId: string): Promise<Record<string, unknown>> {
    const prepared = this.preparations.get(preparationId); this.preparations.delete(preparationId);
    if (!prepared || prepared.source !== this.active || Date.now() - prepared.createdAt > 30 * 60000) throw new DesktopError('STORAGE_PREPARATION_EXPIRED', '恢复准备已失效，请重新准备');
    if (!samePath(await realpath(prepared.dataDir), prepared.dataDir) || !samePath(await realpath(prepared.parent), prepared.parent)
      || !(await stat(path.join(prepared.dataDir, 'autolabel.db'))).isFile()) throw new DesktopError('STORAGE_PREPARATION_INVALID', '准备目录已变化，不能切换');
    const previous = this.active; let candidate: T | undefined; let oldStopped = false; let committed = false;
    try {
      this.phase = 'stopping'; await previous.engine.stop(); oldStopped = true; this.maintenanceEnded = true;
      candidate = this.options.create({ dataDir: prepared.dataDir, credentialScopeId: prepared.credentialScopeId });
      this.phase = 'verifying';
      if ((await candidate.engine.start()).state !== 'ready') throw new DesktopError('STORAGE_CANDIDATE_FAILED', '恢复目录的引擎未能启动');
      const projects = await candidate.engine.request('project.list');
      if (!Array.isArray(projects)) throw new DesktopError('STORAGE_CANDIDATE_FAILED', '恢复目录的项目列表无法读取');
      if (projects.length) await candidate.engine.request('project.open', { projectId: projects[0].id });
      this.phase = 'committing';
      await this.options.commit({ dataDir: prepared.dataDir, credentialScopeId: prepared.credentialScopeId });
      committed = true; this.active = candidate;
      this.options.activate(candidate);
      this.preparations.clear();
      return { activated: true, dataDir: prepared.dataDir, credentialRebindRequired: prepared.rebind, previousDataRetained: true };
    } catch (error) {
      // 配置提交之后不回滚磁盘指向；界面刷新失败也不能造成两套活动身份。
      if (!committed && oldStopped) {
        this.phase = 'rolling-back';
        if (candidate) await candidate.engine.stop();
        if ((await previous.engine.start()).state !== 'ready') throw new DesktopError('STORAGE_ROLLBACK_FAILED', '旧目录仍被保留，但引擎未能重启，请查看诊断');
      }
      throw error;
    }
  }
}
