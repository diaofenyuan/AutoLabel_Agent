import { IMAGE_EXTENSION_LABEL, VIDEO_EXTENSION_LABEL } from '../../shared/mediaFormats';

/** 主进程按扩展名判定后的拒绝项：原因是机器可读的码，翻成人话是界面的事。 */
export interface DropRejection { name: string; reason: string }
export interface DroppedFiles {
  images: string[]; videos: string[]; directories: string[];
  /** 主进程判定为不支持（扩展名不认识或路径无效）。 */
  rejected: DropRejection[];
  /** 没拿到磁盘路径（浏览器演示）：只能按文件名如实提示。 */
  unresolved: string[];
  /** 超过单次上限时只回落一个数字，界面用它说「本次 N 个」而不是原始错误码。 */
  overLimit: { limit: number; received: number } | null;
}

export const emptyDroppedFiles: DroppedFiles = { images: [], videos: [], directories: [], rejected: [], unresolved: [], overLimit: null };

/**
 * 拒绝原因分组提示。
 *
 * 单条「暂不支持这些文件：images」既分不清是格式问题、路径问题还是数量问题，
 * 用户也就无从下手；而 `[INVALID_PAYLOAD] 拖入的文件数量无效` 更是把内部错误码摆到了脸上。
 * 这里按原因分别给出可执行的下一步，且保证不出现任何内部错误码。
 */
export function dropRejectionNotice(files: DroppedFiles): string | null {
  const parts: string[] = [];
  if (files.overLimit) parts.push(`一次最多拖入 ${files.overLimit.limit} 个文件，本次 ${files.overLimit.received} 个。请分批拖入，或改用「导入图片文件夹」。`);
  const unsupported = files.rejected.filter(item => item.reason === 'unsupported_extension');
  if (unsupported.length) {
    const shown = unsupported.slice(0, 5).map(item => `“${item.name}”`).join('、');
    parts.push(`不支持 ${shown}${unsupported.length > 5 ? ` 等 ${unsupported.length} 个文件` : ''}。可拖入的图片是 ${IMAGE_EXTENSION_LABEL}，视频是 ${VIDEO_EXTENSION_LABEL}；文件夹会被整目录导入。`);
  }
  const invalid = files.rejected.filter(item => item.reason !== 'unsupported_extension');
  if (invalid.length) parts.push(`${invalid.length} 项无法读取：路径无效或已失效，请重新拖入。`);
  if (files.unresolved.length) parts.push(`有 ${files.unresolved.length} 个文件没有拿到磁盘路径，请在桌面版本里重试。`);
  return parts.length ? parts.join(' ') : null;
}
