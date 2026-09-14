import path from 'node:path';
import { realpath, stat, lstat } from 'node:fs/promises';
import { DesktopError } from './validation';

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

function normalize(value: string): string { return path.resolve(value).toLowerCase(); }

export class PathGrants {
  private grants = new Map<string, { kind: string; directory: boolean }>();
  private outputParents = new Map<string, string>();
  async add(value: string, kind: string): Promise<string> {
    const resolved = await realpath(value);
    this.grants.set(normalize(resolved), { kind, directory: (await stat(resolved)).isDirectory() });
    return resolved;
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

export type MediaTarget = { kind: 'asset'; assetId: string } | { kind: 'evaluation'; setVersionId: string; assetId: string }
  | { kind: 'resource'; resourceId: string; version: number } | { kind: 'input'; inputId: string };

export function mediaTargetFromUrl(value: string): MediaTarget {
  const asset = /^autolabel-media:\/\/asset\/([A-Za-z0-9_-]{1,128})$/.exec(value);
  if (asset && asset[0] === value) return { kind: 'asset', assetId: asset[1] };
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
