import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DesktopPreferences } from './storage';
import { ROOT_SUBDIRECTORY, StoragePathSettings, defaultRootFor, resolveStoragePaths, userFallbackRoot } from './storage-paths';

test('缺省存储根始终使用安装目录，旧用户目录只作为迁移候选', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autolabel-storage-paths-'));
  const previousLocalAppData = process.env.LOCALAPPDATA;
  const previousAppData = process.env.APPDATA;
  process.env.LOCALAPPDATA = path.join(root, 'local-app-data');
  process.env.APPDATA = path.join(root, 'app-data');
  try {
    const install = path.join(root, 'install');
    const dataDirectory = path.join(root, 'database');
    const preferences = new DesktopPreferences(path.join(root, 'settings.json'));
    await preferences.load();
    const legacyRoot = userFallbackRoot();
    await mkdir(path.join(legacyRoot, 'datasets'), { recursive: true });
    await writeFile(path.join(legacyRoot, 'datasets', 'legacy.txt'), 'legacy');

    const resolved = await resolveStoragePaths(preferences, install, dataDirectory);
    assert.equal(resolved.root, defaultRootFor(install));
    assert.equal(resolved.rootSource, 'default');

    const settings = new StoragePathSettings(preferences, () => install, () => dataDirectory);
    const migration = await settings.migration();
    assert.deepEqual(migration.candidates.map(item => item.kind), ['datasets']);
    assert.equal(migration.candidates[0].from, path.join(legacyRoot, 'datasets'));
    assert.equal(migration.candidates[0].to, path.join(install, ROOT_SUBDIRECTORY, 'datasets'));

    await settings.migrate();
    assert.equal(await readFile(path.join(install, ROOT_SUBDIRECTORY, 'datasets', 'legacy.txt'), 'utf8'), 'legacy');
  } finally {
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previousLocalAppData;
    if (previousAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = previousAppData;
    await rm(root, { recursive: true, force: true });
  }
});
