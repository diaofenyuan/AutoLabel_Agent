import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

/**
 * 授权的持久化存储。
 *
 * 存用户数据目录而不是安装目录：这是一份随用户走的状态（换机、重装时应作废重新选择），
 * 且安装目录未必可写。文件用临时名 + rename 原子替换，避免写一半掉电留下半截 JSON
 * 导致下次启动授权全丢——那正是用户看到的「明明授权过又说没授权」。
 */
export interface GrantStore {
  load(): Promise<{ file: string; kind: string }[]>;
  save(entries: { file: string; kind: string }[]): Promise<void>;
}

export function grantStorePath(userData: string): string { return path.join(userData, 'path-grants.json'); }

/**
 * 上限防止文件无限增长：用户长期导入素材会累积上千条授权。
 * 超出后丢弃最旧的条目，并且只保留最近的记录；这不影响常用素材（最近授权的仍在列表里）。
 */
const MAX_ENTRIES = 2000;

export function createGrantStore(filename: string): GrantStore {
  return {
    async load() {
      const parsed = JSON.parse(await readFile(filename, 'utf8')) as { entries?: unknown };
      if (!Array.isArray(parsed?.entries)) return [];
      // 只接受结构正确的记录：损坏数据不该让整个授权表变成空壳后静默放行一切。
      return parsed.entries.filter((entry): entry is { file: string; kind: string } =>
        !!entry && typeof entry === 'object'
        && typeof (entry as { file?: unknown }).file === 'string'
        && typeof (entry as { kind?: unknown }).kind === 'string');
    },
    async save(entries) {
      await mkdir(path.dirname(filename), { recursive: true });
      const kept = entries.slice(-MAX_ENTRIES);
      const temporary = `${filename}.tmp`;
      await writeFile(temporary, JSON.stringify({ entries: kept }), 'utf8');
      await rename(temporary, filename);
    },
  };
}