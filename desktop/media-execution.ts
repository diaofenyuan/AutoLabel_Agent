import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { DesktopPreferences } from './storage';
import { PathGrants } from './security';
import { DesktopError } from './validation';

interface MediaEngine { request(command: string, payload?: Record<string, unknown>): Promise<unknown>; log(message: string): void }
export interface MediaToolPaths { ffmpegPath?: string; ffprobePath?: string }
const toolNames = ['ffmpeg', 'ffprobe'] as const;

async function executable(value: unknown): Promise<string> {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new DesktopError('MEDIA_PATH_DENIED', '请通过文件选择器指定媒体工具');
  try {
    const resolved = await realpath(value);
    if (path.resolve(value).toLowerCase() !== resolved.toLowerCase() || path.extname(resolved).toLowerCase() !== '.exe' || !(await stat(resolved)).isFile()) throw new Error();
    return resolved;
  } catch { throw new DesktopError('MEDIA_TOOL_MISSING', '所选媒体工具已失效，请重新选择'); }
}

// 仅桌面配置和固定包内目录能指定执行文件，数据库与备份不授予此权限。
export class MediaExecutionSettings {
  private pending: Promise<unknown> = Promise.resolve();
  private active = 0;
  uncertain = false;
  constructor(private preferences: DesktopPreferences, private grants: PathGrants, private bundledDirectory: string) {}
  get busy(): boolean { return this.active > 0; }
  whenIdle(): Promise<unknown> { return this.pending; }
  async paths(): Promise<MediaToolPaths> {
    const result: MediaToolPaths = {};
    for (const name of toolNames) {
      const saved = this.preferences.value[name === 'ffmpeg' ? 'mediaFfmpegPath' : 'mediaFfprobePath'];
      if (saved === null) continue;
      try { result[`${name}Path`] = await executable(saved === undefined ? path.join(this.bundledDirectory, `${name}.exe`) : saved); }
      catch { /* 缺少可选媒体工具不妨碍普通图片与 API 功能启动。 */ }
    }
    return result;
  }
  configure(engine: MediaEngine, input: Record<string, unknown>, guard: () => void): Promise<unknown> {
    this.active++;
    const operation = this.pending.then(async () => {
      guard();
      const next: Record<string, string | null> = {};
      for (const name of toolNames) next[`${name}Path`] = input[`${name}Path`] === null ? null : await executable(await this.grants.require(input[`${name}Path`], [name]));
      guard();
      const previous = await this.paths();
      const result = await engine.request('media.runtime.configure', next);
      try { await this.preferences.update({ mediaFfmpegPath: next.ffmpegPath, mediaFfprobePath: next.ffprobePath }); }
      catch {
        try { await engine.request('media.runtime.configure', { ffmpegPath: previous.ffmpegPath ?? null, ffprobePath: previous.ffprobePath ?? null }); }
        catch { this.uncertain = true; engine.log('媒体工具配置未能保存或回退，请重新连接引擎后再处理视频'); }
        throw new DesktopError('MEDIA_CONFIGURATION_NOT_SAVED', '媒体工具配置未能保存，请重新连接后再配置');
      }
      this.uncertain = false; return result;
    }).finally(() => { this.active--; });
    this.pending = operation.catch(() => undefined); return operation;
  }
}
