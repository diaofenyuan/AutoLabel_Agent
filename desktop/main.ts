import { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, nativeImage, protocol, session, powerMonitor, safeStorage } from 'electron';
import type { IpcMainInvokeEvent, OpenDialogOptions } from 'electron';
import path from 'node:path';
import { readFile, writeFile, mkdir, stat, statfs, realpath, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { EngineManager } from './engine';
import { AgentManager } from './agent-manager';
import { UpdateManager, assertUpdateIdle, validateUpdateUrl } from './updater';
import { readExecutableIdentity, verifyUpdatePackage } from './update-package';
import { checkDesktopUi, checkDesktopConnection, checkPersistedUiEdit, checkPackagedRelease, checkTrainingUi } from './ui-check';
import { DialogFixtures } from './dialog-fixtures';
import { CredentialVault } from './vault';
import { LocalExecutionSettings } from './local-execution';
import { ModelLibrary } from './model-library';
import { MediaExecutionSettings } from './media-execution';
import { VideoTranscoder } from './transcode';
import { DataStorage, DesktopPreferences, initializeStorageLocation, scopedVaultPath, type StorageLocation } from './storage';
import { StoragePathSettings, resolveStoragePaths, storagePathsState, validateTrainingRoot, type ResolvedPaths } from './storage-paths';
import { ChatStore } from './chat-store';
import type { StoragePathsState } from '../shared/storage';
import { PathGrants, authorizeCommandPaths, mediaTargetFromUrl, isTrustedUrl, normalizeMedia, publicInputResult, redact } from './security';
import { addProjectClasses } from './project-classes';
import { DesktopError, validateCommand, assertAgentCommand, fileSelectionSchema, saveFileSchema, windowActionSchema, transcodeSourceSchema, transcodeOutputSchema, directoryScanSchema } from './validation';
import { DIRECTORY_SCAN_MAX_DEPTH, DIRECTORY_SCAN_MAX_FILES, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, isImagePath, isVideoPath } from '../shared/mediaFormats';

protocol.registerSchemesAsPrivileged([
  { scheme: 'autolabel-app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'autolabel-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);
app.setName('自动标注小助手');
app.setAppUserModelId('com.autolabel.assistant');
if (process.env.AUTOLABEL_TEST_USER_DATA && process.argv.includes('--desktop-smoke')) app.setPath('userData', path.resolve(process.env.AUTOLABEL_TEST_USER_DATA));
const root = app.getAppPath();
const userData = app.getPath('userData');
const manualCheck = !app.isPackaged && !!process.env.AUTOLABEL_TEST_USER_DATA && process.argv.includes('--desktop-smoke') && process.argv.includes('--desktop-manual-check');
const dialogFixtures = manualCheck ? new DialogFixtures(userData) : undefined;
let dataDir = path.join(userData, 'data');
const preferencesPath = path.join(userData, 'desktop-settings.json');
const preferenceStore = new DesktopPreferences(preferencesPath);
// 三类业务数据的默认根跟随安装目录；开发态使用仓库内独立目录，避免与打包产物混写。
const installDirectory = app.isPackaged ? path.dirname(process.execPath) : path.join(root, 'build', 'dev-install');
const storagePathSettings = new StoragePathSettings(preferenceStore, () => installDirectory, () => dataDir);
let storagePaths: ResolvedPaths | undefined;
// 对话记录目录取自解析后的三类路径，改路径后无需重启即可生效。
const chatStore = new ChatStore(() => storagePaths?.entries.find(entry => entry.kind === 'chats')?.path ?? '');
const iconPath = path.join(root, 'build', 'icon.png');
/** 视频候选清单的上限：界面上是一份让用户逐个点「抽帧」的列表，不需要把上万条路径送回渲染层。 */
const MEDIA_LIST_LIMIT = 500;
/** 单次拖入的文件数上限：超量时把「上限」和「本次数量」一起回给界面，而不是抛错误码。 */
const DROP_FILE_LIMIT = 500;
const grants = new PathGrants();
const localExecution = new LocalExecutionSettings(preferenceStore, grants);
const mediaExecution = new MediaExecutionSettings(preferenceStore, grants, path.join(app.isPackaged ? process.resourcesPath : path.join(root, 'build'), 'media-tools'));
// 模型库：内置权重随安装包（resources/models），下载的权重落在 <存储根>/models。
// 两条来源共用同一份目录与 sha256 核对，界面拿到的只有状态，拿不到绝对路径。
const modelLibrary = new ModelLibrary({
  builtinRoot: () => path.join(app.isPackaged ? process.resourcesPath : path.join(root, 'build'), 'models'),
  storageRoot: () => storagePaths?.root,
  dataDirectory: () => dataDir,
});
let vault: CredentialVault;
let engine: EngineManager;
// 转码副本只落在系统临时目录：它是「到达抽帧」的一次性中间物，不属于任何项目或数据目录。
const transcoder = new VideoTranscoder(() => mediaExecution.paths(), path.join(app.getPath('temp'), 'autolabel-transcode'), message => engine?.log(message));
type ActiveStorage = StorageLocation & { engine: EngineManager; vault: CredentialVault };
let storage: DataStorage<ActiveStorage> | undefined;
const agent = new AgentManager(path.join(__dirname, 'agent.cjs'), (command, payload) => request(command, payload, true));
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;
let shutdownStarted = false;
let askingClose = false;
let rendererDirty = false;
let closeBehavior: 'ask' | 'tray' | 'quit' = 'ask';
let preferences: Record<string, unknown> = {};
let installingUpdate = false;
/** 上次成功重启引擎的时间戳，用于抑制连点导致的反复杀启 JVM。 */
let engineRestartedAt = 0;
let credentialSaves = 0;
let credentialPending: Promise<unknown> = Promise.resolve();
const providerCredentialMutations = new Set<string>();
let publisher: string | undefined;
let publisherChecked = !app.isPackaged;
const allowLocalUpdateTest = !app.isPackaged && process.env.AUTOLABEL_UPDATE_TEST === '1';
const updates = new UpdateManager({ directory: path.join(userData, 'updates'), currentVersion: app.getVersion(), allowLoopbackHttp: allowLocalUpdateTest,
  verifyPackage: (filename, manifest) => {
    // 本地更新 UI 夹具只验证下载、校验和安装门控；生产路径仍必须验证签名与产品版本。
    if (allowLocalUpdateTest) return Promise.resolve();
    if (!publisherChecked) throw new DesktopError('UPDATE_PUBLISHER_UNAVAILABLE', '无法确认当前程序的签名状态，请重新启动应用后再试');
    return verifyUpdatePackage(filename, manifest, publisher);
  },
  prepareInstall: async () => {
    if (!app.isPackaged) throw new DesktopError('UPDATE_DEVELOPMENT_BUILD', '开发模式不执行安装，请使用已安装的应用');
    assertUpdateIdle({ installing: installingUpdate, agentActive: agent.activeCount, credentialSaves,
      localBusy: localExecution.busy, localUncertain: localExecution.uncertain, mediaBusy: mediaExecution.busy,
      mediaUncertain: mediaExecution.uncertain, storageBusy: !!storage?.busy });
    installingUpdate = true;
    try {
      if (engine.status.state !== 'ready') throw new DesktopError('UPDATE_ENGINE_UNAVAILABLE', '无法确认引擎活动状态，请恢复连接后再安装');
      const state = await engine.request('system.prepareUpdate', {}, 15000) as { ready: boolean; locked: boolean; message?: string };
      if (state.ready !== true || state.locked !== true) throw new DesktopError('UPDATE_TASKS_ACTIVE', state.message ?? '请先结束未完成任务并处理待确认调用，再安装更新');
      agent.stop(); await engine.stop();
    } catch (error) { installingUpdate = false; throw error; }
  },
  launchInstaller: filename => new Promise((resolve, reject) => {
    const installer = spawn(filename, ['--updated'], { detached: true, stdio: 'ignore', windowsHide: false });
    installer.once('error', () => reject(new DesktopError('UPDATE_INSTALL_FAILED', '更新安装程序无法启动，请稍后重试')));
    installer.once('spawn', () => { installer.unref(); resolve(); setImmediate(() => app.quit()); });
  }),
  cancelInstallPreparation: () => {
    installingUpdate = false;
    if (engine.status.state === 'stopped') void engine.start();
    else if (engine.status.state === 'ready') void engine.request('system.cancelUpdate', {}, 5000).catch(() => engine.log('更新维护锁未解除，请重新连接引擎'));
  },
});
let devOrigin: string | undefined;
if (!app.isPackaged && process.env.AUTOLABEL_RENDERER_URL) {
  const url = new URL(process.env.AUTOLABEL_RENDERER_URL);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password) throw new Error('开发服务器必须为本机 HTTP 地址');
  devOrigin = url.origin;
}
// 开发态需要额外放宽两项，且只在 devOrigin 存在（仅本机 Vite）时生效：
// 1) Vite 在 index.html 顶部内联注入 react-refresh 预置脚本，被 `script-src 'self'` 拦下会让 $RefreshSig$ 未定义、
//    整个界面挂载失败并停在白屏；2) HMR 走 WebSocket。
const csp = `default-src 'none'; script-src 'self'${devOrigin ? " 'unsafe-inline'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' autolabel-media: data: blob:; font-src 'self' data:; connect-src 'self'${devOrigin ? ` ${devOrigin.replace('http:', 'ws:')}` : ''}; media-src autolabel-media: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`;

function send(channel: string, value: unknown): void { if (window && !window.isDestroyed()) window.webContents.send(channel, value); }
function createBackend(location: StorageLocation): ActiveStorage {
  const scopedVault = new CredentialVault(scopedVaultPath(userData, location.credentialScopeId));
  const instance = new EngineManager({ packaged: app.isPackaged, root, resources: process.resourcesPath, dataDir: location.dataDir, credentials: () => scopedVault.all(),
    // 导入复制的受管原图落在存储根下的 uploads；引擎只接受绝对路径，未解析时沿用数据目录内的旧位置。
    materialsRoot: () => storagePaths?.entries.find(entry => entry.kind === 'uploads')?.path,
    // 训练产物目录是引擎启动参数：设置页保存后由主进程在空闲时重启引擎让新落点生效。
    trainingRoot: () => savedTrainingRoot() ?? undefined,
    localPythonPath: () => localExecution.pythonPath(),
    localModelAuthorizations: () => localExecution.modelAuthorizations(location.credentialScopeId),
    mediaToolPaths: () => mediaExecution.paths(),
    requireExistingData: !(preferenceStore.value.dataDir === location.dataDir && preferenceStore.value.dataEstablished === false) });
  instance.on('status', value => {
    if (engine !== instance) return;
    send('autolabel:status', value);
  });
  instance.on('event', value => { if (engine === instance) send('autolabel:event', value); });
  return { ...location, engine: instance, vault: scopedVault };
}
function setActiveStorage(active: ActiveStorage): void {
  engine = active.engine; vault = active.vault; dataDir = active.dataDir;
}
/** 解析三类数据落点、建目录并预授权受管数据集目录；回退信息随状态返回，不静默降级。 */
async function refreshStoragePaths(): Promise<StoragePathsState> {
  storagePaths = await resolveStoragePaths(preferenceStore, installDirectory, dataDir);
  try { await grants.add(storagePaths.entries.find(entry => entry.kind === 'datasets')!.path, 'directory'); }
  catch { engine.log('默认数据集目录未能预授权，导出时将要求手动选择目录'); }
  return storagePathsState(storagePaths);
}
function storagePathsReport(): StoragePathsState | undefined {
  return storagePaths ? storagePathsState(storagePaths) : undefined;
}
/** Windows 路径大小写不敏感；用它判断受管原图目录是否真的换到了别处。 */
function sameStoragePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}
/** 已保存的训练产物目录；空值表示沿用数据目录内的默认位置。 */
function savedTrainingRoot(): string | null {
  const value = preferenceStore.value.trainingRoot;
  return typeof value === 'string' && value.trim() ? value : null;
}
/** 训练产物目录状态：引擎给出实际生效位置与占用，主进程补上「已保存的配置值」供设置页回填。 */
async function trainingRootStatus(): Promise<Record<string, unknown>> {
  const savedPath = savedTrainingRoot();
  try { return { ...await engine.request('training.root.status') as object, savedPath }; }
  catch { return { savedPath, engineAvailable: false }; }
}
/**
 * 保存训练产物目录：先让引擎把已有任务与数据集固定在原目录，再写入配置并尽力重启引擎。
 * 引擎忙时明确返回待生效，不打断正在进行或排队的训练。
 */
async function saveTrainingRoot(value: string | null): Promise<Record<string, unknown>> {
  const before = savedTrainingRoot();
  const next = value === null || !value.trim() ? null : await validateTrainingRoot(value, dataDir!);
  if ((before ?? '') === (next ?? '') || (before && next && sameStoragePath(before, next))) return { savedPath: before, trainingRoot: 'unchanged' };
  const pinned = await engine.request('training.root.pin') as { jobs?: number; datasets?: number };
  preferences = await preferenceStore.update({ trainingRoot: next });
  if (engine.status.state === 'ready') {
    try {
      const gate = await engine.request('system.canUpdate') as { ready?: boolean };
      if (gate?.ready) { await engine.restart(); return { ...pinned, savedPath: next, trainingRoot: 'active' as const }; }
    } catch { /* 引擎不可用时保留待生效标记，由界面如实提示。 */ }
  }
  return { ...pinned, savedPath: next, trainingRoot: 'pending-restart' as const };
}
agent.on('event', value => send('autolabel:agent-event', value));

function assertSender(event: IpcMainInvokeEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !isTrustedUrl(event.senderFrame?.url ?? '', devOrigin)) throw new DesktopError('IPC_DENIED', '该页面无权调用桌面能力');
}
function handle(channel: string, callback: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try { assertSender(event); return { ok: true, data: await callback(event, ...args) }; }
    catch (error) { return { ok: false, error: { code: error instanceof DesktopError ? error.code : 'DESKTOP_OPERATION_FAILED',
      message: error instanceof DesktopError ? error.message : '桌面操作未完成，请重新选择或查看诊断' } }; }
  });
}
async function diskDiagnostics(): Promise<Record<string, unknown>> {
  try {
    const disk = await statfs(dataDir);
    return { freeBytes: Number(disk.bavail) * Number(disk.bsize), dataLocation: '当前 Windows 用户的应用数据目录' };
  } catch { return { freeBytes: null, dataLocation: '应用数据目录不可用' }; }
}
async function diagnostics(): Promise<Record<string, unknown>> {
  const usage = await storage?.usage();
  return { appVersion: app.getVersion(), electronVersion: process.versions.electron, nodeVersion: process.versions.node,
    platform: process.platform, arch: process.arch, packaged: app.isPackaged, credentialProtection: safeStorage.isEncryptionAvailable(),
    ...engine.diagnostics(), storage: { ...await diskDiagnostics(), ...(usage ? { usage } : {}) },
    storagePaths: storagePathsReport() ?? { available: false },
    exportScope: ['应用和引擎版本', '连接状态与错误代码', '有限脱敏启动日志'],
    excluded: ['API Key 和认证头', '图片', '完整提示词与响应', '接口 URL', '个人绝对路径'] };
}
function containsSensitiveFields(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => /authorization|api.?key|secret|password|token/i.test(key) || containsSensitiveFields(child));
}
/** 对话记录只涉及 chats 目录；导出目标必须已由保存对话框授权。 */
async function chatHistory(command: string, payload: Record<string, unknown>): Promise<unknown> {
  if (command === 'chat.history.list') return chatStore.list(payload.projectId as string | undefined);
  if (command === 'chat.history.get') return chatStore.get(payload.sessionId);
  if (command === 'chat.history.status') return chatStore.status();
  if (command === 'chat.history.trash.list') return chatStore.trashList();
  if (command === 'chat.history.ensure') return chatStore.ensure({
    sessionId: payload.sessionId as string,
    ...(payload.projectId ? { projectId: payload.projectId as string } : {}),
    ...(payload.title !== undefined ? { title: payload.title as string } : {}),
    ...(payload.projectName !== undefined ? { projectName: payload.projectName as string } : {}),
    ...(payload.providerId !== undefined ? { providerId: payload.providerId as string } : {}),
    ...(payload.model !== undefined ? { model: payload.model as string } : {}),
  });
  if (command === 'chat.history.rename') return chatStore.rename(payload.sessionId, payload.title);
  if (command === 'chat.history.pin') return chatStore.pin(payload.sessionId, payload.pinned);
  if (command === 'chat.history.delete') return chatStore.delete(payload.sessionIds);
  if (command === 'chat.history.clear') return chatStore.clear(payload.before);
  if (command === 'chat.history.restore') return chatStore.restore(payload.trashIds);
  if (command === 'chat.history.purge') return chatStore.purge(payload.all);
  if (command === 'chat.history.export') {
    const target = await grants.requireOutput(payload.targetPath);
    const bundle = await chatStore.bundle(payload.sessionIds);
    await writeFile(target, JSON.stringify(bundle, null, 2));
    return { saved: true, sessions: bundle.sessions.length };
  }
  throw new DesktopError('COMMAND_DENIED', '此操作未开放给界面');
}
/** 默认备份目录位于存储根下，与数据库目录分离，避免备份被下一次删除覆盖。 */
async function prepareDefaultBackupDirectory(): Promise<string> {
  const root = storagePaths?.root ?? path.join(userData, 'AutoLabelData');
  const backupDir = path.join(root, 'backups');
  await mkdir(backupDir, { recursive: true });
  return grants.add(backupDir, 'directory');
}
/**
 * 项目删除：先按选项完成备份，再在同一套维护锁内执行级联删除。
 * 备份失败即中止，避免留下「已删除但无备份」的状态。
 * project.delete 是维护锁内的破坏性动作，必须回传本次锁的 operationId，否则引擎以未声明归属拒绝。
 */
async function deleteProject(payload: Record<string, unknown>): Promise<unknown> {
  const projectId = payload.projectId as string;
  let backup: Record<string, unknown> | null = null;
  if (payload.createBackup !== false) {
    const backupDir = typeof payload.backupDir === 'string' && payload.backupDir
      ? await grants.require(payload.backupDir, ['directory']) : await prepareDefaultBackupDirectory();
    backup = await storage!.createBackup(backupDir) as Record<string, unknown>;
  }
  const result = await storage!.withMaintenance(operationId =>
    engine.request('project.delete', { ...payload, operationId })) as Record<string, unknown>;
  // 历史对话保留，只标记来源项目已删除。
  await chatStore.markProjectDeleted(projectId).catch(error => engine.log(`对话记录标记未更新：${error instanceof DesktopError ? error.code : 'CHAT_MARK_FAILED'}`));
  // 备份可能不含已不可读取的历史外部原件（引擎把它们降级为警告）；不回传的话
  // 用户会默认备份是完整的，这正是删除前备份最容易误导人的地方。
  return backup
    ? { ...result, backupPath: backup.backupPath, backupWarnings: Array.isArray(backup.warnings) ? backup.warnings : [] }
    : result;
}
/**
 * 导出默认落点：受管「划分好的训练集」目录下的「项目名-时间戳」子目录。
 * 目录由主进程创建并授权，用户改选时仍走文件选择器的逐项授权。
 */
async function defaultExportDirectory(projectId: string): Promise<string> {
  const root = storagePaths?.entries.find(entry => entry.kind === 'datasets')?.path;
  if (!root) throw new DesktopError('STORAGE_UNAVAILABLE', '尚未解析训练集落点，请在设置中检查存储位置后重试');
  const project = await engine.request('project.open', { projectId }) as { name?: string };
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15).replace('T', '-');
  const safe = (project.name ?? '项目').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || '项目';
  const target = path.join(root, `${safe}-${stamp}`);
  await mkdir(target, { recursive: true });
  await grants.add(target, 'directory');
  return target;
}
/** 流程定义的导出步骤缺省同样使用受管默认落点；模板里写了路径的步骤保持逐一授权。 */
async function injectExportDefaults(definition: unknown, projectId: string): Promise<void> {
  if (!definition || typeof definition !== 'object') return;
  for (const step of (definition as { steps?: Array<{ kind: string; enabled: boolean; parameters: Record<string, unknown> }> }).steps ?? []) {
    if (step.kind !== 'export' || !step.enabled) continue;
    if (typeof step.parameters.outputDir === 'string' && step.parameters.outputDir) continue;
    step.parameters.outputDir = await defaultExportDirectory(projectId);
  }
}
/**
 * 训练产物登记为本地模型：产物路径由引擎生成而不经文件对话框，
 * 因此由主进程解析受管路径后执行一次显式授权，再走既有登记入口，不放宽本地模型登记规则。
 */
async function registerTrainingModel(payload: Record<string, unknown>): Promise<unknown> {
  const artifact = await engine.request('training.job.artifact', { jobId: payload.jobId, kind: payload.checkpoint }) as
    { path: string; hash: string; taskType: string; classNames?: string[] };
  const modelPath = await grants.add(artifact.path, 'model');
  const result = await engine.request('local.model.register', {
    name: payload.name as string, taskType: artifact.taskType, modelPath,
    ...(artifact.classNames?.length ? { classNames: artifact.classNames } : {}),
  }) as Record<string, unknown>;
  if (result.modelHash !== artifact.hash) throw new DesktopError('TRAINING_ARTIFACT_MISMATCH', '登记结果与训练产物哈希不一致，请重新核对产物');
  return result;
}
/** 对话完成后由主进程落盘；记录失败不改变本次对话结果，只写诊断日志。 */
async function recordAgentChat(payload: Record<string, unknown>): Promise<unknown> {
  const record: Parameters<ChatStore['record']>[0] = {
    sessionId: payload.sessionId as string,
    ...(payload.projectId ? { projectId: payload.projectId as string } : {}),
    providerId: payload.providerId as string,
    model: payload.model as string,
    messages: (payload.messages ?? []) as Array<{ role: string; content: string }>,
  };
  const logFailure = (error: unknown) => engine.log(`对话记录未写入：${error instanceof DesktopError ? error.code : 'CHAT_RECORD_FAILED'}`);
  try {
    const result = await agent.request('agent.chat', payload) as { content?: string; status?: string } | undefined;
    const reply = result?.content || (result?.status === 'cancelled' ? '对话已停止。' : '接口未返回文本。');
    await chatStore.record({ ...record, reply }).catch(logFailure);
    return result;
  } catch (error) {
    const message = error instanceof DesktopError ? `${error.message}（${error.code}）` : '本次调用未完成';
    await chatStore.record({ ...record, error: message }).catch(logFailure);
    throw error;
  }
}
/**
 * 启动日志。
 *
 * 受限环境下应用可能连窗口都没创建就退出，控制台输出对双击启动的用户等于不存在；
 * 把启动期的关键事件写进用户数据目录的 startup.log，出错提示里直接给出路径。
 */
async function appendStartupLog(message: unknown): Promise<void> {
  try {
    await mkdir(userData, { recursive: true });
    const file = path.join(userData, 'startup.log');
    const line = `${new Date().toISOString()} ${redact(message)}\n`;
    const existing = await readFile(file, 'utf8').catch(() => '');
    // 只留最近一段：启动日志的用处是「刚才那次为什么没起来」，不是长期审计。
    const kept = existing.length > 256 * 1024 ? existing.slice(-128 * 1024) : existing;
    await writeFile(file, kept + line);
  } catch { /* 日志写不进去不能反过来影响启动。 */ }
}

async function request(command: unknown, input: unknown, fromAgent = false): Promise<unknown> {
  const requestEngine = engine; const requestVault = vault;
  const requestScope = preferenceStore.value.credentialScopeId as string;
  const validated = validateCommand(command, input);
  const payload = validated.payload;
  if (fromAgent) assertAgentCommand(validated.command, payload);
  if (validated.command === 'storage.status') { await storage!.reconcile(); return storage!.status(); }
  if (validated.command === 'diagnostics.get') return diagnostics();
  if (validated.command === 'diagnostics.save') return saveDiagnostics();
  if (validated.command === 'storage.paths.get') return storagePathSettings.status();
  // 助手只能新增类别名：读回当前类别后按现有配色规则追加，其余字段原样带回。
  // 转发给引擎的仍是既有的 project.update，不新开引擎接口；引擎照常做模板校验与历史标注一致性检查。
  if (validated.command === 'project.classes.add') return addProjectClasses(engine, payload as { projectId: string; names: string[] });
  if (validated.command === 'storage.paths.migration') return storagePathSettings.migration();
  if (storage?.busy && validated.command !== 'update.status') throw new DesktopError('STORAGE_BUSY', '数据维护正在进行，请等待完成');
  if (validated.command === 'storage.paths.probe') return storagePathSettings.probe(payload.path);
  if (validated.command === 'storage.paths.save') {
    const previous = storagePaths?.entries.find(entry => entry.kind === 'uploads')?.path;
    const saved = await storagePathSettings.save(payload);
    await refreshStoragePaths();
    const current = storagePaths?.entries.find(entry => entry.kind === 'uploads')?.path;
    if (previous && current && !sameStoragePath(previous, current)) {
      // 受管原图目录由引擎启动参数决定：空闲时立即重启让新落点生效，忙时明确标记待生效而不打断任务。
      // 引擎不可用（error/disconnected）时同样必须回报 pending-restart —— 直接返回 saved 会让
      // 界面把「改动根本没被引擎采用」显示成「已生效」，属于静默谎报成功。
      if (engine.status.state === 'ready') {
        try {
          const gate = await engine.request('system.canUpdate') as { ready?: boolean };
          if (gate?.ready) { await engine.restart(); return { ...saved, materialsRoot: 'active' as const }; }
        } catch { /* 引擎不可用时保留待生效标记，由界面如实提示。 */ }
      }
      return { ...saved, materialsRoot: 'pending-restart' as const };
    }
    return saved;
  }
  if (validated.command === 'storage.paths.migrate') return storagePathSettings.migrate();
  // 模型库读写都在主进程完成：下载地址与哈希取自共享目录，渲染层只能指定模型标识。
  if (validated.command === 'model.library.status') return modelLibrary.status();
  if (validated.command === 'model.library.install') return modelLibrary.install(payload.catalogId as string);
  if (validated.command === 'model.library.remove') return modelLibrary.remove(payload.catalogId as string);
  // 训练产物目录与三类业务数据同理：走专用命令，不经过 settings.save 的路径守卫。
  if (validated.command === 'training.root.status') return trainingRootStatus();
  if (validated.command === 'training.root.save') return saveTrainingRoot(payload.path as string | null);
  if (validated.command.startsWith('chat.history.')) return chatHistory(validated.command, payload);
  if (validated.command === 'storage.usage') return storage!.usage();
  if (validated.command === 'storage.cleanup') return storage!.cleanup();
  if (validated.command.startsWith('update.')) {
    if (validated.command === 'update.status') return updates.status();
    if (validated.command === 'update.check') return updates.check();
    if (validated.command === 'update.download') return updates.download();
    if (validated.command === 'update.cancel') return updates.cancel();
    return updates.install();
  }
  if (installingUpdate) throw new DesktopError('UPDATE_INSTALLING', '正在准备安装更新，暂不接受新的项目操作');
  // 首屏读取等待同一次启动握手；正常启动不能被误报为连接故障。
  if (requestEngine.status.state === 'starting') await requestEngine.start();
  const authorizeLocal = async (parameters: Record<string, unknown>) => {
    if (localExecution.busy || localExecution.uncertain) throw new DesktopError('LOCAL_CONFIGURATION_BUSY', '本地执行配置尚未就绪');
    const model = await requestEngine.request('local.model.resolve', { modelId: parameters.modelId, ...(parameters.modelVersion !== undefined ? { version: parameters.modelVersion } : {}) }) as Record<string, unknown>;
    if (model.modelId !== parameters.modelId || !Number.isInteger(model.version) || Number(model.version) < 1 || (parameters.modelVersion !== undefined && parameters.modelVersion !== model.version)) throw new DesktopError('LOCAL_MODEL_MISMATCH', '本地模型解析结果与请求不一致');
    await localExecution.requireModel(requestScope, model.path, model.modelHash);
    parameters.modelVersion = model.version;
  };
  const authorizeLocalSteps = async (definition: unknown) => {
    if (!definition || typeof definition !== 'object') return;
    for (const step of (definition as { steps?: Array<{ kind: string; enabled: boolean; parameters: Record<string, unknown> }> }).steps ?? []) {
      if (step.kind === 'local' && step.enabled) await authorizeLocal(step.parameters);
    }
  };
  if (['run.resume', 'run.retry'].includes(validated.command)) {
    const run = await requestEngine.request('run.get', { runId: payload.runId }) as Record<string, unknown>;
    if (run.kind === 'local') await authorizeLocal({ modelId: run.modelId, modelVersion: run.modelVersion });
  }
  if (validated.command === 'media.job.retry') {
    const job = await requestEngine.request('media.job.resolve', { jobId: payload.jobId }) as Record<string, unknown>;
    if (job.jobId !== payload.jobId || !['video_extract', 'image_screening'].includes(String(job.kind))) throw new DesktopError('MEDIA_JOB_MISMATCH', '媒体任务解析结果与请求不一致');
    if (job.kind === 'video_extract') await grants.require(job.sourcePath, ['video']);
  }
  if (['flow.resume', 'flow.retry', 'flow.rerun'].includes(validated.command) && !payload.definition) {
    const run = await requestEngine.request('flow.get', { flowRunId: payload.flowRunId }) as { definition: unknown; steps?: Array<Record<string, unknown>> };
    const inherited = { ...payload, definition: run.definition };
    if (fromAgent) assertAgentCommand(validated.command, inherited);
    for (const step of run.steps ?? []) {
      const fixed = step.local && typeof step.local === 'object' ? step.local as Record<string, unknown> : step.kind === 'local' ? step : undefined;
      if (fixed?.modelId) await authorizeLocal({ modelId: fixed.modelId, modelVersion: fixed.modelVersion });
    }
    await authorizeCommandPaths(validated.command, inherited, grants);
  }
  if (['local.model.load', 'local.run.create'].includes(validated.command)) await authorizeLocal(payload);
  if (['flow.create', 'flow.rerun'].includes(validated.command) && payload.definition) await authorizeLocalSteps(payload.definition);
  // 导出默认落点由主进程注入并授权：未显式指定时用受管「划分好的训练集」目录。
  if (validated.command === 'export.create' && !payload.outputDir) payload.outputDir = await defaultExportDirectory(payload.projectId as string);
  if (['flow.create', 'flow.rerun'].includes(validated.command) && payload.definition) await injectExportDefaults(payload.definition, payload.projectId as string);
  await authorizeCommandPaths(validated.command, payload, grants);
  if (storage?.busy || requestEngine !== engine) throw new DesktopError('STORAGE_BUSY', '数据目录正在切换，请重新操作');
  if (validated.command === 'local.runtime.configure') {
    return publicInputResult(await localExecution.configure(requestEngine, payload.pythonPath, () => {
      if (storage?.busy || requestEngine !== engine || installingUpdate || shutdownStarted) throw new DesktopError('STORAGE_BUSY', '配置保存时数据目录或引擎状态已变化，请重新操作');
    }));
  }
  if (validated.command === 'media.runtime.configure') {
    return publicInputResult(await mediaExecution.configure(requestEngine, payload, () => {
      if (storage?.busy || requestEngine !== engine || installingUpdate || shutdownStarted) throw new DesktopError('STORAGE_BUSY', '配置保存时数据目录或引擎状态已变化，请重新操作');
    }));
  }
  if (validated.command.startsWith('media.') && !['media.runtime.get', 'media.job.get', 'media.job.list', 'media.job.cancel', 'media.video.frames', 'media.screening.result'].includes(validated.command)
    && (mediaExecution.busy || mediaExecution.uncertain)) throw new DesktopError('MEDIA_CONFIGURATION_BUSY', '媒体工具配置尚未就绪，请完成保存或重新连接引擎');
  if (validated.command.startsWith('local.') && !['local.runtime.get', 'local.model.get', 'local.model.list'].includes(validated.command)
    && (localExecution.busy || localExecution.uncertain)) throw new DesktopError('LOCAL_CONFIGURATION_BUSY', '本地执行配置尚未就绪，请完成保存或重新连接引擎');
  if (validated.command === 'backup.create') return storage!.createBackup(payload.outputDir as string);
  if (validated.command === 'project.delete') return deleteProject(payload);
  if (validated.command === 'training.job.registerModel') return registerTrainingModel(payload);
  if (validated.command === 'restore.prepare') return storage!.prepareRestore(payload.backupPath as string, payload.targetParent as string);
  if (validated.command === 'storage.activate' || validated.command === 'storage.migrate') {
    const result = validated.command === 'storage.activate' ? await storage!.activate(payload.preparationId as string) : await storage!.migrate(payload.targetParent as string);
    agent.stop();
    setImmediate(() => { void loadRenderer().catch(() => engine.log('数据已切换，界面刷新未完成，请重新加载界面')); });
    return result;
  }
  if (validated.command.startsWith('agent.')) {
    if (validated.command === 'agent.chat' && providerCredentialMutations.has(payload.providerId as string)) {
      throw new DesktopError('CREDENTIAL_BUSY', '该接口凭据正在删除或保存，请稍后重试');
    }
    // 拦截点已持有完整上下文，落盘在此完成；流式增量不落盘。
    if (validated.command === 'agent.chat') return recordAgentChat(payload);
    return agent.request(validated.command, payload);
  }
  // 回读已保存的 API Key：设置页回显用（默认掩码展示，眼睛切换查看明文）。明文只在本机内存传递，不写入任何配置文件。
  if (validated.command === 'credential.get') {
    const key = await requestVault.get(payload.providerId as string);
    return { hasCredential: Boolean(key), key: key ?? '' };
  }
  if (validated.command === 'credential.set') {
    const providerId = payload.providerId as string;
    if (providerCredentialMutations.has(providerId)) throw new DesktopError('CREDENTIAL_BUSY', '该接口凭据正在保存或删除，请稍后重试');
    providerCredentialMutations.add(providerId);
    credentialSaves++;
    const operation = credentialPending.then(async () => {
      if (storage?.busy || engine !== requestEngine) throw new DesktopError('STORAGE_BUSY', '数据目录已变化，请重新保存当前接口凭据');
      const binding = await requestVault.set(providerId, payload.key as string);
      if (['ready', 'disconnected'].includes(requestEngine.status.state)) {
        await requestEngine.setCredential(providerId, payload.key as string, binding.credentialBindingVersion);
      }
      return { saved: true };
    }).finally(() => { providerCredentialMutations.delete(providerId); credentialSaves--; });
    credentialPending = operation.catch(() => undefined);
    return operation;
  }
  if (validated.command === 'provider.delete') {
    const providerId = payload.providerId as string;
    if (agent.activeCount) throw new DesktopError('AGENT_BUSY', '当前对话仍在使用接口，请等待完成或取消后再删除');
    if (providerCredentialMutations.has(providerId)) throw new DesktopError('CREDENTIAL_BUSY', '该接口凭据正在保存或删除，请稍后重试');
    providerCredentialMutations.add(providerId); credentialSaves++;
    const operation = credentialPending.then(async () => {
      if (storage?.busy || engine !== requestEngine) throw new DesktopError('STORAGE_BUSY', '数据目录已变化，请重新操作');
      // 先让引擎原子处理配置、运行引用和内存密钥；失败时保留本机凭据，避免半删除。
      const deleted = await requestEngine.request('provider.delete', { providerId }) as Record<string, unknown>;
      requestEngine.forgetCredential(providerId);
      try { const local = await requestVault.remove(providerId); return { ...deleted, credentialRemoved: local.removed }; }
      catch { throw new DesktopError('CREDENTIAL_CLEANUP_FAILED', '接口已从引擎删除，但本机凭据清理失败；请重试清理'); }
    }).finally(() => { providerCredentialMutations.delete(providerId); credentialSaves--; });
    credentialPending = operation.catch(() => undefined);
    return operation;
  }
  if (['provider.save', 'resource.save', 'settings.save', 'project.update'].includes(validated.command) && containsSensitiveFields(payload)) {
    throw new DesktopError('SECRET_FIELD_DENIED', '凭据请通过 API Key 专用输入保存，不能写入普通配置或资源');
  }
  if (validated.command === 'settings.get') {
    const { localPythonPath, localModelGrants, mediaFfmpegPath, mediaFfprobePath, ...visiblePreferences } = preferenceStore.value;
    const desktop = { closeBehavior, updateManifestUrl: preferences.updateManifestUrl ?? '', desktop: { ...visiblePreferences, closeBehavior, dataLocation: '当前 Windows 用户的应用数据目录' } };
    try { return { ...await requestEngine.request(validated.command, payload) as object, ...desktop }; }
    catch { return { ...desktop, engineAvailable: false }; }
  }
  if (validated.command === 'settings.save') {
    const settings = payload.settings as Record<string, unknown>;
    const next = settings.closeBehavior ?? (settings.desktop as Record<string, unknown> | undefined)?.closeBehavior;
    if (next !== undefined && !['ask', 'tray', 'quit'].includes(String(next))) throw new DesktopError('INVALID_PAYLOAD', '关闭行为无效');
    if (settings.updateManifestUrl !== undefined) {
      if (typeof settings.updateManifestUrl !== 'string' || settings.updateManifestUrl.length > 8192) throw new DesktopError('UPDATE_URL_INVALID', '更新清单地址格式无效');
      if (settings.updateManifestUrl) validateUpdateUrl(settings.updateManifestUrl, allowLocalUpdateTest);
      if (['checking', 'downloading', 'verifying', 'installing'].includes(updates.status().state)) throw new DesktopError('UPDATE_BUSY', '更新操作进行中，请稍后保存设置');
    }
    // 数据目录与三类业务数据的落点由引擎一致性流程或专用命令管理，不能通过普通设置直接替换路径。
    if (Object.keys(settings).some(key => /path|dataDir|directory|credentialScope|root/i.test(key))) throw new DesktopError('SETTING_REQUIRES_MIGRATION', '此目录设置需要通过专门的数据迁移流程修改');
    const engineSettings = { ...settings }; delete engineSettings.desktop; delete engineSettings.updateManifestUrl; delete engineSettings.closeBehavior;
    const result = Object.keys(engineSettings).length ? await requestEngine.request(validated.command, { settings: engineSettings }) : {};
    preferences = await preferenceStore.update({ ...(next ? { closeBehavior: next } : {}), ...(settings.updateManifestUrl !== undefined ? { updateManifestUrl: settings.updateManifestUrl } : {}) });
    if (next) closeBehavior = next as typeof closeBehavior;
    if (settings.updateManifestUrl !== undefined) updates.configure(settings.updateManifestUrl as string);
    return { ...result as object, closeBehavior, updateManifestUrl: preferences.updateManifestUrl ?? '' };
  }
  const timeout = validated.command === 'local.model.load' ? Number(payload.timeoutMs ?? 120000) + 10000 : validated.command === 'media.video.inspect' ? 610000 : undefined;
  const result = await requestEngine.request(validated.command, payload, timeout);
  if (validated.command.startsWith('local.') || validated.command.startsWith('media.')) return publicInputResult(result);
  if (validated.command === 'run.result.get') return publicInputResult(result);
  if (validated.command === 'run.get' && (result as Record<string, unknown>)?.kind === 'local') return publicInputResult(result);
  if (validated.command === 'run.list' && Array.isArray(result)) return result.map(run => run.kind === 'local' ? publicInputResult(run) : run);
  if (validated.command === 'provider.list' && Array.isArray(result)) {
    let stored = new Set<string>();
    try { stored = new Set(await requestVault.providerIds()); } catch { requestEngine.log('当前数据作用域的凭据存储无法读取，请重新绑定'); }
    return result.map(provider => ({ ...provider, hasCredential: stored.has(provider.id) && requestEngine.hasCredential(provider.id) }));
  }
  return result;
}

function registerIpc(): void {
  handle('autolabel:request', (_event, command, payload) => request(command, payload));
  handle('autolabel:engine-status', () => engine.status);
  handle('autolabel:restart-engine', async () => {
    // 连点会反复杀启 JVM 并反复占用数据目录，加最小间隔；重复请求直接返回当前状态。
    if (Date.now() - engineRestartedAt < 5000) return engine.status;
    if (installingUpdate || storage?.busy || credentialSaves || localExecution.busy || mediaExecution.busy) throw new DesktopError('STORAGE_BUSY', '更新、配置保存或数据维护正在进行');
    const result = await engine.restart();
    engineRestartedAt = Date.now();
    if (result.state === 'ready') { localExecution.uncertain = false; mediaExecution.uncertain = false; preferences = await preferenceStore.update({ dataEstablished: true }); }
    return result;
  });
  handle('autolabel:window-dirty', (_event, dirty) => {
    if (typeof dirty !== 'boolean') throw new DesktopError('INVALID_PAYLOAD', '窗口状态无效');
    rendererDirty = dirty;
  });
  /**
   * 拖入对话的文件与文件选择器同属用户显式动作，按同样的规则登记授权。
   * 白名单取 shared/mediaFormats：与选择器、目录扫描共用一份，图片收紧到引擎真正能收的 jpg/jpeg/png。
   *
   * 拒绝项返回 `{name, reason}` 而不是文件名数组，超量也不抛原始错误码：
   * 界面上「暂不支持这些文件：images」既分不清是格式问题还是数量问题，也没有下一步。
   * 目录按 kind:'directory' 授权，交由引擎递归收集。
   */
  handle('autolabel:grant-dropped-files', async (_event, values) => {
    if (!Array.isArray(values) || !values.length) return { granted: [], rejected: [], overLimit: { limit: DROP_FILE_LIMIT, received: 0 } };
    if (values.length > DROP_FILE_LIMIT) return { granted: [], rejected: [], overLimit: { limit: DROP_FILE_LIMIT, received: values.length } };
    const granted: string[] = []; const rejected: Array<{ name: string; reason: string }> = [];
    for (const value of values) {
      if (typeof value !== 'string' || !value || value.length > 32767 || !path.isAbsolute(value)) { rejected.push({ name: String(value).slice(0, 200), reason: 'invalid_path' }); continue; }
      try {
        const info = await stat(value);
        const display = path.basename(value) || value;
        // 文件夹按目录授权，由引擎按 jpg/jpeg/png 递归收集；单文件按扩展名判定。
        if (info.isDirectory()) { granted.push(await grants.add(value, 'directory')); continue; }
        if (!info.isFile()) { rejected.push({ name: display, reason: 'unsupported_extension' }); continue; }
        const kind = isImagePath(value) ? 'images' : isVideoPath(value) ? 'video' : '';
        if (!kind) { rejected.push({ name: display, reason: 'unsupported_extension' }); continue; }
        granted.push(await grants.add(value, kind));
      } catch { rejected.push({ name: path.basename(value) || String(value).slice(0, 200), reason: 'invalid_path' }); }
    }
    return { granted, rejected };
  });
  /**
   * 列出已授权目录里的可用素材。
   *
   * 渲染层拿不到文件系统，而「选了文件夹却静默少收素材」正是最隐蔽的一类失败：
   * 引擎的目录扫描只收 jpg/jpeg/png，界面若不知道文件夹里还有什么，就只能报一个偏小的导入数。
   * 这里按与引擎一致的规则（递归 12 层、上限 10000）走一遍，把「有多少个文件用不上」如实回给界面。
   * 只读已授权目录，不新增授权。
   */
  handle('autolabel:list-directory', async (_event, options) => {
    const parsed = directoryScanSchema.safeParse(options);
    if (!parsed.success) throw new DesktopError('INVALID_PAYLOAD', '目录扫描参数无效');
    const { kind } = parsed.data;
    const directory = await grants.require(parsed.data.path, ['directory']);
    const match = kind === 'images' ? isImagePath : isVideoPath;
    // 视频候选是给用户挑的清单，不需要把上限用完；图片侧仍按引擎的导入上限统计，好让「有多少用不上」准确。
    const limit = kind === 'video' ? MEDIA_LIST_LIMIT : DIRECTORY_SCAN_MAX_FILES;
    const files: string[] = []; let unsupported = 0; let truncated = false;
    const walk = async (current: string, depth: number): Promise<void> => {
      if (truncated || depth > DIRECTORY_SCAN_MAX_DEPTH) return;
      let entries;
      try { entries = await readdir(current, { withFileTypes: true }); }
      catch { return; }
      for (const entry of entries) {
        if (truncated) return;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) { await walk(full, depth + 1); continue; }
        if (!entry.isFile()) continue;
        if (match(full)) {
          if (files.length >= limit) { truncated = true; return; }
          files.push(full);
        } else unsupported++;
      }
    };
    await walk(directory, 1);
    // 视频命令要求逐个文件授权（「目录授权不扩大到视频」是刻意的边界，见 security.test），
    // 所以把用户刚刚选中的文件夹里的视频一并登记；图片不必登记，asset.import 本身就接受目录授权。
    if (kind === 'video') for (const file of files) await grants.add(file, 'video');
    return { directory, files, unsupported, truncated };
  });
  handle('autolabel:choose-files', async (_event, options) => {
    const parsed = fileSelectionSchema.safeParse(options);
    if (!parsed.success) throw new DesktopError('INVALID_PAYLOAD', '文件选择类型无效');
    const { kind, multiple } = parsed.data;
    const selectionEngine = engine; const selectionScope = preferenceStore.value.credentialScopeId as string;
    const authorize = async (value: string) => {
      if (storage?.busy || selectionEngine !== engine) throw new DesktopError('STORAGE_BUSY', '文件选择时数据目录已变化，请重新选择');
      const selected = await grants.add(value, kind);
      if (kind !== 'model') return selected;
      return localExecution.authorizeSelectedModel(selectionScope, selected, () => {
        if (storage?.busy || selectionEngine !== engine || shutdownStarted) throw new DesktopError('STORAGE_BUSY', '模型授权时数据目录已变化，请重新选择');
      }, selectionEngine);
    };
    if (dialogFixtures) return Promise.all((await dialogFixtures.take(kind)).map(authorize));
    const filters: Record<string, Electron.FileFilter[]> = {
      images: [{ name: `图片（${IMAGE_EXTENSIONS.map(value => value.toUpperCase()).join('、')}）`, extensions: [...IMAGE_EXTENSIONS] }],
      video: [{ name: '视频', extensions: [...VIDEO_EXTENSIONS] }],
      model: [{ name: '本地模型', extensions: ['pt', 'onnx'] }],
      python: [{ name: 'Python 解释器', extensions: ['exe'] }],
      ffmpeg: [{ name: 'FFmpeg 可执行文件', extensions: ['exe'] }],
      ffprobe: [{ name: 'FFprobe 可执行文件', extensions: ['exe'] }],
      backup: [{ name: '项目备份', extensions: ['zip', 'autolabel'] }],
      labels: [{ name: '标注数据', extensions: ['txt', 'json', 'yaml', 'yml', 'zip'] }],
    };
    const properties: OpenDialogOptions['properties'] = kind === 'directory' ? ['openDirectory', 'createDirectory'] : ['openFile'];
    if (multiple) properties.push('multiSelections');
    const result = await dialog.showOpenDialog(window!, { title: kind === 'directory' ? '选择文件夹' : kind === 'python' ? '选择 Python 解释器' : kind === 'ffmpeg' ? '选择 FFmpeg 可执行文件' : kind === 'ffprobe' ? '选择 FFprobe 可执行文件' : '选择素材文件', properties, filters: filters[kind] });
    if (result.canceled) return [];
    return Promise.all(result.filePaths.map(authorize));
  });
  handle('autolabel:save-file', async (_event, options) => {
    const parsed = saveFileSchema.safeParse(options);
    if (!parsed.success) throw new DesktopError('INVALID_PAYLOAD', '保存选项无效');
    const { title, defaultPath, extension } = parsed.data;
    if (dialogFixtures) { const [value] = await dialogFixtures.take('save'); return value ? grants.addOutput(value) : null; }
    const result = await dialog.showSaveDialog(window!, { title, defaultPath: defaultPath ? path.basename(defaultPath) : undefined,
      filters: extension ? [{ name: `${extension.toUpperCase()} 文件`, extensions: [extension] }] : undefined });
    // 新输出文件尚不存在，只授权已确认的父目录和精确文件名。
    return result.canceled || !result.filePath ? null : grants.addOutput(result.filePath);
  });
  handle('autolabel:transcode-video', async (_event, options) => {
    const parsed = transcodeSourceSchema.safeParse(options);
    if (!parsed.success) throw new DesktopError('INVALID_PAYLOAD', '转码请求无效');
    if (storage?.busy || installingUpdate || shutdownStarted) throw new DesktopError('STORAGE_BUSY', '数据目录或更新正在处理，请稍后重试');
    // 副本要按「视频来源」重新授权，后续 media.video.inspect / create 才能通过同一套路径校验。
    return { path: await grants.add(await transcoder.run(parsed.data.sourcePath, grants), 'video') };
  });
  handle('autolabel:discard-transcode', async (_event, options) => {
    const parsed = transcodeOutputSchema.safeParse(options);
    if (!parsed.success) throw new DesktopError('INVALID_PAYLOAD', '转码请求无效');
    await transcoder.discard(parsed.data.path);
  });
  handle('autolabel:open-path', async (_event, value) => {
    // 受管存储目录由应用自己确定，允许直接打开；其余路径仍必须先经文件选择器授权。
    const managed = storagePaths && [storagePaths.root, ...storagePaths.entries.map(entry => entry.path)]
      .some(entry => path.resolve(entry).toLowerCase() === path.resolve(String(value)).toLowerCase());
    const permitted = managed ? await realpath(String(value))
      : await grants.require(value, ['directory', 'images', 'video', 'model', 'backup', 'labels', 'output'], false);
    if ((await stat(permitted)).isDirectory()) {
      const error = await shell.openPath(permitted); if (error) throw new DesktopError('OPEN_PATH_FAILED', '文件夹无法打开');
    } else shell.showItemInFolder(permitted);
  });
  handle('autolabel:window-action', (_event, action) => {
    const parsed = windowActionSchema.safeParse(action);
    if (!parsed.success) throw new DesktopError('INVALID_PAYLOAD', '窗口操作无效');
    if (parsed.data === 'minimize') window?.minimize();
    if (parsed.data === 'maximize') window?.isMaximized() ? window.unmaximize() : window?.maximize();
    if (parsed.data === 'close') window?.close();
  });
}

async function saveDiagnostics(): Promise<{ saved: boolean }> {
  const result = await dialog.showSaveDialog(window!, { title: '保存脱敏诊断（不含图片、提示词、密钥和个人路径）', defaultPath: `自动标注诊断-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'JSON 诊断文件', extensions: ['json'] }] });
  if (result.canceled || !result.filePath) return { saved: false };
  await writeFile(result.filePath, JSON.stringify(await diagnostics(), null, 2));
  shell.showItemInFolder(result.filePath);
  return { saved: true };
}
async function registerProtocols(): Promise<void> {
  protocol.handle('autolabel-app', async req => {
    try {
      const url = new URL(req.url);
      if (req.method !== 'GET' || url.host !== 'app') return new Response(null, { status: 403 });
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      if (relative.includes('\\') || relative.includes('\0') || relative.split('/').includes('..')) return new Response(null, { status: 403 });
      const fallback = relative.startsWith('diagnostics/');
      const base = fallback ? path.join(root, 'desktop', 'fallback') : path.join(root, 'renderer', 'dist');
      const filename = path.resolve(base, fallback ? relative.slice('diagnostics/'.length) || 'index.html' : relative);
      if (!filename.startsWith(base + path.sep)) return new Response(null, { status: 403 });
      const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
      const type = mime[path.extname(filename)];
      if (!type) return new Response(null, { status: 403 });
      return new Response(await readFile(filename), { headers: { 'Content-Type': type, 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff' } });
    } catch { return new Response('页面资源尚未构建', { status: 404 }); }
  });
  protocol.handle('autolabel-media', async req => {
    try {
      if (storage?.busy) return new Response(null, { status: 503 });
      if (req.method !== 'GET' || (req.referrer && !isTrustedUrl(req.referrer, devOrigin))) return new Response(null, { status: 403 });
      const target = mediaTargetFromUrl(req.url);
      const response = await engine.media(target, req.signal);
      const mime = response.headers.get('content-type')?.split(';')[0];
      const allowedTypes = target.kind === 'asset' ? ['image/jpeg', 'image/png', 'image/webp'] : ['image/png'];
      if (!response.ok || !mime || !allowedTypes.includes(mime)) { await response.body?.cancel(); return new Response(null, { status: response.ok ? 415 : response.status }); }
      return new Response(response.body, { headers: { 'Content-Type': mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': devOrigin ?? 'autolabel-app://app' } });
    } catch { return new Response(null, { status: 403 }); }
  });
}
async function showDiagnostics(): Promise<void> { window?.show(); await window?.loadURL('autolabel-app://app/diagnostics/index.html'); }
async function loadRenderer(): Promise<void> {
  try {
    if (devOrigin) { await window!.loadURL(devOrigin); return; }
    await stat(path.join(root, 'renderer', 'dist', 'index.html'));
    await window!.loadURL('autolabel-app://app/index.html');
  } catch { engine.log('界面资源不可用，已打开独立启动诊断'); await showDiagnostics(); }
}
async function createWindow(): Promise<void> {
  window = new BrowserWindow({ title: '自动标注小助手', width: 1440, height: 940, minWidth: 1100, minHeight: 720,
    // 界面统一绘制标题栏，保留 Windows 原生缩放边缘与窗口阴影。
    frame: false, resizable: true, thickFrame: true, hasShadow: true,
    show: false, backgroundColor: '#f5f6f8', icon: iconPath, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false,
      nodeIntegrationInWorker: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, spellcheck: false },
  });
  window.once('ready-to-show', () => window?.show());
  // 软件渲染环境（本机 GPU 进程不可用）下首帧可能始终不提交，ready-to-show 不触发，
  // 兜底在页面加载完成后显示窗口，避免启动后只有托盘图标、窗口不可见。
  window.webContents.once('did-finish-load', () => { if (window && !window.isVisible()) window.show(); });
  window.webContents.on('did-start-loading', () => { rendererDirty = false; });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (!isTrustedUrl(url, devOrigin)) event.preventDefault(); });
  window.webContents.on('will-redirect', (event, url) => { if (!isTrustedUrl(url, devOrigin)) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('render-process-gone', (_event, details) => { engine.log(`界面进程退出：${details.reason}`); });
  window.on('close', event => {
    if (quitting) return;
    event.preventDefault();
    if (rendererDirty) {
      if (askingClose) return;
      askingClose = true;
      void dialog.showMessageBox(window!, { type: 'warning', title: '修改尚未保存', message: '当前窗口有未保存的修改。',
        detail: '请选择取消返回设置，或明确放弃修改后继续关闭。', buttons: ['取消', '放弃并最小化到托盘', '放弃并退出'], defaultId: 0, cancelId: 0,
      }).then(result => {
        if (result.response === 0) return;
        rendererDirty = false;
        if (result.response === 1) window?.hide(); else app.quit();
      }).catch(() => engine.log('未保存设置关闭确认未能完成')).finally(() => { askingClose = false; });
      return;
    }
    if (closeBehavior === 'tray') { window?.hide(); return; }
    if (closeBehavior === 'quit') { app.quit(); return; }
    if (askingClose) return;
    askingClose = true;
    void dialog.showMessageBox(window!, { type: 'question', title: '关闭自动标注小助手', message: '关闭窗口后如何处理后台任务？',
      detail: '退出会停止新任务并等待引擎保存状态。已经发送的远端请求可能仍在处理。', buttons: ['最小化到托盘', '保存并退出', '取消'], defaultId: 0, cancelId: 2,
      checkboxLabel: '记住本次选择', checkboxChecked: false,
    }).then(async result => {
      if (result.response === 2) return;
      if (result.checkboxChecked) { closeBehavior = result.response === 0 ? 'tray' : 'quit'; preferences = await preferenceStore.update({ closeBehavior }); }
      if (result.response === 0) window?.hide(); else app.quit();
    }).catch(() => engine.log('关闭设置未能保存')).finally(() => { askingClose = false; });
  });
  window.on('closed', () => { window = undefined; });
  const menu = Menu.buildFromTemplate([
    { label: '应用', submenu: [{ label: '返回工作台', click: () => { void loadRenderer(); } }, { label: '独立启动诊断', click: () => { void showDiagnostics(); } }, { label: '保存脱敏诊断', click: () => { void saveDiagnostics().catch(() => engine.log('诊断文件保存失败')); } }, { type: 'separator' }, { label: '退出应用', click: () => app.quit() }] },
    { label: '编辑', submenu: [{ label: '撤销', role: 'undo' }, { label: '重做', role: 'redo' }, { type: 'separator' }, { label: '剪切', role: 'cut' }, { label: '复制', role: 'copy' }, { label: '粘贴', role: 'paste' }, { label: '全选', role: 'selectAll' }] },
    { label: '视图', submenu: [{ label: '重新加载界面', role: 'reload' }, { label: '重置缩放', role: 'resetZoom' }, { label: '放大', role: 'zoomIn' }, { label: '缩小', role: 'zoomOut' }, ...(!app.isPackaged ? [{ label: '开发者工具', role: 'toggleDevTools' as const }] : [])] },
  ]);
  Menu.setApplicationMenu(menu);
  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip('自动标注小助手');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开自动标注小助手', click: () => { window?.show(); window?.focus(); } }, { label: '启动诊断', click: () => { void showDiagnostics(); } }, { type: 'separator' }, { label: '保存并退出', click: () => app.quit() }]));
  tray.on('double-click', () => { window?.show(); window?.focus(); });
  await loadRenderer();
}

async function smoke(): Promise<void> {
  if (!process.argv.includes('--desktop-smoke')) return;
  const output = process.env.AUTOLABEL_SMOKE_OUTPUT;
  if (!output) return;
  await engine.start();
  if (process.argv.includes('--desktop-release-check')) {
    await checkPackagedRelease(window!, output, { packaged: app.isPackaged, appVersion: app.getVersion(), engineVersion: engine.status.version, engineState: engine.status.state });
    app.quit(); return;
  }
  if (manualCheck) {
    const { checkDesktopManual } = require(path.join(__dirname, 'manual.test.cjs'));
    await checkDesktopManual(window!, output); app.quit(); return;
  }
  if (process.argv.includes('--desktop-ui-resume')) { await checkPersistedUiEdit(window!, output); app.quit(); return; }
  if (process.argv.includes('--desktop-training-check')) {
    await checkTrainingUi(window!, output, {
      // 训练页验收用真实数据：示例项目 → 生成不可变数据集版本 → 从版本导出 → 冻结训练快照，
      // 使源码态与打包态都覆盖「生成 → 导出 → 训练」链路，而不是只验证导出这一环。
      prepareDataset: async () => {
        const directory = path.join(userData, 'training-fixtures');
        await mkdir(directory, { recursive: true });
        const example = await engine.request('project.example', {}) as { id: string };
        const created = await engine.request('dataset.version.create', { projectId: example.id, seed: `training-ui-${Date.now()}` }) as { id: string };
        let status = 'building';
        // 版本由引擎异步构建，这里按真实状态轮询，不假设固定耗时。
        for (let attempt = 0; attempt < 120 && status !== 'ready'; attempt++) {
          const state = await engine.request('dataset.version.get', { versionId: created.id }) as { status: string; failure?: { message?: string } };
          status = state.status;
          if (status === 'failed' || status === 'cancelled') throw new Error(`数据集版本生成未成功：${state.failure?.message ?? status}`);
          if (status !== 'ready') await new Promise(resolve => setTimeout(resolve, 500));
        }
        if (status !== 'ready') throw new Error('数据集版本生成超时');
        const exported = await engine.request('export.create', { projectId: example.id, outputDir: directory, annotationSelection: 'confirmed', datasetVersionId: created.id }) as { id: string };
        return await engine.request('training.dataset.create', { projectId: example.id, source: 'export', exportId: exported.id }) as Record<string, unknown>;
      },
    });
    app.quit(); return;
  }
  if (process.argv.includes('--desktop-connection-check')) { await checkDesktopConnection(window!, output, { stop: () => engine.stop(), restart: () => engine.restart() }); app.quit(); return; }
  if (process.argv.includes('--desktop-ui-check')) { await checkDesktopUi(window!, output); app.quit(); return; }
  if (process.argv.includes('--desktop-window-check')) {
    const inspect = async () => {
      const view = await window!.webContents.executeJavaScript(`({ title:document.title, headerCount:document.querySelectorAll('.topbar,.titlebar').length,
        drag:getComputedStyle(document.querySelector('.topbar,.titlebar')).getPropertyValue('-webkit-app-region'),
        controls:[...document.querySelectorAll('.window-actions button,.window-controls button')].map(b=>({label:b.getAttribute('aria-label'),region:getComputedStyle(b).getPropertyValue('-webkit-app-region')})) })`);
      const toggle = async (event: 'maximize' | 'unmaximize') => {
        const changed = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('窗口按钮响应超时')), 3000);
          const done = () => { clearTimeout(timer); resolve(); };
          if (event === 'maximize') window!.once('maximize', done); else window!.once('unmaximize', done);
        });
        await window!.webContents.executeJavaScript(`document.querySelector('[aria-label="最大化窗口"],[data-window="maximize"]').click()`);
        await changed;
      };
      window!.show(); await toggle('maximize'); view.maximized = window!.isMaximized();
      await toggle('unmaximize'); view.restored = !window!.isMaximized();
      return view;
    };
    const ui = await inspect();
    await window!.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await writeFile(output.replace(/\.json$/i, '') + '.png', (await window!.webContents.capturePage()).toPNG());
    await showDiagnostics(); const fallback = await inspect();
    await window!.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await writeFile(output.replace(/\.json$/i, '') + '-diagnostics.png', (await window!.webContents.capturePage()).toPNG());
    await writeFile(output, JSON.stringify({ ui, fallback, resizable: window!.isResizable(), updateStatus: updates.status() }, null, 2));
    app.quit(); return;
  }
  const result = await window!.webContents.executeJavaScript(`(async () => {
    const api = window.autoLabel;
    const result = { title: document.title, bodyLength: document.body.innerText.length, bridge: !!api, nodeExposed: typeof require !== 'undefined' || typeof process !== 'undefined' };
    if (!api) return result;
    result.status = await api.engineStatus(); result.diagnostics = await api.request('diagnostics.get');
    try { await api.request('engine.shutdown'); result.blockedCommand = false; } catch (error) { result.blockedCommand = error.message.includes('COMMAND_DENIED'); }
    try { await api.openPath('C:\\\\Windows'); result.blockedPath = false; } catch (error) { result.blockedPath = error.message.includes('PATH_DENIED'); }
    if (result.status.state === 'ready') { result.projects = await api.request('project.list'); result.snapshot = await api.request('event.snapshot'); }
    return result;
  })()`);
  if (process.env.AUTOLABEL_TEST_USER_DATA && result.status?.state === 'ready') {
    const integration = await window!.webContents.executeJavaScript(`(async () => {
      const api = window.autoLabel;
      const baseline = await api.request('event.snapshot');
      let unsubscribe;
      const eventReceived = new Promise(resolve => {
        const timer = setTimeout(() => { unsubscribe?.(); resolve(false); }, 5000);
        unsubscribe = api.onEvent(event => { if (event.sequence > baseline.sequence) { clearTimeout(timer); unsubscribe(); resolve(true); } });
      });
      const example = await api.request('project.example');
      const assets = await api.request('asset.list', { projectId: example.id, limit: 1 });
      const asset = assets.items[0];
      const media = await new Promise(resolve => { const image = new Image(); image.onload = () => resolve({ loaded: true, width: image.naturalWidth, height: image.naturalHeight }); image.onerror = () => resolve({ loaded: false }); image.src = asset.mediaUrl; });
      let workerResponded = false;
      try { await api.request('agent.chat', { sessionId: 'desktop-smoke', providerId: 'nonexistent-test-provider', model: 'test-model', messages: [{ role: 'user', content: '检查本地工作进程连通性' }] }); } catch (error) { workerResponded = !error.message.includes('AGENT_TIMEOUT'); }
      return { receivedCommittedEvent: await eventReceived, media, workerResponded };
    })()`);
    Object.assign(result, integration);
    const marker = 'desktop-vault-test-' + Date.now();
    const provider = await engine.request('provider.save', { name: '桌面凭据存储测试（未调用 API）', baseUrl: 'https://example.invalid/v1', protocol: 'chat-completions' }) as { id: string };
    const binding = await vault.set(provider.id, marker);
    await engine.setCredential(provider.id, marker, binding.credentialBindingVersion);
    const file = await readFile(vault.filename, 'utf8');
    result.credentialEncryptedAtRest = !file.includes(marker);
    result.credentialRoundtrip = (await vault.all()).some(value => value.providerId === provider.id && value.key === marker);
  }
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2));
  window!.show();
  await window!.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await writeFile(output.replace(/\.json$/i, '') + '.png', (await window!.webContents.capturePage()).toPNG());
  app.quit();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.restore(); window?.show(); window?.focus(); });
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    agent.stop();
    transcoder.stop();
    // 排队任务最多等 10 秒收敛，但引擎停止必须无条件执行：
    // 一旦某个 whenIdle 悬挂或拒绝就跳过 engine.stop()，会留下占用 autolabel.db 的 Java 孤儿进程，
    // 用户下次打开软件时数据目录被占用，表现为「引擎起不来」。
    const drain = (storage?.whenIdle(10000) ?? Promise.resolve()).then(() => credentialPending)
      .then(() => localExecution.whenIdle()).then(() => mediaExecution.whenIdle()).then(() => updates.shutdown());
    void Promise.race([drain.catch(() => undefined), new Promise(resolve => setTimeout(resolve, 10000))])
      .then(() => engine?.stop().catch(() => undefined))
      .finally(() => { quitting = true; tray?.destroy(); app.quit(); });
  });
  app.on('window-all-closed', () => { if (!quitting && !tray) app.quit(); });
/**
 * GPU 进程退出监控。
 *
 * 无显卡通道的机器上 Chromium 的 GPU 进程会直接挂掉，应用可能连窗口都没建好就退出，
 * 用户侧只看到「双击没反应」。这里把原因写进启动日志，并在窗口还没建好时明确提示，
 * 引导用降级开关启动——比静默退出强，也不假装启动成功了。
 */
let windowCreated = false;
let gpuFailureNotified = false;
app.on('child-process-gone', async (_event, details) => {
  if (details.type !== 'GPU') return;
  const reason = `${details.reason}${details.exitCode !== undefined ? `（退出码 ${details.exitCode}）` : ''}`;
  engine.log(`GPU 进程退出：${reason}`);
  await appendStartupLog(`GPU 进程退出：${reason}；窗口已创建：${windowCreated}`);
  // GPU 进程会连着重启几次，每次都弹窗会把用户埋在对话框里；只提示一次，日志保留全部。
  if (windowCreated || gpuFailureNotified || process.argv.includes('--desktop-smoke')) return;
  gpuFailureNotified = true;
  dialog.showErrorBox('图形加速不可用', `本机无法启动图形加速（${reason}），窗口未能创建。\n\n`
    + '请用管理员权限运行，或追加启动参数：--no-sandbox --in-process-gpu --disable-gpu\n\n'
    + `启动日志：${path.join(userData, 'startup.log')}`);
});

  void app.whenReady().then(async () => {
    await mkdir(userData, { recursive: true });
    // 上次会话留下的转码副本已经失去授权、也无法再被任何任务引用，开机即清。
    void transcoder.sweep();
    preferences = await preferenceStore.load();
    const initial = createBackend(await initializeStorageLocation(userData, preferenceStore));
    preferences = preferenceStore.value; setActiveStorage(initial);
    await refreshStoragePaths();
    storage = new DataStorage({ active: initial, create: createBackend,
      commit: async location => { preferences = await preferenceStore.update({ ...location, dataEstablished: true }); }, activate: setActiveStorage,
      guard: () => { if (installingUpdate || agent.activeCount || credentialSaves || localExecution.busy || mediaExecution.busy || shutdownStarted) throw new DesktopError('STORAGE_TASKS_ACTIVE', '请先完成对话、配置保存或更新，再维护数据目录'); },
    });
    if (['ask', 'tray', 'quit'].includes(String(preferences.closeBehavior))) closeBehavior = preferences.closeBehavior as typeof closeBehavior;
    try { updates.configure(typeof preferences.updateManifestUrl === 'string' ? preferences.updateManifestUrl : ''); } catch { engine.log('保存的更新清单地址无效，请在设置中重新配置'); }
    if (app.isPackaged) {
      try {
        const identity = await readExecutableIdentity(process.execPath);
        if (identity.signature === 'Valid' && identity.publisher) { publisher = identity.publisher; publisherChecked = true; }
        else if (identity.signature === 'NotSigned') publisherChecked = true;
      } catch { engine.log('当前程序发布者签名无法读取；更新安装已禁用，请重新启动后再试'); }
    }
    void updates.restore();
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.on('will-download', event => event.preventDefault());
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } }));
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      let media = false;
      try { mediaTargetFromUrl(details.url); media = true; } catch { /* 普通页面请求继续按来源白名单校验。 */ }
      const allowed = isTrustedUrl(details.url, devOrigin) || media || details.url.startsWith('data:') || details.url.startsWith('blob:') || (!!devOrigin && details.url.startsWith(devOrigin.replace('http:', 'ws:') + '/'));
      callback({ cancel: !allowed });
    });
    registerIpc(); await registerProtocols();
    // 先出窗口再启动引擎：Java 冷启动最坏要等满 30 秒握手超时，串行等待会让用户以为「双击没反应」。
    // engine.start() 在第一个 await 之前就同步把状态置为 starting，窗口订阅后即可显示「引擎启动中」。
    const engineStarted = engine.start();
    await createWindow();
    windowCreated = true;
    void engineStarted.then(async started => { if (started.state === 'ready') preferences = await preferenceStore.update({ dataEstablished: true }); });
    // 休眠/唤醒不得因为存储忙而丢事件：suspend 期间跳过可以，resume 必须送达，
    // 否则引擎会一直停在「已休眠」状态、事件流永久空转，界面只能靠手动重连恢复。
    powerMonitor.on('suspend', () => { if (!storage?.busy) void engine.suspend(); });
    powerMonitor.on('resume', () => { void engine.resume(); });
    if (process.argv.includes('--desktop-smoke')) await smoke();
  }).catch(async error => {
    // 双击启动的用户看不到控制台：把失败写进 startup.log，并在提示里直接给出路径。
    await appendStartupLog(`启动失败：${redact(error)}`);
    if (process.argv.includes('--desktop-smoke')) { console.error(redact(error)); app.exit(1); return; }
    dialog.showErrorBox('桌面程序启动失败', `${redact(error)}\n\n启动日志：${path.join(userData, 'startup.log')}`);
    quitting = true; app.quit();
  });
}
