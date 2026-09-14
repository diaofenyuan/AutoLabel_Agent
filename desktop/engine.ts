import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { access, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { PROTOCOL_VERSION, type EngineStatus } from '../shared/protocol';
import { DesktopError } from './validation';
import { redact, normalizeMedia, type MediaTarget } from './security';
import { SseDecoder } from './sse';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function exists(value: string): Promise<boolean> { try { await access(value); return true; } catch { return false; } }

export interface EngineOptions {
  packaged: boolean; root: string; resources: string; dataDir: string;
  credentials: () => Promise<Array<{ providerId: string; key: string; credentialBindingVersion?: string }>>;
  requireExistingData?: boolean;
  localPythonPath?: () => Promise<string | undefined>;
  /** 受管原图目录（存储根下的 uploads）；缺省时引擎沿用 <数据目录>/originals。 */
  materialsRoot?: () => string | undefined;
  /** 训练产物目录；缺省时引擎沿用 <数据目录>/training。 */
  trainingRoot?: () => string | undefined;
  localModelAuthorizations?: () => Promise<Array<{ path: string; modelHash: string }>>;
  mediaToolPaths?: () => Promise<{ ffmpegPath?: string; ffprobePath?: string }>;
}

export class EngineManager extends EventEmitter {
  status: EngineStatus = { state: 'stopped' };
  private child?: ChildProcessWithoutNullStreams;
  private token = '';
  private port = 0;
  private starting?: Promise<EngineStatus>;
  private restarting?: Promise<EngineStatus>;
  private stopPromise?: Promise<void>;
  private injectedProviders = new Set<string>();
  private stopping = false;
  private suspended = false;
  private streamAbort?: AbortController;
  private cursor = 0;
  private generation = 0;
  private logs: Array<{ at: string; message: string }> = [];
  private activeControllers = new Set<AbortController>();
  private secretValues: string[] = [];
  private lastEventAt?: string;
  private runtimeFound = false;
  private jarFound = false;
  private dataIdentity?: { canonical: string; dev: number; ino: number };
  private dataEstablished = false;

  constructor(private options: EngineOptions) { super(); }
  private async validateDataDirectory(): Promise<void> {
    try {
      if (!this.dataIdentity && !this.options.requireExistingData) await mkdir(this.options.dataDir, { recursive: true });
      const canonical = await realpath(this.options.dataDir); const info = await stat(canonical);
      if (!info.isDirectory() || canonical.toLowerCase() !== path.resolve(this.options.dataDir).toLowerCase()
        || (this.dataIdentity && (this.dataIdentity.canonical !== canonical || this.dataIdentity.dev !== info.dev || this.dataIdentity.ino !== info.ino))) throw new Error();
      if (this.dataEstablished || this.options.requireExistingData) {
        const database = path.join(canonical, 'autolabel.db');
        if (!(await stat(database)).isFile() || (await realpath(database)).toLowerCase() !== database.toLowerCase()) throw new Error();
      }
      this.dataIdentity = { canonical, dev: info.dev, ino: info.ino };
    } catch { throw new DesktopError('STORAGE_LOCATION_MISSING', '数据目录或数据库失联、身份已变化；未创建空数据库'); }
  }
  private setStatus(status: EngineStatus): void { this.status = status; this.emit('status', status); }
  log(message: unknown): void {
    this.logs.push({ at: new Date().toISOString(), message: redact(message, [this.token, ...this.secretValues]) });
    if (this.logs.length > 80) this.logs.shift();
  }
  diagnostics(): Record<string, unknown> {
    return { engine: this.status, runtimeFound: this.runtimeFound, jarFound: this.jarFound,
      eventSequence: this.cursor, lastEventAt: this.lastEventAt ?? null, suspended: this.suspended, logs: [...this.logs] };
  }
  private async locate(): Promise<{ java: string; jar: string }> {
    const javaName = process.platform === 'win32' ? 'java.exe' : 'java';
    const jar = this.options.packaged ? path.join(this.options.resources, 'engine', 'autolabel-engine.jar')
      : process.env.AUTOLABEL_ENGINE_JAR ? path.resolve(process.env.AUTOLABEL_ENGINE_JAR) : path.join(this.options.root, 'engine', 'build', 'autolabel-engine.jar');
    this.jarFound = await exists(jar);
    let homes = [path.join(this.options.packaged ? this.options.resources : this.options.root, 'runtime')];
    if (!this.options.packaged) {
      homes.push(path.join(this.options.root, 'engine', 'build', 'runtime'), path.join(this.options.root, 'build', 'runtime'));
      try { homes.push((await readFile(path.join(this.options.root, 'engine', 'build', 'runtime-path.txt'), 'utf8')).trim()); } catch { /* 引擎构建尚未完成时继续诊断其他候选。 */ }
      if (process.env.AUTOLABEL_JAVA_HOME) homes.push(process.env.AUTOLABEL_JAVA_HOME);
      if (process.env.JAVA_HOME) homes.push(process.env.JAVA_HOME);
    }
    const java = (await Promise.all(homes.filter(Boolean).map(async home => {
      const candidate = path.join(home, 'bin', javaName);
      return await exists(candidate) ? candidate : undefined;
    }))).find(Boolean);
    this.runtimeFound = !!java;
    if (!java) throw new DesktopError('JAVA_RUNTIME_MISSING', this.options.packaged ? '安装包内的 Java 运行时缺失，请重新安装应用' : '未找到 Java 21 运行时，请先运行引擎环境准备与 prepare:runtime');
    if (!this.jarFound) throw new DesktopError('ENGINE_JAR_MISSING', this.options.packaged ? 'Java 引擎产物缺失，请重新安装应用' : 'Java 引擎产物缺失，请在项目根目录运行 npm run build:engine');
    return { java, jar };
  }
  async start(): Promise<EngineStatus> {
    if (this.stopPromise) await this.stopPromise;
    if (this.starting) return this.starting;
    // SSE 断连不代表 Java 已退出，已有子进程只能经显式 restart 停止后再启动。
    if (this.child) return this.status;
    this.starting = this.startInternal().finally(() => { this.starting = undefined; });
    return this.starting;
  }
  private async startInternal(): Promise<EngineStatus> {
    this.setStatus({ state: 'starting', message: '正在启动本地引擎' });
    this.stopping = false; this.cursor = 0; this.port = 0; this.injectedProviders.clear();
    const generation = ++this.generation;
    try {
      const { java, jar } = await this.locate();
      await this.validateDataDirectory();
      // 开发验收可明确使用冻结脚本；安装包始终只读取自身资源，不能受环境变量替换。
      const localWorkerDirectory = this.options.packaged ? path.join(this.options.resources, 'inference')
        : process.env.AUTOLABEL_INFERENCE_DIR ? path.resolve(process.env.AUTOLABEL_INFERENCE_DIR) : path.join(this.options.root, 'inference');
      const localWorkerPath = path.join(localWorkerDirectory, 'worker.py');
      // 训练脚本与推理脚本同目录；打包放行前缺失时引擎会把环境探测标为不可用而不是崩溃。
      const trainingWorkerPath = path.join(localWorkerDirectory, 'train_worker.py');
      const localPythonPath = await this.options.localPythonPath?.();
      const materialsRoot = this.options.materialsRoot?.();
      const trainingRoot = this.options.trainingRoot?.();
      const mediaTools = await this.options.mediaToolPaths?.() ?? {};
      let localModelAuthorizations = await this.options.localModelAuthorizations?.() ?? [];
      if (localModelAuthorizations.length > 500 || Buffer.byteLength(JSON.stringify(localModelAuthorizations)) > 7 * 1024 * 1024) {
        localModelAuthorizations = []; this.log('本地模型授权列表超过启动限额，本次未加载模型授权；普通图片与 API 功能仍可使用，请重新选择需要的模型');
      }
      this.token = randomBytes(32).toString('hex');
      // 清除 JVM 注入变量；密钥只写入受控 stdin 和鉴权回环请求。
      const env = { ...process.env };
      for (const key of ['JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'CLASSPATH']) delete env[key];
      const child = spawn(java, ['-Dfile.encoding=UTF-8', '-jar', jar], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env, cwd: this.options.dataDir });
      this.child = child;
      child.stdin.on('error', () => this.log('引擎启动输入通道已关闭'));
      let stderrBuffer = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderrBuffer += chunk;
        const lines = stderrBuffer.split(/\r?\n/); stderrBuffer = lines.pop()?.slice(-8000) ?? '';
        for (const line of lines) if (line.trim()) this.log(line);
      });
      child.once('exit', (code, signal) => {
        if (generation !== this.generation) return;
        this.child = undefined; this.port = 0; this.streamAbort?.abort(); this.injectedProviders.clear();
        for (const controller of this.activeControllers) controller.abort();
        if (!this.stopping) this.setStatus({ state: 'error', message: `本地引擎已退出（${code ?? signal ?? '未知'}），请查看诊断；不会自动重发任务` });
      });
      const ready = await new Promise<{ port: number; version: string; protocolVersion: number }>((resolve, reject) => {
        const timeout = setTimeout(() => { clean(); reject(new DesktopError('ENGINE_START_TIMEOUT', '本地引擎在 30 秒内未就绪')); }, 30000);
        const lines = createInterface({ input: child.stdout });
        let total = 0;
        const clean = () => { clearTimeout(timeout); lines.close(); child.off('error', onError); child.off('exit', onExit); };
        const onError = (error: Error) => { clean(); reject(error); };
        const onExit = () => { clean(); reject(new DesktopError('ENGINE_START_FAILED', 'Java 引擎启动失败，请检查运行时版本与引擎日志')); };
        child.once('error', onError); child.once('exit', onExit);
        lines.on('line', line => {
          total += line.length;
          if (total > 65536) { clean(); reject(new DesktopError('ENGINE_BAD_HANDSHAKE', '引擎就绪消息超出限制')); return; }
          try {
            const value = JSON.parse(line);
            if (value.type !== 'ready') return;
            if (value.protocolVersion !== PROTOCOL_VERSION || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || typeof value.version !== 'string') throw new DesktopError('PROTOCOL_MISMATCH', '桌面程序与 Java 引擎协议不匹配，请完整升级应用');
            clean(); resolve(value);
          } catch (error) { if (error instanceof DesktopError) { clean(); reject(error); } }
        });
        child.stdin.write(JSON.stringify({ token: this.token, dataDir: this.options.dataDir, protocolVersion: PROTOCOL_VERSION, localWorkerPath, trainingWorkerPath, localModelAuthorizations,
          ...(materialsRoot ? { materialsRoot } : {}),
          ...(trainingRoot ? { trainingRoot } : {}),
          ...(localPythonPath ? { localPythonPath } : {}), ...(mediaTools.ffmpegPath ? { mediaFfmpegPath: mediaTools.ffmpegPath } : {}),
          ...(mediaTools.ffprobePath ? { mediaFfprobePath: mediaTools.ffprobePath } : {}) }) + '\n');
      });
      this.port = ready.port;
      await this.fetchJson('/health', undefined, 5000);
      this.dataEstablished = true;
      await this.restoreCredentials();
      this.setStatus({ state: 'ready', version: ready.version, protocolVersion: ready.protocolVersion });
      void this.events(generation);
    } catch (error) {
      this.stopping = true;
      if (this.child) {
        this.child.kill();
        try { await waitForEngineExit(this.child, 5000); } catch { this.log('启动失败后的 Java 尚未确认退出，禁止继续启动其他实例'); }
      }
      this.port = 0; this.injectedProviders.clear();
      const message = redact(error instanceof Error ? error.message : error, [this.token, ...this.secretValues]);
      this.log(message);
      this.setStatus({ state: 'error', message });
    }
    return this.status;
  }
  async restoreCredentials(): Promise<void> {
    try {
      const credentials = await this.options.credentials();
      this.secretValues = credentials.map(value => value.key);
      for (const credential of credentials) {
        try { await this.setCredential(credential.providerId, credential.key, credential.credentialBindingVersion); }
        catch { this.log('一个接口凭据未能注入，请在模型中心重新绑定'); }
      }
    } catch (error) { this.log('凭据尚未注入引擎，请在模型中心重新保存；' + (error instanceof DesktopError ? error.code : 'CREDENTIAL_UNAVAILABLE')); }
  }
  async setCredential(providerId: string, key: string, credentialBindingVersion?: string): Promise<void> {
    this.injectedProviders.delete(providerId);
    if (!this.secretValues.includes(key)) this.secretValues.push(key);
    await this.request('credential.set', { providerId, key, ...(credentialBindingVersion !== undefined ? { credentialBindingVersion } : {}) }, 10000);
    this.injectedProviders.add(providerId);
  }
  hasCredential(providerId: string): boolean { return this.injectedProviders.has(providerId); }
  forgetCredential(providerId: string): void { this.injectedProviders.delete(providerId); }
  async request(command: string, payload: Record<string, unknown> = {}, timeout = 120000): Promise<unknown> {
    const response = await this.fetchJson('/command', { command, payload }, timeout) as { ok: boolean; data?: unknown; error?: { code: string; message: string } };
    if (response.ok !== true) throw new DesktopError(response.error?.code ?? 'ENGINE_COMMAND_FAILED', redact(response.error?.message ?? '引擎操作失败', [this.token, ...this.secretValues]));
    return normalizeMedia(response.data);
  }
  private async fetchJson(endpoint: string, body?: unknown, timeout = 10000): Promise<unknown> {
    if (!this.port) throw new DesktopError('ENGINE_UNAVAILABLE', this.status.message ?? '本地引擎尚未就绪');
    const controller = new AbortController(); this.activeControllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}${endpoint}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal, redirect: 'error',
      });
      const reader = response.body?.getReader();
      if (!reader) throw new DesktopError('ENGINE_BAD_RESPONSE', '引擎没有返回数据');
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length;
        if (size > 32 * 1024 * 1024) { await reader.cancel(); throw new DesktopError('ENGINE_RESPONSE_TOO_LARGE', '引擎返回内容过大，请缩小查询范围'); } chunks.push(value); }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!response.ok && result.ok !== false) throw new DesktopError('ENGINE_HTTP_ERROR', `本地通信失败（${response.status}）`);
      return result;
    } catch (error) {
      if (error instanceof DesktopError) throw error;
      throw new DesktopError(controller.signal.aborted ? 'ENGINE_TIMEOUT' : 'ENGINE_DISCONNECTED', controller.signal.aborted ? '操作等待超时；已发送请求的结果需要查询确认，请勿盲目重发' : '本地引擎连接中断，请查看诊断');
    } finally { clearTimeout(timer); this.activeControllers.delete(controller); }
  }
  async media(target: MediaTarget, signal: AbortSignal): Promise<Response> {
    if (!this.port) return new Response('引擎未就绪', { status: 503 });
    if (target.kind === 'input') {
      const image = await this.request('flow.input.image', { inputId: target.inputId }, 30000) as Record<string, unknown>;
      signal.throwIfAborted();
      if (image.inputId !== target.inputId || typeof image.assetId !== 'string' || typeof image.path !== 'string' || !path.isAbsolute(image.path)
        || image.mimeType !== 'image/png' || typeof image.contentHash !== 'string' || !/^[a-f0-9]{64}$/i.test(image.contentHash)
        || !Number.isInteger(image.width) || Number(image.width) < 1 || !Number.isInteger(image.height) || Number(image.height) < 1) {
        throw new DesktopError('MEDIA_DENIED', '模型输入与请求身份不一致');
      }
      const root = await realpath(this.options.dataDir); const filename = await realpath(image.path);
      let managed = false;
      for (const name of ['media', 'flow-inputs']) {
        try {
          const directory = await realpath(path.join(root, name));
          if (directory.startsWith(root + path.sep) && filename.startsWith(directory + path.sep)) managed = true;
        } catch { /* 未生成对应类型的输入时目录可以不存在。 */ }
      }
      if (!managed || path.extname(filename).toLowerCase() !== '.png' || !(await stat(filename)).isFile()) throw new DesktopError('MEDIA_DENIED', '模型输入不在受管图片目录');
      const stream = createReadStream(filename, { signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { headers: { 'Content-Type': 'image/png' } });
    }
    if (target.kind === 'resource') {
      // 文件路径只由内部命令提供；版本绑定与实际目录再次核验后才建立图片流。
      const image = await this.request('resource.image', { resourceId: target.resourceId, version: target.version }, 30000) as Record<string, unknown>;
      signal.throwIfAborted();
      if (image.resourceId !== target.resourceId || image.resourceVersion !== target.version || typeof image.path !== 'string'
        || !path.isAbsolute(image.path) || typeof image.contentHash !== 'string' || !/^[a-f0-9]{64}$/i.test(image.contentHash)) {
        throw new DesktopError('MEDIA_DENIED', '参考图片版本与请求不一致');
      }
      const root = await realpath(this.options.dataDir);
      const directory = await realpath(path.join(this.options.dataDir, 'resource-library'));
      const filename = await realpath(image.path);
      if (!directory.startsWith(root + path.sep) || !filename.startsWith(directory + path.sep) || !(await stat(filename)).isFile()) {
        throw new DesktopError('MEDIA_DENIED', '参考图片不在受管资源目录');
      }
      const stream = createReadStream(filename, { signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { headers: { 'Content-Type': 'image/png' } });
    }
    const route = target.kind === 'evaluation' ? `/evaluation-media/${target.setVersionId}/${target.assetId}` : `/media/${target.assetId}`;
    return fetch(`http://127.0.0.1:${this.port}${route}`, { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]), redirect: 'error' });
  }
  private async events(generation: number): Promise<void> {
    let retry = 500;
    while (generation === this.generation && this.child && !this.stopping) {
      if (this.suspended) { await sleep(500); continue; }
      const controller = new AbortController(); this.streamAbort = controller;
      let watchdog: NodeJS.Timeout | undefined;
      const touch = () => { if (watchdog) clearTimeout(watchdog); watchdog = setTimeout(() => controller.abort(), 45000); };
      try {
        touch();
        const response = await fetch(`http://127.0.0.1:${this.port}/events?after=${this.cursor}`, { headers: { Authorization: `Bearer ${this.token}`, Accept: 'text/event-stream' }, signal: controller.signal, redirect: 'error' });
        if (response.status === 409 || response.status === 410) {
          const snapshot = await this.request('event.snapshot') as { sequence: number };
          if (!Number.isSafeInteger(snapshot.sequence)) throw new Error('INVALID_SNAPSHOT');
          this.cursor = snapshot.sequence;
          this.setStatus({ ...this.status, state: 'disconnected', message: '事件历史已更新，正在重新同步状态快照' });
          continue;
        }
        if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('SSE_UNAVAILABLE');
        this.setStatus({ ...this.status, state: 'ready', message: undefined }); retry = 500;
        const reader = response.body.getReader(); const decoder = new TextDecoder(); const parser = new SseDecoder();
        while (true) {
          const { done, value } = await reader.read(); if (done) break; touch();
          for (const event of parser.push(decoder.decode(value, { stream: true }))) {
            if (event.sequence <= this.cursor) continue;
            this.cursor = event.sequence; this.lastEventAt = new Date().toISOString(); this.emit('event', normalizeMedia(event));
          }
        }
        if (!this.stopping) throw new Error('SSE_CLOSED');
      } catch {
        if (generation === this.generation && this.child && !this.stopping && !this.suspended) this.setStatus({ ...this.status, state: 'disconnected', message: '实时事件连接中断，正在补齐；已发送请求不会重复提交' });
      } finally { if (watchdog) clearTimeout(watchdog); controller.abort(); }
      if (!this.stopping) await sleep(retry); retry = Math.min(retry * 2, 10000);
    }
  }
  async suspend(): Promise<void> {
    this.suspended = true; this.streamAbort?.abort();
    try { await this.request('system.suspend', {}, 3000); } catch { this.log('休眠协调未完成；恢复时必须根据持久化状态核对在途请求'); }
    this.setStatus({ ...this.status, state: 'disconnected', message: '系统已休眠，恢复后将核对任务状态' });
  }
  async resume(): Promise<void> {
    this.suspended = false;
    if (!this.child) return;
    try {
      await this.fetchJson('/health');
      // 只展示引擎核对结果，不在这里假定事件流已恢复；连接状态仍由 SSE 循环决定。
      const report = await this.request('system.resume', {}, 10000) as { suspendedMs?: number; checks?: { unknownResults?: number; pausedRuns?: number; interruptedTrackGenerations?: number; interruptedMediaJobs?: number } };
      const checks = report?.checks ?? {};
      this.log(`唤醒核对完成：未知结果 ${checks.unknownResults ?? 0}，暂停运行 ${checks.pausedRuns ?? 0}，中断轨迹生成 ${checks.interruptedTrackGenerations ?? 0}，中断媒体任务 ${checks.interruptedMediaJobs ?? 0}；未自动重发任何请求`);
      this.setStatus({ ...this.status, message: (checks.unknownResults ?? 0) > 0 ? '唤醒后仍有结果未知的调用，请确认是否重试；任务原状态已保留' : '唤醒后已核对任务状态，未自动重发请求' });
    }
    catch { this.log('唤醒后引擎或任务状态需检查；未自动重发任何请求'); }
  }
  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopInternal().finally(() => { this.stopPromise = undefined; });
    return this.stopPromise;
  }
  private async stopInternal(): Promise<void> {
    if (this.starting) await this.starting;
    this.stopping = true; this.streamAbort?.abort();
    this.injectedProviders.clear();
    const child = this.child;
    if (child && child.exitCode === null) {
      try { await this.request('engine.shutdown', {}, 4000); } catch { this.log('引擎正常退出未响应，执行有限等待后的进程清理'); }
      try { await waitForEngineExit(child, 2500); }
      catch { child.kill(); await waitForEngineExit(child, 5000); }
    }
    ++this.generation; this.child = undefined; this.port = 0;
    for (const controller of this.activeControllers) controller.abort();
    this.setStatus({ state: 'stopped' });
  }
  async restart(): Promise<EngineStatus> {
    if (this.restarting) return this.restarting;
    this.restarting = (async () => { if (this.starting) await this.starting; await this.stop(); return this.start(); })().finally(() => { this.restarting = undefined; });
    return this.restarting;
  }
}

export async function waitForEngineExit(child: Pick<ChildProcessWithoutNullStreams, 'exitCode' | 'signalCode' | 'once' | 'off'>, timeout: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const done = () => { clearTimeout(timer); child.off('exit', done); resolve(); };
    const timer = setTimeout(() => { child.off('exit', done); reject(new DesktopError('ENGINE_STOP_TIMEOUT', 'Java 进程尚未退出，已阻止切换数据目录')); }, timeout);
    child.once('exit', done);
    if (child.exitCode !== null || child.signalCode !== null) done();
  });
}
