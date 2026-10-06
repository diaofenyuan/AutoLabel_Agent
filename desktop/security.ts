import path from 'node:path';
import { realpath, stat, lstat } from 'node:fs/promises';
import { DesktopError } from './validation';
import { pathIdentity } from './paths';

export function redact(value: unknown, secrets: string[] = []): string {
  let output = String(value).slice(0, 8000);
  for (const secret of secrets) if (secret) output = output.split(secret).join('[凭据已隐藏]');
  return output
    .replace(/(Bearer\s+)[\w.+/=-]+/gi, '$1[已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[凭据已隐藏]')
    .replace(/((?:api[_-]?key|authorization|token|password|secret)["'\s:=]+)[^\s,;}]+/gi, '$1[已隐藏]')
    .replace(/https?:\/\/[^\s"<>]+/gi, '[接口地址已隐藏]')
    .replace(/[A-Za-z]:[\\/][^\r\n"<>|]+/g, '[本地路径已隐藏]')
    .replace(/\\\\[^\s"<>]+/g, '[网络路径已隐藏]');
}

// 授权键与本地执行、引擎使用同一套路径身份规则。
function normalize(value: string): string { return pathIdentity(value); }

export class PathGrants {
  private grants = new Map<string, { kind: string; directory: boolean }>();
  private outputParents = new Map<string, string>();
  /**
   * 授权持久化：把「用户亲手选过的文件」记到用户数据目录，应用重启后仍认。
   *
   * 为什么需要：抽帧失败后重试要复核视频路径（media.job.retry 会grants.require(sourcePath)），
   * 而授权原先只存在内存里。重启应用或换个会话再来一次「继续抽帧」，同一个视频就被判成
   * 「未授权」，用户被迫重新走一遍文件选择器——正是「发送过的数据没有记住」的由来。
   *
   * 只持久化文件级授权（video/images/model 之类的具体文件），目录授权一律不落盘：
   * 目录授权是「当时点开那个文件夹」的临时范围，持久化等于把一次点选放大成长期权限，
   * 会破坏 security.test 里「目录授权不扩大到视频」的边界。视频仍逐文件登记，与既有口径一致。
   */
  private readonly persisted: { file: string; kind: string }[] = [];
  constructor(private readonly store?: { load(): Promise<{ file: string; kind: string }[]>; save(entries: { file: string; kind: string }[]): Promise<void> }) {}
  /** 载入历史授权；逐条 realpath 复核，路径已失效或被替换的直接丢弃，不因为历史记录就放行。 */
  async restore(): Promise<void> {
    if (!this.store) return;
    let saved: { file: string; kind: string }[];
    try { saved = await this.store.load(); } catch { return; }
    for (const entry of saved) {
      if (!entry || typeof entry.file !== 'string' || typeof entry.kind !== 'string') continue;
      // 逐条独立处理：单条失效不能连带丢掉其余仍然有效的授权。
      try {
        const resolved = await realpath(entry.file);
        if (!(await stat(resolved)).isDirectory()) this.grants.set(normalize(resolved), { kind: entry.kind, directory: false });
      } catch { /* 路径已删除或不可达：不再授权 */ }
    }
  }
  async add(value: string, kind: string): Promise<string> {
    const resolved = await realpath(value);
    const directory = (await stat(resolved)).isDirectory();
    this.grants.set(normalize(resolved), { kind, directory });
    // 只有具体文件才落盘；目录授权仅本次会话有效，见构造函数注释。
    if (!directory) this.schedulePersist({ file: resolved, kind });
    return resolved;
  }
  /**
   * 合并待写记录后异步落盘。多步导入（一次选十几个视频）会连续触发 add，
   * 用定时器合并成一次写，避免每个文件一次磁盘写入。
   */
  private schedulePersist(entry: { file: string; kind: string }): void {
    if (!this.store) return;
    if (!this.persisted.some(item => normalize(item.file) === normalize(entry.file))) this.persisted.push(entry);
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      // 写失败不阻断当前操作：授权在本次会话内已生效，只是下次启动要再选一次。
      void this.store!.save(this.persisted.slice()).catch(() => undefined);
    }, 500);
    this.persistTimer.unref?.();
  }
  private persistTimer: NodeJS.Timeout | undefined;
  /** 立即落盘：应用退出前调用，避免定时器未触发导致授权丢失。 */
  async flush(): Promise<void> {
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = undefined; }
    if (!this.store) return;
    await this.store.save(this.persisted.slice()).catch(() => undefined);
  }
  async require(value: unknown, kinds: string[], exact = true): Promise<string> {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new DesktopError('PATH_DENIED', '请先使用文件选择器选择路径');
    let resolved: string;
    try { resolved = await realpath(value); } catch { throw new DesktopError('PATH_MISSING', '所选路径已失效，请重新选择'); }
    const key = normalize(resolved);
    const grant = this.grants.get(key);
    if (grant && kinds.includes(grant.kind)) return resolved;
    if (!exact) for (const [base, item] of this.grants) {
      if (item.directory && kinds.includes(item.kind) && key.startsWith(base + path.sep)) return resolved;
    }
    throw new DesktopError('PATH_DENIED', '此路径尚未通过文件选择器授权');
  }
  async addOutput(value: string): Promise<string> {
    const parent = await realpath(path.dirname(value));
    const output = path.join(parent, path.basename(value));
    this.grants.set(normalize(output), { kind: 'output', directory: false });
    this.outputParents.set(normalize(output), parent);
    return this.requireOutput(output);
  }
  async requireOutput(value: unknown): Promise<string> {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new DesktopError('PATH_DENIED', '请先使用保存对话框选择输出文件');
    const output = path.resolve(value); const key = normalize(output); const selectedParent = this.outputParents.get(key);
    if (!selectedParent) throw new DesktopError('PATH_DENIED', '该输出文件尚未通过保存对话框授权');
    let parent: string;
    try { parent = await realpath(path.dirname(output)); } catch { throw new DesktopError('PATH_MISSING', '输出文件夹已失效，请重新选择'); }
    if (normalize(parent) !== normalize(selectedParent)) throw new DesktopError('PATH_DENIED', '输出文件夹位置已改变，请重新选择');
    try { const info = await lstat(output); if (!info.isFile() || info.isSymbolicLink()) throw new DesktopError('PATH_DENIED', '输出位置必须是普通文件'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return output;
  }
}

// 各入口共用同一组选择授权，读取历史记录不能间接扩大文件访问范围。
export async function authorizeCommandPaths(command: string, payload: Record<string, unknown>, grants: PathGrants): Promise<void> {
  if (command === 'local.model.register') payload.modelPath = await grants.require(payload.modelPath, ['model']);
  // 训练数据集只能来自用户显式选择的目录；引用已完成导出版本时不涉及外部路径。
  if (command === 'training.dataset.create') {
    for (const field of ['trainDir', 'valDir', 'yamlDir']) {
      if (typeof payload[field] === 'string') payload[field] = await grants.require(payload[field], ['directory']);
    }
  }
  if (['media.video.inspect', 'media.video.create'].includes(command)) payload.sourcePath = await grants.require(payload.sourcePath, ['video']);
  if (command.startsWith('flow.') && payload.definition && typeof payload.definition === 'object') {
    const steps = (payload.definition as { steps?: Array<{ kind: string; parameters: Record<string, unknown> }> }).steps;
    for (const step of steps ?? []) {
      if (step.kind === 'import' && step.parameters.paths) step.parameters.paths = await Promise.all((step.parameters.paths as string[]).map(value => grants.require(value, ['images', 'directory'])));
      if (step.kind === 'export' && step.parameters.outputDir) step.parameters.outputDir = await grants.require(step.parameters.outputDir, ['directory']);
    }
  }
  if (['backup.preflight', 'backup.create'].includes(command)) payload.outputDir = await grants.require(payload.outputDir, ['directory']);
  if (['backup.inspect', 'restore.prepare'].includes(command)) payload.backupPath = await grants.require(payload.backupPath, ['backup']);
  if (['restore.prepare', 'storage.migrate'].includes(command)) payload.targetParent = await grants.require(payload.targetParent, ['directory']);
  if (command === 'asset.import') {
    payload.paths = await Promise.all((payload.paths as string[]).map(value => grants.require(value, ['images', 'video', 'directory', 'labels'])));
  }
  if (['export.create', 'export.reproduce'].includes(command)) payload.outputDir = await grants.require(payload.outputDir, ['directory']);
  if (command === 'asset.relocate') payload.directory = await grants.require(payload.directory, ['directory']);
  if (command === 'annotation.importYolo') {
    if (payload.labelsDir) payload.labelsDir = await grants.require(payload.labelsDir, ['directory']);
    if (payload.items) payload.items = await Promise.all((payload.items as Record<string, unknown>[]).map(async item => ({ ...item, labelPath: await grants.require(item.labelPath, ['labels']) })));
  }
  // 分类数据集目录必须由用户在选择器里授权，引擎再从中读取类别子文件夹。
  if (['annotation.importClassify.preflight', 'annotation.importClassify'].includes(command)) payload.rootDir = await grants.require(payload.rootDir, ['directory']);
  if (command === 'annotation.render') {
    payload.outputPath = await grants.requireOutput(payload.outputPath);
    const extensions = payload.format === 'jpeg' ? ['.jpg', '.jpeg'] : ['.png'];
    if (!extensions.includes(path.extname(payload.outputPath as string).toLowerCase())) throw new DesktopError('OUTPUT_FORMAT_MISMATCH', '输出文件扩展名与图片格式不一致');
  }
  if (command === 'agent.chat') {
    const context = payload.context as Record<string, unknown> | undefined;
    if (context?.exportDir) context.exportDir = await grants.require(context.exportDir, ['directory']);
  }
}

export type MediaTarget = { kind: 'asset'; assetId: string } | { kind: 'thumb'; assetId: string } | { kind: 'evaluation'; setVersionId: string; assetId: string }
  | { kind: 'resource'; resourceId: string; version: number } | { kind: 'input'; inputId: string };

export function mediaTargetFromUrl(value: string): MediaTarget {
  const asset = /^autolabel-media:\/\/asset\/([A-Za-z0-9_-]{1,128})$/.exec(value);
  if (asset && asset[0] === value) return { kind: 'asset', assetId: asset[1] };
  const thumb = /^autolabel-media:\/\/thumb\/([A-Za-z0-9_-]{1,128})$/.exec(value);
  if (thumb && thumb[0] === value) return { kind: 'thumb', assetId: thumb[1] };
  const evaluation = /^autolabel-media:\/\/evaluation\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{1,128})$/.exec(value);
  if (evaluation && evaluation[0] === value) return { kind: 'evaluation', setVersionId: evaluation[1], assetId: evaluation[2] };
  const resource = /^autolabel-media:\/\/resource\/([A-Za-z0-9_-]{1,128})\/(0|[1-9][0-9]{0,9})$/.exec(value);
  if (resource && resource[0] === value && Number(resource[2]) <= 2147483647) return { kind: 'resource', resourceId: resource[1], version: Number(resource[2]) };
  const input = /^autolabel-media:\/\/input\/([A-Za-z0-9_-]{1,128})$/.exec(value);
  if (input && input[0] === value) return { kind: 'input', inputId: input[1] };
  throw new DesktopError('MEDIA_DENIED', '素材地址无效');
}

export function assetIdFromUrl(value: string): string {
  const target = mediaTargetFromUrl(value);
  if (target.kind !== 'asset') throw new DesktopError('MEDIA_DENIED', '此地址不属于当前项目素材');
  return target.assetId;
}

export function isTrustedUrl(value: string, devOrigin?: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'autolabel-app:' && url.host === 'app' && !url.username && !url.password)
      || (!!devOrigin && url.origin === devOrigin);
  } catch { return false; }
}

export function normalizeMedia(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeMedia);
  if (value && typeof value === 'object') {
    const item = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(item)) {
      if (key === 'mediaUrl' || key === 'thumbnailUrl') {
        if (typeof child === 'string' && (child.startsWith('autolabel-media://input') || child.startsWith('/flow-input-media/'))) {
          try {
            const target = mediaTargetFromUrl(child.replace(/^\/flow-input-media\//, 'autolabel-media://input/'));
            if (target.kind === 'input') output[key] = `autolabel-media://input/${target.inputId}`;
          } catch { /* 固定输入地址失效时不能降级为当前原图。 */ }
          continue;
        }
        if (typeof child === 'string' && (child.startsWith('autolabel-media://resource') || child.startsWith('/resource-media/'))) {
          try {
            const target = mediaTargetFromUrl(child.replace(/^\/resource-media\//, 'autolabel-media://resource/'));
            if (target.kind === 'resource') output[key] = `autolabel-media://resource/${target.resourceId}/${target.version}`;
          } catch { /* 资源地址失效时不能回退为原项目素材。 */ }
          continue;
        }
        if (typeof child === 'string' && (child.startsWith('autolabel-media://evaluation') || child.startsWith('/evaluation-media/'))) {
          // 发布副本必须保留版本身份；无效地址不能降级为当前素材图片。
          try {
            const target = mediaTargetFromUrl(child.replace(/^\/evaluation-media\//, 'autolabel-media://evaluation/'));
            if (target.kind === 'evaluation') output[key] = `autolabel-media://evaluation/${target.setVersionId}/${target.assetId}`;
          } catch { /* 忽略无效的引擎媒体字段，由界面明确显示图片不可用。 */ }
          continue;
        }
        if (key === 'thumbnailUrl' && typeof child === 'string' && child.startsWith('autolabel-media://thumb')) {
          // 缩略图地址必须保留缩略图身份：降级成原图会让列表静默退化为整图加载。
          try {
            const target = mediaTargetFromUrl(child);
            if (target.kind === 'thumb') output[key] = `autolabel-media://thumb/${target.assetId}`;
          } catch { /* 无效缩略图地址不能降级为原图，由界面回退或显示图片不可用。 */ }
          continue;
        }
        const id = typeof item.id === 'string' ? item.id : item.assetId;
        if (typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)) output[key] = `autolabel-media://asset/${id}`;
      } else output[key] = normalizeMedia(child);
    }
    // 资源图片绑定已返回的具体版本，不依赖后续可能变化的最新版本。
    if (item.kind === 'reference' && typeof item.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(item.id)
      && Number.isInteger(item.version) && Number(item.version) >= 0 && Number(item.version) <= 2147483647) {
      output.mediaUrl = `autolabel-media://resource/${item.id}/${item.version}`;
    }
    return output;
  }
  return value;
}

export function publicInputResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicInputResult);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/(path|directory|executable)$/i.test(key) && !/^(workerScript|script|python)$/i.test(key))
    .map(([key, child]) => [key, publicInputResult(child)]));
  if (typeof value === 'string') return path.isAbsolute(value) ? '[本地路径已隐藏]' : redact(value);
  return value;
}
