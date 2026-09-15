import { mkdir, readdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { MediaToolPaths } from './media-execution';
import type { PathGrants } from './security';
import { DesktopError } from './validation';

/** 单个视频的转码上限；超过就杀掉子进程，避免用户对着一个卡住的 FFmpeg 无限等待。 */
const TIMEOUT_MS = 15 * 60 * 1000;

/**
 * 视频转码兜底。
 *
 * 引擎对旋转、HDR、几何信息的拒绝是「宁可拒绝也不猜测」的有意设计（见 VideoFrames.java），
 * 遇到这类素材只能在界面侧转成参数恒定的副本再继续。转码产物是一次性中间物：只落在系统临时
 * 目录，导入进项目后立即删除、启动时清扫上次残留，绝不写进项目目录或数据目录。
 *
 * 这里刻意不做进度上报：FFmpeg 的进度只影响交互观感，而多一条常驻 IPC 通道会扩大主进程与
 * 渲染进程之间的契约面；界面用「已用时 N 秒」表达仍在工作即可。
 */
export class VideoTranscoder {
  private children = new Set<ReturnType<typeof spawn>>();
  constructor(private tools: () => Promise<MediaToolPaths>, private directory: string, private log: (message: string) => void) {}
  get busy(): boolean { return this.children.size > 0; }

  /** 与界面「复制转码命令」显示的参数完全一致：同一份参数，手工执行与一键转码等价，便于对照排查。 */
  private static args(source: string, target: string): string[] {
    return ['-y', '-hide_banner', '-nostdin', '-loglevel', 'error', '-i', source, '-map', '0:v:0',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1',
      '-an', '-sn', target];
  }

  async run(sourcePath: unknown, grants: PathGrants): Promise<string> {
    // 源文件必须先经文件选择器授权：转码不能成为绕过授权去读取任意本机文件的手段。
    const source = await grants.require(sourcePath, ['video']);
    const { ffmpegPath } = await this.tools();
    if (!ffmpegPath) throw new DesktopError('media_runtime_missing', '还没有配置 FFmpeg 和 ffprobe，请到「设置 · 视频工具」完成配置后重试。');
    await mkdir(this.directory, { recursive: true });
    const target = path.join(this.directory, `${randomUUID()}.mp4`);
    try { await this.execute(ffmpegPath, VideoTranscoder.args(source, target)); }
    catch (error) { await this.discard(target); throw error; }
    return target;
  }

  private execute(ffmpeg: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      this.children.add(child);
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
      const finish = (error?: Error) => {
        clearTimeout(timer); this.children.delete(child);
        if (error) reject(error); else resolve();
      };
      // FFmpeg 的报错原文可能带本机绝对路径，只留最后一行进日志做线索，不整段回给界面。
      child.stderr?.on('data', chunk => { if (stderr.length < 4000) stderr += String(chunk); });
      child.once('error', () => finish(new DesktopError('media_runtime_missing', '本机 FFmpeg 无法启动，请到「设置 · 视频工具」重新选择。')));
      child.once('close', (code) => {
        if (code === 0) return finish();
        if (child.killed) return finish(new DesktopError('transcode_timeout', '转码耗时过长，已停止。可以只抽取其中一段，或改用图片导入。'));
        this.log(`视频转码未完成（退出码 ${code}）：${stderr.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] ?? '没有错误输出'}`);
        finish(new DesktopError('transcode_failed', '本机 FFmpeg 未能完成转码，可以复制命令到终端手动执行，或改用图片导入。'));
      });
    });
  }

  /** 只删除本类自己创建的临时副本：要求路径落在转码目录内且是同级普通文件名，避免误删任意文件。 */
  async discard(value: unknown): Promise<void> {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) return;
    const target = path.resolve(value);
    if (path.dirname(target).toLowerCase() !== path.resolve(this.directory).toLowerCase()) return;
    try { await unlink(target); } catch { /* 已经不存在即视为已删除，不对外报错。 */ }
  }

  /** 上次会话的副本对本进程没有意义（文件授权也随进程失效），启动时统一清扫，避免临时目录无限增长。 */
  async sweep(): Promise<void> {
    let names: string[];
    try { names = await readdir(this.directory); } catch { return; }
    for (const name of names) await this.discard(path.join(this.directory, name));
  }

  /** 退出时杀掉仍在跑的 FFmpeg，不留占着文件与磁盘的孤儿进程。 */
  stop(): void {
    for (const child of this.children) child.kill('SIGKILL');
    this.children.clear();
  }
}
