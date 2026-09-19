import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { DesktopPreferences } from './storage';
import { PathGrants } from './security';
import { DesktopError } from './validation';

interface LocalEngine { request(command: string, payload?: Record<string, unknown>): Promise<unknown>; log(message: string): void }
const samePath = (left: string, right: string) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();

async function regularFile(value: unknown, extensions: string[]): Promise<string> {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new DesktopError('LOCAL_PATH_DENIED', '请通过文件选择器指定本地文件');
  let resolved: string;
  try { resolved = await realpath(value); } catch { throw new DesktopError('LOCAL_FILE_MISSING', '所选本地文件已失效，请重新选择'); }
  if (!extensions.includes(path.extname(resolved).toLowerCase()) || !(await stat(resolved)).isFile()) throw new DesktopError('LOCAL_FILE_INVALID', '所选文件类型不受支持');
  return resolved;
}

async function hashFile(file: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

// 执行授权只属于这台桌面的当前数据作用域，项目备份中的路径不能恢复此权限。
export class LocalExecutionSettings {
  private pending: Promise<unknown> = Promise.resolve();
  private active = 0;
  uncertain = false;
  constructor(private preferences: DesktopPreferences, private grants: PathGrants) {}
  get busy(): boolean { return this.active > 0; }
  whenIdle(): Promise<unknown> { return this.pending; }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    this.active++;
    const next = this.pending.then(operation).finally(() => { this.active--; });
    this.pending = next.catch(() => undefined); return next;
  }
  async pythonPath(): Promise<string | undefined> {
    const saved = this.preferences.value.localPythonPath;
    if (saved === undefined || saved === null) return undefined;
    try {
      const resolved = await regularFile(saved, ['.exe']);
      return typeof saved === 'string' && samePath(saved, resolved) ? resolved : undefined;
    } catch { return undefined; }
  }
  configure(engine: LocalEngine, pythonPath: unknown, guard: () => void): Promise<unknown> {
    return this.serial(async () => {
      guard();
      const selected = pythonPath === null ? null : await regularFile(await this.grants.require(pythonPath, ['python']), ['.exe']);
      const previous = await this.pythonPath();
      const result = await engine.request('local.runtime.configure', { pythonPath: selected });
      try { await this.preferences.update({ localPythonPath: selected }); }
      catch {
        try { await engine.request('local.runtime.configure', { pythonPath: previous ?? null }); }
        catch { this.uncertain = true; engine.log('本地环境配置未能持久化或回退，请重新连接引擎后再使用本地推理'); }
        throw new DesktopError('LOCAL_CONFIGURATION_NOT_SAVED', '本地环境配置未能保存，请重新连接后再配置');
      }
      this.uncertain = false; return result;
    });
  }
  authorizeSelectedModel(scope: string, filename: string, guard: () => void, engine?: LocalEngine): Promise<string> {
    return this.serial(async () => {
      guard();
      const selected = await regularFile(await this.grants.require(filename, ['model']), ['.pt', '.onnx']);
      const modelHash = await hashFile(selected);
      const scopes = this.preferences.value.localModelGrants as Record<string, Record<string, string>> | undefined;
      await this.preferences.update({ localModelGrants: { ...scopes, [scope]: { ...scopes?.[scope], [selected.toLowerCase()]: modelHash } } });
      if (engine) await engine.request('local.model.authorize', { path: selected, modelHash });
      return selected;
    });
  }
  /**
   * 信任软件自己提供的模型文件（模型库里已按目录哈希核对过的权重）。
   *
   * 与用户手选文件等价，区别只在来源：路径必须落在模型库目录内，
   * 因此不需要文件选择器授权；摘要仍按文件实测，执行时照旧核对——安全性没有放宽，只是省掉一次选择。
   */
  trustModel(scope: string, filename: string, roots: string[], guard: () => void, engine?: LocalEngine): Promise<{ path: string; modelHash: string }> {
    return this.serial(async () => {
      guard();
      const selected = await regularFile(filename, ['.pt', '.onnx']);
      const key = path.resolve(selected).toLowerCase();
      if (!roots.some(root => key === path.resolve(root).toLowerCase() || key.startsWith(path.resolve(root).toLowerCase() + path.sep))) {
        throw new DesktopError('LOCAL_MODEL_NOT_IN_LIBRARY', '只能授权模型库目录内的文件');
      }
      const modelHash = await hashFile(selected);
      const scopes = this.preferences.value.localModelGrants as Record<string, Record<string, string>> | undefined;
      await this.preferences.update({ localModelGrants: { ...scopes, [scope]: { ...scopes?.[scope], [key]: modelHash } } });
      if (engine) await engine.request('local.model.authorize', { path: selected, modelHash });
      return { path: selected, modelHash };
    });
  }
  async modelAuthorizations(scope: string): Promise<Array<{ path: string; modelHash: string }>> {
    const scopes = this.preferences.value.localModelGrants as Record<string, Record<string, string>> | undefined;
    const result: Array<{ path: string; modelHash: string }> = [];
    for (const [filename, modelHash] of Object.entries(scopes?.[scope] ?? {})) {
      if (typeof modelHash !== 'string' || !/^[a-f0-9]{64}$/.test(modelHash)) continue;
      try {
        const selected = await regularFile(filename, ['.pt', '.onnx']);
        if (samePath(filename, selected)) result.push({ path: selected, modelHash });
      } catch { /* 已移走的模型不会取得本次启动的执行权限。 */ }
    }
    return result;
  }
  async requireModel(scope: string, filename: unknown, expectedHash: unknown): Promise<string> {
    const selected = await regularFile(filename, ['.pt', '.onnx']);
    const scopes = this.preferences.value.localModelGrants as Record<string, Record<string, string>> | undefined;
    if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedHash) || scopes?.[scope]?.[selected.toLowerCase()] !== expectedHash.toLowerCase()) {
      throw new DesktopError('LOCAL_MODEL_NOT_AUTHORIZED', '请为当前数据目录重新选择此模型文件，历史记录或恢复备份不能授权模型执行');
    }
    // Java 在加载和推理时核对实际文件摘要；此处只核对用户曾明确授权的文件身份。
    return selected;
  }
}
