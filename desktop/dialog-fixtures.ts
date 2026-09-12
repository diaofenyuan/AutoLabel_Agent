import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { DesktopError } from './validation';

const selectionKinds = z.enum(['images', 'video', 'model', 'python', 'ffmpeg', 'ffprobe', 'directory', 'backup', 'labels']);
const queueSchema = z.array(z.union([
  z.strictObject({ kind: selectionKinds, paths: z.array(z.string().min(1)).max(1000) }),
  z.strictObject({ kind: z.literal('save'), path: z.string().min(1).nullable() }),
])).max(128);

// 仅由开发版显式 --desktop-manual-check 创建；只代替系统选择器，不代替路径授权或引擎。
export class DialogFixtures {
  constructor(private userData: string) {}
  async take(kind: z.infer<typeof selectionKinds> | 'save'): Promise<string[]> {
    const queuePath = path.join(this.userData, 'dialog-fixtures.json');
    let queue: z.infer<typeof queueSchema>;
    try { queue = queueSchema.parse(JSON.parse(await readFile(queuePath, 'utf8'))); }
    catch { throw new DesktopError('TEST_DIALOG_MISSING', '开发验收未提供有效的对话框文件队列'); }
    const item = queue.shift();
    if (!item || item.kind !== kind) throw new DesktopError('TEST_DIALOG_ORDER', '开发验收对话框类型与队列不匹配');
    const selected = item.kind === 'save' ? item.path === null ? [] : [item.path] : item.paths;
    const root = await realpath(path.join(this.userData, 'fixtures'));
    if (path.relative(await realpath(this.userData), root).toLowerCase() !== 'fixtures') throw new DesktopError('TEST_DIALOG_PATH', '验收夹具目录不能重定向到隔离目录之外');
    const result: string[] = [];
    for (const value of selected) {
      if (!path.isAbsolute(value) || value.includes('\0')) throw new DesktopError('TEST_DIALOG_PATH', '验收文件必须使用隔离目录中的绝对路径');
      const resolved = kind === 'save' ? path.join(await realpath(path.dirname(value)), path.basename(value)) : await realpath(value);
      const relative = path.relative(root, resolved);
      if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw new DesktopError('TEST_DIALOG_PATH', '验收对话框不能选择隔离目录之外的文件');
      result.push(resolved);
    }
    await writeFile(queuePath, JSON.stringify(queue));
    return result;
  }
}
