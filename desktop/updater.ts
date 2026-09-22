import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, stat, statfs, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { DesktopError } from './validation';

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?$/;
const manifestSchema = z.strictObject({ schemaVersion: z.literal(1), appId: z.literal('com.autolabel.assistant'),
  platform: z.literal('win32'), arch: z.literal('x64'), version: z.string().max(80).regex(versionPattern),
  releaseNotes: z.string().max(32000), downloadUrl: z.string().max(8192), sha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
  size: z.number().int().positive().max(2 * 1024 ** 3), publishedAt: z.iso.datetime({ offset: true }).optional() });
export type UpdateManifest = z.infer<typeof manifestSchema>;
/** 官方默认更新清单（GitHub Release 固定文件名）；用户可在设置里覆盖，保存空值则显式关闭更新。 */
export const DEFAULT_UPDATE_MANIFEST_URL = 'https://github.com/diaofenyuan/AutoLabel_Agent/releases/latest/download/update-manifest.json';
export interface UpdateStatus {
  state: 'unconfigured' | 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'verifying' | 'ready' | 'cancelled' | 'error' | 'installing';
  currentVersion: string;
  release?: Pick<UpdateManifest, 'version' | 'releaseNotes' | 'size' | 'publishedAt'>;
  downloadedBytes: number; totalBytes?: number; error?: { code: string; message: string };
}
interface UpdaterOptions {
  directory: string; currentVersion: string; allowLoopbackHttp?: boolean;
  verifyPackage: (filename: string, manifest: UpdateManifest) => Promise<void>;
  prepareInstall: () => Promise<void>;
  launchInstaller: (filename: string) => Promise<void>;
  cancelInstallPreparation?: () => void;
}

export interface UpdateActivity {
  installing: boolean;
  agentActive: number;
  credentialSaves: number;
  localBusy: boolean;
  localUncertain: boolean;
  mediaBusy: boolean;
  mediaUncertain: boolean;
  storageBusy: boolean;
}

// 配置回退结果未确认时也不能停止引擎安装，避免更新后继续使用不一致的执行环境。
export function assertUpdateIdle(activity: UpdateActivity): void {
  if (activity.installing || activity.agentActive > 0 || activity.credentialSaves > 0 || activity.localBusy || activity.localUncertain
    || activity.mediaBusy || activity.mediaUncertain || activity.storageBusy) {
    throw new DesktopError('UPDATE_TASKS_ACTIVE', '对话、配置保存、配置状态确认或数据维护仍在进行，请完成后再安装更新');
  }
}

// 严格使用三段版本与 SemVer 预发布次序，避免 0.10 被当成小于 0.9。
export function compareVersions(left: string, right: string): number {
  const a = versionPattern.exec(left), b = versionPattern.exec(right);
  if (!a || !b) throw new DesktopError('UPDATE_VERSION_INVALID', '更新版本号格式无效');
  for (let i = 1; i <= 3; i++) {
    const diff = BigInt(a[i]) - BigInt(b[i]); if (diff !== 0n) return diff > 0n ? 1 : -1;
  }
  if (!a[4] || !b[4]) return a[4] === b[4] ? 0 : a[4] ? -1 : 1;
  const ap = a[4].split('.'), bp = b[4].split('.');
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    if (ap[i] === bp[i]) continue;
    if (ap[i] === undefined) return -1; if (bp[i] === undefined) return 1;
    const an = /^\d+$/.test(ap[i]), bn = /^\d+$/.test(bp[i]);
    if (an && bn) return BigInt(ap[i]) > BigInt(bp[i]) ? 1 : -1;
    if (an !== bn) return an ? -1 : 1;
    return ap[i] > bp[i] ? 1 : -1;
  }
  return 0;
}
export function validateUpdateUrl(value: string, allowLoopbackHttp = false): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new DesktopError('UPDATE_URL_INVALID', '更新地址不是有效 URL'); }
  const loopback = ['127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(allowLoopbackHttp && loopback && url.protocol === 'http:'))) {
    throw new DesktopError('UPDATE_URL_INVALID', '更新地址必须使用 HTTPS，且不能包含用户名、密码或片段');
  }
  return url;
}
export function parseManifest(value: unknown, allowLoopbackHttp = false): UpdateManifest {
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) throw new DesktopError('UPDATE_MANIFEST_INVALID', '更新清单的应用、平台、版本、大小或校验值无效');
  validateUpdateUrl(parsed.data.downloadUrl, allowLoopbackHttp);
  return { ...parsed.data, sha256: parsed.data.sha256.toLowerCase() };
}
async function digestFile(filename: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename, { signal })) hash.update(chunk);
  return hash.digest('hex');
}

export class UpdateManager {
  private manifestUrl = '';
  private manifest?: UpdateManifest;
  private readyFile?: string;
  private operation?: AbortController;
  private operationSettled: Promise<void> = Promise.resolve();
  private resolveOperation?: () => void;
  private state: UpdateStatus;
  private restoring?: Promise<void>;
  constructor(private options: UpdaterOptions) { this.state = { state: 'unconfigured', currentVersion: options.currentVersion, downloadedBytes: 0 }; }
  status(): UpdateStatus { return structuredClone(this.state); }
  private setState(state: UpdateStatus['state'], extra: Partial<UpdateStatus> = {}): UpdateStatus {
    this.state = { ...this.state, state, error: undefined, ...extra }; return this.status();
  }
  configure(value: string): void {
    if (value) validateUpdateUrl(value, this.options.allowLoopbackHttp);
    if (value === this.manifestUrl) return;
    if (this.operation || this.state.state === 'installing') throw new DesktopError('UPDATE_BUSY', '更新操作进行中，请先取消或等待完成');
    this.manifestUrl = value; this.manifest = undefined; this.readyFile = undefined;
    this.state = { state: value ? 'idle' : 'unconfigured', currentVersion: this.options.currentVersion, downloadedBytes: 0 };
  }
  async restore(): Promise<void> {
    if (this.restoring) return this.restoring;
    const configuredUrl = this.manifestUrl;
    this.restoring = (async () => {
      if (!configuredUrl) return;
      try {
        const receipt = JSON.parse(await readFile(path.join(this.options.directory, 'ready.json'), 'utf8'));
        if (receipt.manifestUrl !== configuredUrl) return;
        const manifest = parseManifest(receipt.manifest, this.options.allowLoopbackHttp);
        if (compareVersions(manifest.version, this.options.currentVersion) <= 0) return;
        const filename = this.packagePath(manifest);
        await this.verify(filename, manifest);
        if (this.manifestUrl !== configuredUrl) return;
        this.manifest = manifest; this.readyFile = filename;
        this.setState('ready', { release: this.release(manifest), downloadedBytes: manifest.size, totalBytes: manifest.size });
      } catch { /* 缺失或损坏的历史更新不能恢复为可安装状态，用户可重新检查。 */ }
    })().finally(() => { this.restoring = undefined; });
    return this.restoring;
  }
  private release(manifest: UpdateManifest): UpdateStatus['release'] {
    return { version: manifest.version, releaseNotes: manifest.releaseNotes, size: manifest.size, ...(manifest.publishedAt ? { publishedAt: manifest.publishedAt } : {}) };
  }
  private packagePath(manifest: UpdateManifest): string { return path.join(this.options.directory, `AutoLabel-${manifest.version}-${manifest.sha256}.exe`); }
  private fail(error: unknown, controller?: AbortController): UpdateStatus {
    if (controller?.signal.aborted) return this.setState('cancelled');
    return this.setState('error', { error: error instanceof DesktopError ? { code: error.code, message: error.message } : { code: 'UPDATE_OPERATION_FAILED', message: '更新操作失败，请检查网络、可用空间或稍后重试' } });
  }
  private begin(): AbortController {
    if (this.operation || this.state.state === 'installing') throw new DesktopError('UPDATE_BUSY', '已有更新操作正在进行');
    const controller = new AbortController(); this.operation = controller;
    this.operationSettled = new Promise(resolve => { this.resolveOperation = resolve; });
    return controller;
  }
  private finish(controller: AbortController): void {
    if (this.operation === controller) { this.operation = undefined; this.resolveOperation?.(); this.resolveOperation = undefined; }
  }
  private async response(value: string, signal: AbortSignal, allowMissing = false): Promise<Response> {
    let url = validateUpdateUrl(value, this.options.allowLoopbackHttp);
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await fetch(url, { redirect: 'manual', signal, headers: { 'Accept-Encoding': 'identity' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location'); await response.body?.cancel();
        if (!location) throw new DesktopError('UPDATE_REDIRECT_INVALID', '更新地址重定向缺少目标');
        const next = validateUpdateUrl(new URL(location, url).href, this.options.allowLoopbackHttp);
        if (url.protocol === 'https:' && next.protocol !== 'https:') throw new DesktopError('UPDATE_REDIRECT_INVALID', '更新地址不能重定向到未加密连接');
        url = next; continue;
      }
      if (!response.ok || !response.body) { await response.body?.cancel(); if (allowMissing && response.status === 404) return response; throw new DesktopError('UPDATE_HTTP_ERROR', `更新服务器返回错误（${response.status}）`); }
      return response;
    }
    throw new DesktopError('UPDATE_REDIRECT_INVALID', '更新地址重定向次数过多');
  }
  async check(): Promise<UpdateStatus> {
    await this.restoring;
    if (!this.manifestUrl) return this.setState('unconfigured');
    const controller = this.begin(); this.manifest = undefined; this.readyFile = undefined;
    this.setState('checking', { release: undefined, downloadedBytes: 0, totalBytes: undefined });
    try {
      const response = await this.response(this.manifestUrl, AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]), true);
      // 清单 404 是「尚未发布版本」的常态，不是故障：如实报「已是最新」，不吓唬用户。
      if (response.status === 404) return this.setState('up-to-date');
      const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let total = 0;
      while (true) {
        const { done, value } = await reader.read(); if (done) break; total += value.length;
        if (total > 128 * 1024) { await reader.cancel(); throw new DesktopError('UPDATE_MANIFEST_TOO_LARGE', '更新清单超过大小限制'); } chunks.push(value);
      }
      let parsed: unknown;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new DesktopError('UPDATE_MANIFEST_INVALID', '更新清单不是有效 JSON'); }
      const manifest = parseManifest(parsed, this.options.allowLoopbackHttp);
      controller.signal.throwIfAborted(); this.manifest = manifest;
      return this.setState(compareVersions(manifest.version, this.options.currentVersion) > 0 ? 'available' : 'up-to-date', { release: this.release(manifest), totalBytes: manifest.size });
    } catch (error) { return this.fail(error, controller); }
    finally { this.finish(controller); }
  }
  async download(): Promise<UpdateStatus> {
    await this.restoring;
    if (!this.manifest || compareVersions(this.manifest.version, this.options.currentVersion) <= 0) throw new DesktopError('UPDATE_NOT_AVAILABLE', '请先检查可用的新版本');
    const controller = this.begin(); const manifest = this.manifest; let temporary: string | undefined;
    this.readyFile = undefined; this.setState('downloading', { downloadedBytes: 0, totalBytes: manifest.size });
    try {
      await mkdir(this.options.directory, { recursive: true });
      const disk = await statfs(this.options.directory);
      if (Number(disk.bavail) * Number(disk.bsize) < manifest.size + 64 * 1024 ** 2) throw new DesktopError('UPDATE_NO_SPACE', '更新下载空间不足，请释放磁盘空间后重试');
      temporary = path.join(this.options.directory, `.download-${randomUUID()}.tmp`);
      const file = await open(temporary, 'wx', 0o600); const hash = createHash('sha256');
      let watchdog: NodeJS.Timeout | undefined;
      const timeout = new AbortController();
      const touch = () => { if (watchdog) clearTimeout(watchdog); watchdog = setTimeout(() => timeout.abort(), 30000); };
      touch();
      const signal = AbortSignal.any([controller.signal, timeout.signal, AbortSignal.timeout(60 * 60 * 1000)]);
      try {
        const response = await this.response(manifest.downloadUrl, signal);
        const length = response.headers.get('content-length');
        if (length && Number(length) !== manifest.size) { await response.body?.cancel(); throw new DesktopError('UPDATE_SIZE_MISMATCH', '安装包大小与更新清单不一致'); }
        const reader = response.body!.getReader();
        while (true) {
          const { done, value } = await reader.read(); if (done) break; touch();
          const bytes = this.state.downloadedBytes + value.length;
          if (bytes > manifest.size) { await reader.cancel(); throw new DesktopError('UPDATE_SIZE_MISMATCH', '下载内容超过更新清单声明的大小'); }
          hash.update(value);
          let offset = 0;
          while (offset < value.length) {
            const written = await file.write(value, offset, value.length - offset);
            if (!written.bytesWritten) throw new DesktopError('UPDATE_WRITE_FAILED', '安装包写入未完成，请检查磁盘');
            offset += written.bytesWritten;
          }
          this.state.downloadedBytes = bytes;
        }
        if (this.state.downloadedBytes !== manifest.size || hash.digest('hex') !== manifest.sha256) throw new DesktopError('UPDATE_CHECKSUM_MISMATCH', '安装包完整性校验失败，未保留可安装文件');
        await file.sync();
      } finally { if (watchdog) clearTimeout(watchdog); await file.close(); }
      controller.signal.throwIfAborted(); this.setState('verifying');
      await this.options.verifyPackage(temporary, manifest);
      controller.signal.throwIfAborted();
      const filename = this.packagePath(manifest);
      await rename(temporary, filename); temporary = undefined;
      // 原子提交凭据式收据，只引用按版本和摘要生成的内部文件名。
      const receipt = path.join(this.options.directory, `ready-${randomUUID()}.tmp`);
      await writeFile(receipt, JSON.stringify({ manifestUrl: this.manifestUrl, manifest }), { mode: 0o600 });
      await rename(receipt, path.join(this.options.directory, 'ready.json'));
      this.readyFile = filename;
      return this.setState('ready');
    } catch (error) { return this.fail(error, controller); }
    finally { if (temporary) await unlink(temporary).catch(() => undefined); this.finish(controller); }
  }
  cancel(): UpdateStatus { this.operation?.abort(); return this.status(); }
  async shutdown(): Promise<void> {
    this.operation?.abort();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.operationSettled, new Promise<void>(resolve => { timer = setTimeout(resolve, 3000); })]);
    if (timer) clearTimeout(timer);
  }
  private async verify(filename: string, manifest: UpdateManifest): Promise<void> {
    const info = await stat(filename);
    if (!info.isFile() || info.size !== manifest.size || await digestFile(filename) !== manifest.sha256) throw new DesktopError('UPDATE_CHECKSUM_MISMATCH', '已下载的更新文件发生变化，请重新下载');
    await this.options.verifyPackage(filename, manifest);
  }
  async install(): Promise<UpdateStatus> {
    await this.restoring;
    if (!this.readyFile || !this.manifest || this.state.state !== 'ready') throw new DesktopError('UPDATE_NOT_READY', '更新尚未完成校验，不能安装');
    const controller = this.begin(); this.setState('verifying');
    try {
      await this.verify(this.readyFile, this.manifest); controller.signal.throwIfAborted();
      await this.options.prepareInstall(); controller.signal.throwIfAborted();
      this.setState('installing'); await this.options.launchInstaller(this.readyFile);
      return this.status();
    } catch (error) {
      this.options.cancelInstallPreparation?.();
      // 任务仍在执行时保留已验证安装包，待用户暂停或完成后可再次安装。
      if (error instanceof DesktopError && error.code === 'UPDATE_TASKS_ACTIVE') return this.setState('ready', { error: { code: error.code, message: error.message } });
      return this.fail(error, controller);
    } finally { this.finish(controller); }
  }
}
