import path from 'node:path';

/**
 * 路径身份键：判断两个路径是否指向同一处时使用。
 *
 * 必须与引擎 `LocalRuntime.pathKey` 的口径一致：Windows 文件系统大小写不敏感，身份按小写归一；
 * 其他平台大小写敏感，保留原始大小写。桌面端此前一律小写，等于假设「小写化后的字符串」仍是可用路径——
 * 一旦落到大小写敏感卷（Windows 的按目录区分大小写、网络共享、非 Windows 环境），
 * 持久化的授权键就不是真实路径：读取时取不到文件（授权被静默丢弃），
 * 文件授权还会把仅大小写不同的两个真实文件当成同一个而放行。
 */
export function pathIdentity(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}