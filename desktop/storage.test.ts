import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStorage, DesktopPreferences, initializeStorageLocation, scopedVaultPath, type StorageLocation, type StorageEngine } from './storage';
import { CredentialVault } from './vault';
import { EngineManager, waitForEngineExit } from './engine';
import { DesktopError, validateCommand, assertAgentCommand } from './validation';
import { PathGrants, authorizeCommandPaths } from './security';
import { mediaTargetFromUrl } from './security';
import type { EngineStatus } from '../shared/protocol';

class FixtureEngine implements StorageEngine {
  status: EngineStatus = { state: 'ready' };
  owner?: string;
  cancelled = new Set<string>();
  stopFailure = false; startFailure = false; readFailure = false;
  maintenanceFailure = false;
  cancelFailure = false;
  starts = 0; stops = 0;
  constructor(readonly directory: string) {}
  log(): void {}
  async start(): Promise<EngineStatus> { this.starts++; this.status = { state: this.startFailure ? 'error' : 'ready' }; return this.status; }
  async stop(): Promise<void> { this.stops++; if (this.stopFailure) throw new DesktopError('ENGINE_STOP_TIMEOUT', '夹具进程尚未退出'); this.status = { state: 'stopped' }; this.owner = undefined; }
  async request(command: string, payload: Record<string, unknown> = {}): Promise<any> {
    if (command === 'system.prepareDataMaintenance') {
      if (this.maintenanceFailure) throw new DesktopError('MAINTENANCE_UNAVAILABLE', '维护锁暂不可用');
      if (this.cancelled.has(payload.operationId as string)) throw new DesktopError('maintenance_operation_cancelled', '操作已取消');
      if (this.owner && this.owner !== payload.operationId) throw new Error('owner_conflict');
      this.owner = payload.operationId as string;
      return { mode: 'data', operationId: this.owner, locked: true, ready: true, dispatchPaused: true };
    }
    if (command === 'system.cancelDataMaintenance') {
      if (this.cancelFailure) throw new DesktopError('MAINTENANCE_RELEASE_UNAVAILABLE', '维护锁释放暂不可用');
      if (this.owner && this.owner !== payload.operationId) throw new Error('owner_conflict');
      this.cancelled.add(payload.operationId as string);
      this.owner = undefined; return { released: true, locked: false };
    }
    if (command.startsWith('backup.') || command === 'restore.prepare') {
      if (!this.owner || this.owner !== payload.operationId) throw new Error('owner_conflict');
      if (command === 'backup.create') {
        const backupPath = path.join(payload.outputDir as string, randomUUID() + '.autolabel'); await writeFile(backupPath, '隔离备份夹具');
        return { backupPath, backupId: 'backup-1' };
      }
      const dataDir = path.join(payload.targetParent as string, 'restored-' + randomUUID());
      await mkdir(dataDir); await writeFile(path.join(dataDir, 'autolabel.db'), '隔离数据库夹具');
      return { dataDir, backupId: 'backup-1', credentialRebindRequired: true };
    }
    if (command === 'project.list') return [{ id: 'project-1' }];
    if (command === 'project.open') { if (this.readFailure) throw new Error('项目读取失败'); return { id: 'project-1' }; }
    throw new Error('夹具未开放命令');
  }
}

async function fixture(options: { startFailure?: boolean; readFailure?: boolean; commitFailure?: boolean; stopFailure?: boolean; callbackFailure?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autolabel-storage-'));
  const current = path.join(root, 'current'); const target = path.join(root, 'target');
  await mkdir(current); await mkdir(target); await writeFile(path.join(current, 'autolabel.db'), '原数据库');
  const original = { dataDir: current, credentialScopeId: 'original-scope', engine: new FixtureEngine(current) };
  original.engine.stopFailure = !!options.stopFailure;
  let committed: StorageLocation = { dataDir: current, credentialScopeId: 'original-scope' };
  const created: FixtureEngine[] = [];
  const storage = new DataStorage({ active: original,
    create: location => { const engine = new FixtureEngine(location.dataDir); engine.startFailure = !!options.startFailure; engine.readFailure = !!options.readFailure; created.push(engine); return { ...location, engine }; },
    commit: async location => { if (options.commitFailure) throw new Error('配置提交失败'); committed = location; },
    activate: () => { if (options.callbackFailure) throw new Error('界面刷新失败'); }, guard: () => {},
  });
  return { root, current, target, original, storage, created, committed: () => committed,
    close: async () => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'autolabel-storage-')); await rm(root, { recursive: true, force: true }); } };
}

test('外部恢复建立新凭据作用域，一次性激活保留旧目录', async () => {
  const f = await fixture();
  try {
    const prepared = await f.storage.prepareRestore(path.join(f.root, 'selected.autolabel'), f.target);
    assert.equal(Object.hasOwn(prepared, 'dataDir'), false); assert.equal(f.original.engine.owner, undefined);
    const result = await f.storage.activate(prepared.preparationId as string);
    assert.equal(result.activated, true); assert.equal(result.credentialRebindRequired, true);
    assert.notEqual(f.committed().credentialScopeId, 'original-scope'); assert.notEqual(f.committed().dataDir, f.current);
    assert.equal(f.original.engine.status.state, 'stopped'); assert.equal((await stat(f.current)).isDirectory(), true);
    await assert.rejects(f.storage.activate(prepared.preparationId as string), /已失效/);
  } finally { await f.close(); }
});
test('本地迁移持有同一维护锁，继承当前 scope 并保留原数据', async () => {
  const f = await fixture();
  try {
    const result = await f.storage.migrate(f.target);
    assert.equal(result.credentialRebindRequired, false); assert.equal(f.committed().credentialScopeId, 'original-scope');
    assert.equal(f.original.engine.stops, 1); assert.equal(await readFile(path.join(f.current, 'autolabel.db'), 'utf8'), '原数据库');
  } finally { await f.close(); }
});
test('候选启动、项目读取和配置提交失败回旧目录；未确认退出不启动候选', async () => {
  for (const options of [{ startFailure: true }, { readFailure: true }, { commitFailure: true }, { stopFailure: true }]) {
    const f = await fixture(options);
    try {
      const prepared = await f.storage.prepareRestore('selected.autolabel', f.target);
      await assert.rejects(f.storage.activate(prepared.preparationId as string));
      assert.equal(f.committed().dataDir, f.current); assert.equal(f.storage.active, f.original);
      assert.equal(f.original.engine.status.state, 'ready');
      if (options.stopFailure) assert.equal(f.created.length, 0);
      else { assert.equal(f.original.engine.starts, 1); assert.equal(f.created[0].status.state, 'stopped'); }
    } finally { await f.close(); }
  }
});
test('配置已提交后界面回调失败仍保持新活动目录', async () => {
  const f = await fixture({ callbackFailure: true });
  try {
    const prepared = await f.storage.prepareRestore('selected.autolabel', f.target);
    await assert.rejects(f.storage.activate(prepared.preparationId as string), /界面刷新失败/);
    assert.equal(f.storage.active.dataDir, f.committed().dataDir); assert.notEqual(f.committed().dataDir, f.current);
    assert.equal(f.original.engine.starts, 0); assert.equal(f.created[0].status.state, 'ready');
  } finally { await f.close(); }
});
test('维护 prepare 回包丢失仍取消原 owner，长动作未收敛时保持忙碌', async () => {
  const f = await fixture();
  const originalRequest = f.original.engine.request.bind(f.original.engine);
  try {
    let first = true;
    f.original.engine.request = async (command, payload = {}) => {
      const result = await originalRequest(command, payload);
      if (command === 'system.prepareDataMaintenance' && first) { first = false; throw new DesktopError('ENGINE_TIMEOUT', 'prepare 回包超时'); }
      return result;
    };
    await assert.rejects(f.storage.createBackup(f.target), /prepare 回包超时/);
    assert.equal(f.original.engine.owner, undefined); assert.equal(f.storage.busy, false);
    let actionRunning = true;
    f.original.engine.request = async (command, payload = {}) => {
      if (command === 'backup.create') throw new DesktopError('ENGINE_TIMEOUT', '长备份请求超时');
      if (command === 'system.cancelDataMaintenance' && actionRunning) throw new DesktopError('maintenance_operation_busy', '维护动作仍在运行');
      return originalRequest(command, payload);
    };
    await assert.rejects(f.storage.createBackup(f.target), /长备份请求超时/);
    assert.equal(f.storage.busy, true); assert.equal(f.storage.status().phase, 'maintenance-uncertain');
    await assert.rejects(f.storage.createBackup(f.target), /正在进行/);
    const owner = f.original.engine.owner;
    actionRunning = false; await f.storage.reconcile();
    assert.equal(f.storage.busy, false); assert.equal(f.original.engine.owner, undefined);
    await assert.rejects(originalRequest('system.prepareDataMaintenance', { operationId: owner }), /操作已取消/);
  } finally { await f.close(); }
});
test('准备目录被重定向后拒绝激活，renderer 不能传 scope 或锁 owner', async () => {
  const f = await fixture();
  try {
    const prepared = await f.storage.prepareRestore('selected.autolabel', f.target);
    const entry = [...(f.storage as any).preparations.values()][0];
    const candidate = path.resolve(entry.dataDir); assert.ok(candidate.startsWith(path.resolve(f.target) + path.sep));
    await rm(candidate, { recursive: true }); await symlink(f.current, candidate, 'junction');
    await assert.rejects(f.storage.activate(prepared.preparationId as string), /准备目录已变化/); assert.equal(f.original.engine.stops, 0);
    for (const payload of [{ preparationId: 'p', dataDir: f.current }, { preparationId: 'p', credentialScopeId: 'original-scope' }]) assert.throws(() => validateCommand('storage.activate', payload));
    assert.throws(() => validateCommand('backup.create', { outputDir: f.target, operationId: 'forged' }));
    assert.throws(() => validateCommand('system.prepareDataMaintenance', { operationId: 'forged' }));
    for (const command of ['backup.create', 'restore.prepare', 'storage.activate', 'storage.migrate']) assert.throws(() => assertAgentCommand(command));
    const grants = new PathGrants();
    await assert.rejects(authorizeCommandPaths('restore.prepare', { backupPath: f.current, targetParent: f.target }, grants));
    await grants.add(f.target, 'directory');
    assert.equal((await authorizeCommandPaths('storage.migrate', { targetParent: f.target }, grants)), undefined);
  } finally { await f.close(); }
});
test('凭据只读当前 scope，单条损坏不影响其他接口，旧全局凭据仅迁入一次', async () => {
  const f = await fixture();
  const protection = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from('encrypted:' + value),
    decryptString: (value: Buffer) => { const text = value.toString(); if (!text.startsWith('encrypted:')) throw new Error(); return text.slice(10); } };
  try {
    const legacy = new CredentialVault(path.join(f.root, 'credentials', 'providers.enc.json'), protection);
    await legacy.set('same-provider', 'scope-one-key');
    const preferences = new DesktopPreferences(path.join(f.root, 'desktop-settings.json')); await preferences.load();
    const location = await initializeStorageLocation(f.root, preferences);
    const scoped = new CredentialVault(scopedVaultPath(f.root, location.credentialScopeId), protection);
    assert.equal((await scoped.all())[0].key, 'scope-one-key');
    const foreign = new CredentialVault(scopedVaultPath(f.root, 'external-restore'), protection);
    assert.deepEqual(await foreign.providerIds(), []);
    await scoped.set('other-provider', 'still-valid');
    assert.deepEqual(await scoped.remove('other-provider'), { removed: true });
    assert.deepEqual(await scoped.remove('other-provider'), { removed: false });
    assert.deepEqual(await scoped.providerIds(), ['same-provider']);
    await scoped.set('other-provider', 'still-valid');
    const file = JSON.parse(await readFile(scoped.filename, 'utf8')); file.entries['same-provider'].encryptedKey = Buffer.from('damaged').toString('base64');
    await writeFile(scoped.filename, JSON.stringify(file));
    assert.deepEqual(await scoped.providerIds(), ['other-provider']);
    assert.deepEqual(await initializeStorageLocation(f.root, preferences), location);
    const database = path.join(location.dataDir, 'autolabel.db'); await writeFile(database, '建立后的数据库');
    await preferences.update({ dataEstablished: true }); await rm(database);
    await assert.rejects(initializeStorageLocation(f.root, preferences), /未创建空数据库/);
    await Promise.all([preferences.update({ closeBehavior: 'tray' }), preferences.update({ updateManifestUrl: '' })]);
    assert.equal(preferences.value.credentialScopeId, location.credentialScopeId); assert.equal(preferences.value.closeBehavior, 'tray');
    await preferences.update({ dataDir: path.join(f.root, 'missing-data') });
    await assert.rejects(initializeStorageLocation(f.root, preferences), /未创建空数据库/);
  } finally { await f.close(); }
});
test('数据占用只清理受管临时产物，维护锁失败时保留全部文件', async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.current, 'media')); await mkdir(path.join(f.current, 'media-jobs', 'job-1', 'generation', 'frames'), { recursive: true });
    await mkdir(path.join(f.current, '.backup-work', 'backup-1'), { recursive: true });
    await mkdir(path.join(f.current, 'evaluation-sets', '.partial-eval-1', 'images'), { recursive: true });
    await writeFile(path.join(f.current, 'media', 'source.png'), '正式素材');
    await writeFile(path.join(f.current, 'media', 'decode.tmp'), '临时');
    await writeFile(path.join(f.current, 'media-jobs', 'job-1', 'generation', 'frames', 'frame.png'), '已提交帧');
    await writeFile(path.join(f.current, 'media-jobs', 'job-1', 'generation', 'frames.partial.jsonl'), '未提交清单');
    await writeFile(path.join(f.current, '.backup-work', 'backup-1', 'part'), '备份临时');
    await writeFile(path.join(f.current, 'evaluation-sets', '.partial-eval-1', 'images', 'part'), '评测临时');
    const usage = await f.storage.usage();
    assert.ok(usage.databaseBytes > 0); assert.ok(usage.projectBytes >= Buffer.byteLength('正式素材')); assert.ok(usage.cacheBytes >= Buffer.byteLength('临时') + Buffer.byteLength('未提交清单'));
    const cleaned = await f.storage.cleanup();
    assert.ok(cleaned.removedBytes >= usage.cacheBytes); assert.ok(cleaned.removedPaths.some(value => value === '.backup-work'));
    await stat(path.join(f.current, 'media', 'source.png')); await stat(path.join(f.current, 'media-jobs', 'job-1', 'generation', 'frames', 'frame.png')); await stat(path.join(f.current, 'autolabel.db'));
    await assert.rejects(stat(path.join(f.current, 'media', 'decode.tmp'))); await assert.rejects(stat(path.join(f.current, '.backup-work'))); await assert.rejects(stat(path.join(f.current, 'evaluation-sets', '.partial-eval-1')));
    f.original.engine.maintenanceFailure = true;
    await writeFile(path.join(f.current, 'media', 'again.tmp'), '保留');
    await assert.rejects(f.storage.cleanup(), /维护锁暂不可用/); await stat(path.join(f.current, 'media', 'again.tmp'));
    assert.doesNotThrow(() => validateCommand('storage.usage', {})); assert.doesNotThrow(() => validateCommand('storage.cleanup', {}));
  } finally { await f.close(); }
});

test('退出等待维护锁释放有界，不因引擎失联无限挂起', async () => {
  const f = await fixture();
  try {
    f.original.engine.cancelFailure = true;
    await assert.rejects(f.storage.cleanup(), /维护锁尚未确认释放/);
    const started = Date.now(); await f.storage.whenIdle(25); assert.ok(Date.now() - started < 500);
    assert.equal(f.storage.status().phase, 'maintenance-uncertain');
  } finally { await f.close(); }
});

test('Java 停止等待实际 exit，超时不能伪装已退出', async () => {
  const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null });
  await assert.rejects(waitForEngineExit(child as any, 10), /尚未退出/);
  const waiting = waitForEngineExit(child as any, 1000);
  child.exitCode = 0; child.emit('exit', 0); await waiting;
  assert.equal(child.listenerCount('exit'), 0);
});
test('凭据绑定 UUID 首次迁移先持久，重启保持且每次显式保存更新', async () => {
  const f = await fixture();
  const protection = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from('test:' + value), decryptString: (value: Buffer) => value.toString().slice(5) };
  try {
    const filename = path.join(f.root, 'legacy-vault.json');
    await writeFile(filename, JSON.stringify({ version: 1, entries: { provider: protection.encryptString('same-key').toString('base64') } }));
    const vault = new CredentialVault(filename, protection);
    const [first, concurrent] = await Promise.all([vault.all(), vault.all()]);
    const version = first[0].credentialBindingVersion;
    assert.match(version, /^[0-9a-f-]{36}$/); assert.equal(concurrent[0].credentialBindingVersion, version);
    assert.equal(JSON.parse(await readFile(filename, 'utf8')).entries.provider.credentialBindingVersion, version);
    assert.equal((await new CredentialVault(filename, protection).all())[0].credentialBindingVersion, version);
    const saved = await vault.set('provider', 'same-key'); assert.notEqual(saved.credentialBindingVersion, version);
    const replaced = await vault.set('provider', 'new-key'); assert.notEqual(replaced.credentialBindingVersion, saved.credentialBindingVersion);
    const rebooted = new CredentialVault(filename, protection);
    assert.equal((await rebooted.all())[0].credentialBindingVersion, replaced.credentialBindingVersion);
    const injected: Record<string, unknown>[] = [];
    const engine = new EngineManager({ packaged: false, root: f.root, resources: '', dataDir: f.current, credentials: () => rebooted.all() });
    engine.request = async (command, payload = {}) => { assert.equal(command, 'credential.set'); injected.push(payload); return { saved: true }; };
    await engine.restoreCredentials(); assert.equal(injected[0].credentialBindingVersion, replaced.credentialBindingVersion);
    await engine.setCredential('legacy-caller', 'old-key'); assert.equal(Object.hasOwn(injected[1], 'credentialBindingVersion'), false);
    assert.throws(() => validateCommand('credential.set', { providerId: 'provider', key: 'key', credentialBindingVersion: version }), /格式不正确/);
  } finally { await f.close(); }
});
test('凭据旧版本原子迁移失败不交付临时绑定', async () => {
  const f = await fixture();
  let decryptions = 0;
  try {
    const filename = path.join(f.root, 'unwritable-vault.json');
    await writeFile(filename, JSON.stringify({ version: 1, entries: { provider: Buffer.from('opaque').toString('base64') } }));
    await mkdir(filename + '.tmp');
    const vault = new CredentialVault(filename, { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: () => { decryptions++; return 'key'; } });
    await assert.rejects(vault.all()); assert.equal(decryptions, 0);
    assert.equal(JSON.parse(await readFile(filename, 'utf8')).version, 1);
  } finally { await f.close(); }
});
test('真实 Java 注入持久绑定，重启保留且改 Key 阻断旧快照零请求', { skip: process.env.AUTOLABEL_BINDING_INTEGRATION !== '1' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autolabel-binding-desktop-'));
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.writeHead(500); response.end(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const protection = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() };
  const vault = new CredentialVault(path.join(root, 'vault.json'), protection);
  const engine = new EngineManager({ packaged: false, root: process.cwd(), resources: '', dataDir: path.join(root, 'data'), credentials: () => vault.all() });
  try {
    assert.equal((await engine.start()).state, 'ready');
    const project = await engine.request('project.example') as any;
    const assets = await engine.request('asset.list', { projectId: project.id, limit: 1 }) as any;
    const provider = await engine.request('provider.save', { name: '绑定实际验证', baseUrl: `http://127.0.0.1:${port}/v1`, protocol: 'chat-completions' }) as any;
    const first = await vault.set(provider.id, 'first-key'); await engine.setCredential(provider.id, 'first-key', first.credentialBindingVersion);
    await engine.suspend();
    const created = await engine.request('run.create', { projectId: project.id, assetIds: [assets.items[0].id], providerId: provider.id, model: 'fixture', prompt: '标注', maxRequests: 1, forceRerun: true }) as any;
    assert.equal(created.snapshot.credentialBindingVersion, first.credentialBindingVersion);
    await engine.stop(); assert.equal((await engine.start()).state, 'ready');
    assert.equal(engine.hasCredential(provider.id), true); assert.equal((await vault.all())[0].credentialBindingVersion, first.credentialBindingVersion);
    const updated = await vault.set(provider.id, 'second-key'); await engine.setCredential(provider.id, 'second-key', updated.credentialBindingVersion);
    await engine.request('run.resume', { runId: created.id });
    let current: any; const deadline = Date.now() + 3000;
    do { current = await engine.request('run.get', { runId: created.id }); if (current.pauseReason === 'credential_binding_changed') break; await new Promise(resolve => setTimeout(resolve, 50)); } while (Date.now() < deadline);
    assert.equal(current.pauseReason, 'credential_binding_changed'); assert.equal(current.requestsUsed, 0); assert.equal(requests, 0);
  } finally {
    await engine.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'autolabel-binding-desktop-'));
    await rm(root, { recursive: true, force: true });
  }
});

test('真实备份恢复与目录迁移保留资源 PNG，外部 scope 隔离且本地迁移保留凭据', { skip: process.env.AUTOLABEL_BACKUP_INTEGRATION !== '1' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autolabel-backup-desktop-'));
  const dataDir = path.join(root, 'original'); const backupDir = path.join(root, 'backups'); const restoreParent = path.join(root, 'restored'); const migrateParent = path.join(root, 'migrated');
  for (const directory of [dataDir, backupDir, restoreParent, migrateParent]) await mkdir(directory);
  const protection = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from('fixture:' + value), decryptString: (value: Buffer) => value.toString().slice(8) };
  const instances: EngineManager[] = [];
  const create = (location: StorageLocation) => {
    const vault = new CredentialVault(scopedVaultPath(root, location.credentialScopeId), protection);
    const engine = new EngineManager({ packaged: false, root: process.cwd(), resources: '', dataDir: location.dataDir, credentials: () => vault.all() });
    instances.push(engine); return { ...location, engine, vault };
  };
  const initial = create({ dataDir, credentialScopeId: 'original-scope' });
  const preferences = new DesktopPreferences(path.join(root, 'desktop-settings.json')); await preferences.load();
  await preferences.update({ dataDir, credentialScopeId: initial.credentialScopeId, dataEstablished: true });
  const storage = new DataStorage({ active: initial, create, commit: location => preferences.update({ ...location, dataEstablished: true }), activate: () => {}, guard: () => {} });
  const command = async (name: string, payload: Record<string, unknown>) => {
    const checked = validateCommand(name, payload); return storage.active.engine.request(checked.command, checked.payload) as Promise<any>;
  };
  try {
    assert.equal((await initial.engine.start()).state, 'ready');
    const project = await command('project.example', {});
    const { items } = await command('asset.list', { projectId: project.id, limit: 1 });
    let asset = await command('asset.get', { assetId: items[0].id });
    asset = await command('annotation.save', { assetId: asset.id, baseVersion: asset.version, annotations: asset.annotations, confirm: true });
    const reference = await command('resource.reference', { assetId: asset.id, assetVersion: asset.version, name: '完整备份人工参考' });
    const originalImage = Buffer.from(await (await initial.engine.media(mediaTargetFromUrl(reference.mediaUrl), new AbortController().signal)).arrayBuffer());
    const provider = await command('provider.save', { name: '仅凭据隔离验证', baseUrl: 'https://example.invalid/v1', protocol: 'chat-completions' });
    const originalBinding = await initial.vault.set(provider.id, 'original-key'); await initial.engine.setCredential(provider.id, 'original-key', originalBinding.credentialBindingVersion);
    assert.equal(initial.engine.hasCredential(provider.id), true);
    const preflight = await command('backup.preflight', { outputDir: backupDir }); assert.equal(preflight.ready, true);
    const backup = await storage.createBackup(backupDir) as any;
    assert.equal(backup.credentialsIncluded, false); assert.equal(backup.status, 'completed');
    const inspection = await command('backup.inspect', { backupPath: backup.backupPath }); assert.equal(inspection.valid, true);
    const prepared = await storage.prepareRestore(backup.backupPath, restoreParent);
    const activated = await storage.activate(prepared.preparationId as string); assert.equal(activated.credentialRebindRequired, true);
    assert.equal(initial.engine.status.state, 'stopped'); assert.notEqual(storage.active.credentialScopeId, initial.credentialScopeId);
    assert.equal(storage.active.engine.hasCredential(provider.id), false); assert.deepEqual(await storage.active.vault.providerIds(), []);
    assert.equal((await command('project.open', { projectId: project.id })).id, project.id);
    const restoredReference = await command('resource.get', { resourceId: reference.id, version: 1 });
    const restoredImage = Buffer.from(await (await storage.active.engine.media(mediaTargetFromUrl(restoredReference.mediaUrl), new AbortController().signal)).arrayBuffer());
    assert.deepEqual(restoredImage, originalImage);
    const restoredBinding = await storage.active.vault.set(provider.id, 'restored-key'); await storage.active.engine.setCredential(provider.id, 'restored-key', restoredBinding.credentialBindingVersion);
    const restoredScope = storage.active.credentialScopeId;
    const migrated = await storage.migrate(migrateParent); assert.equal(migrated.credentialRebindRequired, false);
    assert.equal(storage.active.credentialScopeId, restoredScope); assert.equal(storage.active.engine.hasCredential(provider.id), true);
    assert.equal((await storage.active.vault.all())[0].key, 'restored-key'); assert.equal((await initial.vault.all())[0].key, 'original-key');
    assert.equal((await stat(path.join(dataDir, 'autolabel.db'))).isFile(), true);
    assert.equal(preferences.value.dataDir, storage.active.dataDir);
    await storage.active.engine.stop();
    const database = path.join(storage.active.dataDir, 'autolabel.db');
    await rename(database, database + '.held');
    assert.equal((await storage.active.engine.start()).state, 'error');
    await assert.rejects(stat(database));
    await rename(database + '.held', database);
    assert.equal((await storage.active.engine.start()).state, 'ready');
  } finally {
    for (const engine of instances) await engine.stop();
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'autolabel-backup-desktop-'));
    await rm(root, { recursive: true, force: true });
  }
});
