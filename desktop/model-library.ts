import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import {
  MODEL_CATALOG, bundledModelBytes, catalogModel,
  type CatalogModel, type ModelLibraryEntry, type ModelLibraryState,
} from '../shared/model-library';
import { ensureModelsRoot } from './storage-paths';
import { DesktopError } from './validation';

/** 取回响应头的最长时间；超过它认为这个下载源不可用，换下一个。 */
const HEADER_TIMEOUT_MS = 20000;
/** 传输停滞判定：大文件在慢网下总时长可以很长，但「长时间一个字节都没有」就是断了。 */
const STALL_TIMEOUT_MS = 30000;

export interface ModelDownloadProgress {
  catalogId: string;
  fileName: string;
  receivedBytes: number;
  totalBytes: number;
}

interface Verified { size: number; mtimeMs: number; ok: boolean }

const sameFile = (left: string, right: string) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();

async function hashFile(file: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

/**
 * 下载一个文件到 `part`，支持断点续传。
 *
 * 仅按「有没有收到数据」判定失败：大文件在慢网下总时长可以很长，用总超时会把正常下载误杀。
 * 内容真伪不由网络决定——下载完成后统一按 sha256 核对。
 */
async function download(url: string, part: string, onProgress: (received: number, total: number) => void): Promise<void> {
  let offset = 0;
  try { offset = (await stat(part)).size; } catch { offset = 0; }
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined = setTimeout(() => controller.abort(), HEADER_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { headers: offset ? { Range: `bytes=${offset}-` } : {}, signal: controller.signal, redirect: 'follow' });
  } catch {
    throw new DesktopError('MODEL_LIBRARY_SOURCE_UNREACHABLE', '下载源无法连接');
  } finally { clearTimeout(timer); timer = undefined; }
  // 416 表示本地已有的分段比服务端文件还长：缓存不可信，删掉重下。
  if (response.status === 416) { await rm(part, { force: true }); throw new DesktopError('MODEL_LIBRARY_RANGE_INVALID', '本地未完成的分段已失效'); }
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new DesktopError('MODEL_LIBRARY_HTTP_ERROR', `下载源返回 ${response.status}`); }
  const resumed = response.status === 206 && offset > 0;
  const length = Number(response.headers.get('content-length') ?? 0);
  const total = resumed ? offset + length : length;
  let received = resumed ? offset : 0;
  let stall: NodeJS.Timeout | undefined = setTimeout(() => controller.abort(), STALL_TIMEOUT_MS);
  const touch = () => { clearTimeout(stall); stall = setTimeout(() => controller.abort(), STALL_TIMEOUT_MS); };
  const source = Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream);
  source.on('data', chunk => { touch(); received += chunk.length; onProgress(received, total); });
  try { await pipeline(source, createWriteStream(part, { flags: resumed ? 'a' : 'w' })); }
  catch { throw new DesktopError('MODEL_LIBRARY_DOWNLOAD_INTERRUPTED', '下载中断，可重试续传'); }
  finally { clearTimeout(stall); }
}

/**
 * 模型库：内置权重 + 按需下载。
 *
 * 内置权重随安装包提供（<安装目录>/resources/models），下载的模型与文本编码器落在
 * <存储根>/models。两条来源共用同一套 sha256 核对——不管文件从哪来，内容不对就是不可用。
 * 这里只负责「把文件放对位置并证明它是它」，登记与执行授权仍走既有的本地模型通路。
 */
export class ModelLibrary {
  private verified = new Map<string, Verified>();
  private busy = new Set<string>();
  constructor(private options: {
    /** 内置权重目录：打包态为 resources/models，开发态为仓库 build/models。 */
    builtinRoot: () => string;
    /** 存储根；未解析时不能下载也不再凭空造目录。 */
    storageRoot: () => string | undefined;
    /** 当前数据目录；用于保证模型库不会与业务数据互相包含。 */
    dataDirectory: () => string;
    /** 下载进度；按行回调，界面据此显示进度而不是一个转圈。 */
    onProgress?: (progress: ModelDownloadProgress) => void;
  }) {}

  /** 库内文件只可能来自这两个目录；授权时用它限定可信任范围，避免这条通道被用来授权任意路径。 */
  roots(): string[] {
    const roots = [this.options.builtinRoot()];
    const storage = this.options.storageRoot();
    if (storage) roots.push(path.join(storage, 'models'));
    return roots;
  }

  private modelsRootPath(): string {
    const root = this.options.storageRoot();
    if (!root) throw new DesktopError('STORAGE_UNAVAILABLE', '尚未解析存储位置，请到「设置 → 存储位置」确认后重试');
    return path.join(root, 'models');
  }

  /** 文本编码器按 CLIP 约定直接放在 text-encoder 目录下；其余按模型标识与内容哈希分目录存放。 */
  private storageFile(model: CatalogModel): string {
    const root = this.modelsRootPath();
    return model.taskType === null ? path.join(root, 'text-encoder', model.fileName)
      : path.join(root, model.id, model.sha256.slice(0, 12), model.fileName);
  }

  private candidates(model: CatalogModel): Array<{ location: 'builtin' | 'storage'; file: string }> {
    return [
      { location: 'builtin', file: path.join(this.options.builtinRoot(), model.fileName) },
      { location: 'storage', file: this.storageFile(model) },
    ];
  }

  /** 逐个候选位置核对大小与哈希；只有完全一致才算就绪。哈希结果按「路径 + 大小 + 修改时间」缓存。 */
  private async inspect(model: CatalogModel, location: 'builtin' | 'storage', file: string): Promise<ModelLibraryEntry | null> {
    const base: Omit<ModelLibraryEntry, 'state' | 'location' | 'actualBytes' | 'message'> = {
      id: model.id, name: model.name, group: model.group, taskType: model.taskType, openVocabulary: model.openVocabulary,
      tier: model.tier, fileName: model.fileName, sizeBytes: model.sizeBytes, sha256: model.sha256, license: model.license, note: model.note,
    };
    let info;
    try { info = await stat(file); } catch { return null; }
    if (!info.isFile()) return { ...base, state: 'corrupt', location: null, actualBytes: 0, message: `${location === 'builtin' ? '内置' : '下载'}位置的同名项不是文件` };
    if (info.size !== model.sizeBytes) {
      return { ...base, state: 'corrupt', location, actualBytes: info.size,
        message: `文件大小与目录不一致（应为 ${(model.sizeBytes / 1024 / 1024).toFixed(1)} MB，实际 ${(info.size / 1024 / 1024).toFixed(1)} MB）` };
    }
    const cached = this.verified.get(file);
    const key = { size: info.size, mtimeMs: info.mtimeMs };
    let ok: boolean;
    if (cached && cached.size === key.size && cached.mtimeMs === key.mtimeMs) ok = cached.ok;
    else { ok = await hashFile(file) === model.sha256; this.verified.set(file, { ...key, ok }); }
    return ok ? { ...base, state: 'ready', location, actualBytes: info.size }
      : { ...base, state: 'corrupt', location, actualBytes: info.size, message: '文件内容与目录记录的哈希不一致，可能已损坏或被改动，请重新下载' };
  }

  private async describe(model: CatalogModel): Promise<ModelLibraryEntry> {
    let corrupt: ModelLibraryEntry | null = null;
    for (const candidate of this.candidates(model)) {
      const found = await this.inspect(model, candidate.location, candidate.file);
      if (!found) continue;
      if (found.state === 'ready') return found;
      corrupt = corrupt ?? found;
    }
    if (corrupt) return corrupt;
    return {
      id: model.id, name: model.name, group: model.group, taskType: model.taskType, openVocabulary: model.openVocabulary,
      tier: model.tier, fileName: model.fileName, sizeBytes: model.sizeBytes, sha256: model.sha256, license: model.license, note: model.note,
      state: 'missing', location: null, actualBytes: 0,
      message: model.tier === 'bundled' ? '随安装包提供的权重不在位' : `尚未下载（约 ${(model.sizeBytes / 1024 / 1024).toFixed(0)} MB）`,
    };
  }

  async status(): Promise<ModelLibraryState> {
    const entries: ModelLibraryEntry[] = [];
    for (const model of MODEL_CATALOG) entries.push(await this.describe(model));
    return {
      builtinRoot: this.options.builtinRoot(), modelsRoot: this.modelsRootPath(), entries,
      ready: entries.filter(entry => entry.state === 'ready').length, total: entries.length,
      bundledBytes: bundledModelBytes(),
    };
  }

  /** 就绪模型的绝对路径与哈希；登记与授权由调用方拿着它走既有入口，这里不下发路径给界面。 */
  async readyFile(catalogId: string): Promise<{ model: CatalogModel; path: string } | null> {
    const model = catalogModel(catalogId);
    if (!model) return null;
    for (const candidate of this.candidates(model)) {
      const found = await this.inspect(model, candidate.location, candidate.file);
      if (found?.state === 'ready') return { model, path: candidate.file };
    }
    return null;
  }

  /**
   * 下载并核对一个模型。
   *
   * 遍历官方地址与备用镜像，任一成功即结束；校验不通过的内容一律删除，绝不留下半个文件冒充可用。
   * 已经就绪的模型直接返回当前状态，不重复下载。
   */
  async install(catalogId: string, options: { force?: boolean } = {}, onProgress?: (progress: ModelDownloadProgress) => void): Promise<ModelLibraryState> {
    const model = catalogModel(catalogId);
    if (!model) throw new DesktopError('MODEL_LIBRARY_UNKNOWN', '模型库里没有这个模型，请刷新后重试');
    if (this.busy.has(model.id)) throw new DesktopError('MODEL_LIBRARY_BUSY', '这个模型正在下载，请等待当前下载完成');
    this.busy.add(model.id);
    try {
      // 不强制时，已就绪的模型直接返回：重复点「启用」不应该再下一次 55 MB。
      if (!options.force) {
        const current = await this.describe(model);
        if (current.state === 'ready') return await this.status();
      }
      await ensureModelsRoot(this.options.storageRoot()!, this.options.dataDirectory());
      const target = this.storageFile(model);
      await mkdir(path.dirname(target), { recursive: true });
      const part = `${target}.part`;
      const sources = [model.downloadUrl, ...model.mirrorUrls];
      let verifyFailures = 0; let lastError = '';
      for (const url of sources) {
        try {
          await download(url, part, (received, total) => (onProgress ?? this.options.onProgress)?.({ catalogId: model.id, fileName: model.fileName, receivedBytes: received, totalBytes: total }));
        } catch (error) {
          lastError = error instanceof DesktopError ? error.message : '下载未完成';
          continue;
        }
        const info = await stat(part).catch(() => null);
        const digest = info && info.size === model.sizeBytes ? await hashFile(part) : '';
        if (!info || info.size !== model.sizeBytes || digest !== model.sha256) {
          verifyFailures += 1; lastError = '下载内容与目录记录的哈希不一致';
          await rm(part, { force: true });
          continue;
        }
        await rm(target, { force: true });
        await rename(part, target);
        this.verified.set(target, { size: model.sizeBytes, mtimeMs: (await stat(target)).mtimeMs, ok: true });
        return await this.status();
      }
      await rm(part, { force: true });
      throw verifyFailures === sources.length
        ? new DesktopError('MODEL_LIBRARY_HASH_MISMATCH', `每个下载源取回的内容都与目录记录的哈希不一致，已全部丢弃。请稍后重试；若反复出现，请反馈以便核对目录。`)
        : new DesktopError('MODEL_LIBRARY_DOWNLOAD_FAILED', `模型未能下载完成（${lastError}）。已保留可续传的临时文件，稍后重试会接着下。`);
    } finally { this.busy.delete(model.id); }
  }

  /**
   * 删除已下载的模型。
   *
   * 随安装包提供的权重不属于用户存储，删了也不会释放空间（副本仍在安装目录里），因此明确拒绝；
   * 真正需要腾空间的是下载到 <存储根>/models 的那一份。
   */
  async remove(catalogId: string): Promise<ModelLibraryState> {
    const model = catalogModel(catalogId);
    if (!model) throw new DesktopError('MODEL_LIBRARY_UNKNOWN', '模型库里没有这个模型，请刷新后重试');
    if (this.busy.has(model.id)) throw new DesktopError('MODEL_LIBRARY_BUSY', '这个模型正在下载，请等待当前下载完成');
    const builtin = await this.inspect(model, 'builtin', path.join(this.options.builtinRoot(), model.fileName));
    if (builtin?.state === 'ready') throw new DesktopError('MODEL_LIBRARY_BUILTIN', '这个模型随安装包提供，删除不会释放空间，也不需要下载');
    const root = this.modelsRootPath();
    const directory = model.taskType === null ? path.join(root, 'text-encoder') : path.join(root, model.id);
    await rm(directory, { recursive: true, force: true });
    this.verified.clear();
    return await this.status();
  }
}
