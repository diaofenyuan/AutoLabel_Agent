import { safeStorage } from 'electron';
import { readFile, open, mkdir, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DesktopError } from './validation';

interface VaultEntry { encryptedKey: string; credentialBindingVersion: string }
export interface StoredCredential { providerId: string; key: string; credentialBindingVersion: string }
const bindingPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CredentialVault {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(readonly filename: string, private protection: Pick<typeof safeStorage, 'isEncryptionAvailable' | 'encryptString' | 'decryptString'> = safeStorage) {}
  private async read(): Promise<{ entries: Record<string, unknown>; migrated: boolean }> {
    try {
      const result = JSON.parse(await readFile(this.filename, 'utf8'));
      if (![1, 2].includes(result.version) || !result.entries || typeof result.entries !== 'object' || Array.isArray(result.entries)) throw new Error();
      const entries: Record<string, unknown> = Object.create(null);
      for (const [providerId, value] of Object.entries(result.entries)) {
        entries[providerId] = result.version === 1 && typeof value === 'string'
          ? { encryptedKey: value, credentialBindingVersion: randomUUID() } : value;
      }
      return { entries, migrated: result.version === 1 };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: Object.create(null), migrated: false };
      throw new DesktopError('CREDENTIAL_STORE_DAMAGED', '凭据存储无法读取，请在模型中心重新配置凭据');
    }
  }
  private async write(entries: Record<string, unknown>): Promise<void> {
    await mkdir(path.dirname(this.filename), { recursive: true });
    const temporary = this.filename + '.tmp'; const file = await open(temporary, 'w', 0o600);
    try { await file.writeFile(JSON.stringify({ version: 2, entries })); await file.sync(); } finally { await file.close(); }
    await rename(temporary, this.filename);
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.pending.then(action);
    this.pending = operation.catch(() => undefined);
    return operation;
  }
  async set(providerId: string, key: string): Promise<{ credentialBindingVersion: string }> {
    return this.serial(async () => {
      if (!this.protection.isEncryptionAvailable()) throw new DesktopError('CREDENTIAL_PROTECTION_UNAVAILABLE', 'Windows 凭据保护不可用，未保存明文密钥');
      const { entries } = await this.read();
      const credentialBindingVersion = randomUUID();
      entries[providerId] = { encryptedKey: this.protection.encryptString(key).toString('base64'), credentialBindingVersion };
      await this.write(entries);
      return { credentialBindingVersion };
    });
  }
  async remove(providerId: string): Promise<{ removed: boolean }> {
    return this.serial(async () => {
      const { entries } = await this.read();
      if (!Object.prototype.hasOwnProperty.call(entries, providerId)) return { removed: false };
      delete entries[providerId];
      await this.write(entries);
      return { removed: true };
    });
  }
  /** 单条回读（解密明文）：设置页回显已保存的 API Key 用；失败视为未保存，不抛出。 */
  async get(providerId: string): Promise<string | null> {
    return this.serial(async () => {
      if (!this.protection.isEncryptionAvailable()) return null;
      const { entries } = await this.read();
      const entry = entries[providerId] as Partial<VaultEntry> | null;
      if (!entry || typeof entry.encryptedKey !== 'string') return null;
      try { return this.protection.decryptString(Buffer.from(entry.encryptedKey, 'base64')) || null; }
      catch { return null; }
    });
  }
  async all(): Promise<StoredCredential[]> {
    return this.serial(async () => {
      const { entries, migrated } = await this.read();
      // 旧记录的随机版本先原子持久化，重启与并发读取才能使用同一绑定身份。
      if (migrated) await this.write(entries);
      if (!this.protection.isEncryptionAvailable()) return [];
      const available: StoredCredential[] = [];
      for (const [providerId, value] of Object.entries(entries)) {
        const entry = value as Partial<VaultEntry> | null;
        if (!entry || typeof entry.encryptedKey !== 'string' || typeof entry.credentialBindingVersion !== 'string' || !bindingPattern.test(entry.credentialBindingVersion)) continue;
        try {
          const key = this.protection.decryptString(Buffer.from(entry.encryptedKey, 'base64'));
          if (key) available.push({ providerId, key, credentialBindingVersion: entry.credentialBindingVersion });
        } catch { /* 损坏条目需要重新绑定，不影响其他接口，也不为它伪造可复用版本。 */ }
      }
      return available;
    });
  }
  async providerIds(): Promise<string[]> { return (await this.all()).map(value => value.providerId); }
}
