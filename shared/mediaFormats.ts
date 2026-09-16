/**
 * 素材扩展名的唯一来源：文件选择器、拖入白名单、目录扫描三处共用。
 *
 * 原先三处各写一份，后果是同一类素材走不同入口可用格式不同。真正危险的不是不一致本身，
 * 而是**引擎的目录扫描只认 jpg/jpeg/png**：按拖入白名单放开目录导入，会静默少收素材，
 * 用户看到「已导入 10 张」却不知道另外 3 张被吃掉了。因此这里以引擎实际能力为下限。
 *
 * 图片：jpg / jpeg / png —— 与 `Projects.java` 的目录扫描正则一致。
 * 视频：常见容器都交给 ffmpeg，能不能解由引擎在解码失败时如实报错，不在这里预先猜。
 */

export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png'] as const;
export const VIDEO_EXTENSIONS = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'm4v', 'flv', 'wmv', 'mpg', 'mpeg', 'ts'] as const;

/** 目录遍历参数与引擎保持一致（`Projects.java` 递归 12 层、单次上限 10000）。 */
export const DIRECTORY_SCAN_MAX_DEPTH = 12;
export const DIRECTORY_SCAN_MAX_FILES = 10000;

/** 面向用户的格式说明，避免各处自己拼一份而措辞不一。 */
export const IMAGE_EXTENSION_LABEL = 'JPG / JPEG / PNG';
export const VIDEO_EXTENSION_LABEL = 'MP4 / MKV / AVI / MOV / WEBM / M4V / FLV / WMV / MPG / MPEG / TS';

export function extensionOf(value: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(value);
  return match ? match[1].toLowerCase() : '';
}
export function isImagePath(value: string): boolean {
  return (IMAGE_EXTENSIONS as readonly string[]).includes(extensionOf(value));
}
export function isVideoPath(value: string): boolean {
  return (VIDEO_EXTENSIONS as readonly string[]).includes(extensionOf(value));
}
