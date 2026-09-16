/**
 * 项目命名与同名判定。
 *
 * 欢迎页与会话页的拖放各自实现过一份「取所在文件夹名」，两处一旦不一致，
 * 同一批素材走不同入口就会落到不同项目上——正是「助手说项目里没素材」的成因之一。
 */

/** 从文件路径取所在文件夹名：`D:\图片\a.jpg` → `图片`。 */
export function folderName(file: string): string {
  const parts = file.split(/[\\/]/).filter(Boolean);
  const name = parts.length >= 2 ? parts[parts.length - 2] : '';
  return name.slice(0, 80) || '未命名项目';
}

/** 选中文件夹时用文件夹自己的名字：用 folderName 会取到上一级，与用户预期不符。 */
export function directoryName(directory: string): string {
  const parts = directory.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1]?.slice(0, 80) || '未命名项目';
}

export const baseName = (value: string) => value.split(/[\\/]/).filter(Boolean).pop() ?? value;

/** 桌面路径可能是文件也可能是文件夹：两种命名规则合一，调用方不必自己判断。 */
export function projectNameFor(value: string, isDirectory: boolean): string {
  return isDirectory ? directoryName(value) : folderName(value);
}

/** 同名项目直接复用，而不是再建一个：重复导入不该在侧栏留下两个外观一致的项目。 */
export function sameNameProject<T extends { name: string }>(projects: readonly T[], name: string): T | undefined {
  const trimmed = name.trim().slice(0, 80);
  return trimmed ? projects.find(item => item.name === trimmed) : undefined;
}
