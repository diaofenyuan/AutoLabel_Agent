import { copyFile, mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
const selected = process.env.AUTOLABEL_MEDIA_TOOLS_DIR;
if (!selected) throw new Error('请通过 AUTOLABEL_MEDIA_TOOLS_DIR 明确指定已验收的 FFmpeg 8.1.1 工具目录');
const source = await realpath(selected), destination = path.resolve('build/media-tools');
const versions = {};
// 发布和开发使用同一组固定工具，版本不匹配时停止，绝不回退到系统 PATH。
for (const tool of ['ffmpeg', 'ffprobe']) {
  const filename = path.join(source, `${tool}.exe`);
  if (!(await stat(filename)).isFile() || (await realpath(filename)).toLowerCase() !== filename.toLowerCase()) throw new Error(`媒体工具不是固定普通文件：${tool}`);
  const { stdout } = await promisify(execFile)(filename, ['-version'], { windowsHide: true, timeout: 10000, maxBuffer: 65536 });
  const line = stdout.split(/\r?\n/)[0];
  if (!new RegExp(`^${tool} version 8\\.1\\.1(?:[-+ ]|$)`).test(line)) throw new Error(`媒体工具版本不匹配：${line}`);
  versions[tool] = line;
}
await mkdir(destination, { recursive: true });
for (const tool of ['ffmpeg', 'ffprobe']) if (source.toLowerCase() !== destination.toLowerCase()) await copyFile(path.join(source, `${tool}.exe`), path.join(destination, `${tool}.exe`));
await writeFile(path.join(destination, 'versions.json'), JSON.stringify(versions, null, 2));
console.log(`FFmpeg/FFprobe 8.1.1 已准备：${destination}`);
