import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EngineManager } from './engine';

// 存储与对话记录计划 5.4/5.5 的桌面接线：受管原图根来自存储设置的上传目录，缺省时保持旧行为。
test('受管原图根取桌面传入的上传目录，导入复制落在该目录', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'autolabel-materials-'));
  const dataDir = path.join(directory, 'data'), materials = path.join(directory, 'uploads');
  await mkdir(dataDir, { recursive: true });
  const engine = new EngineManager({
    packaged: false, root: process.cwd(), resources: '', dataDir, credentials: async () => [],
    materialsRoot: () => materials,
  });
  try {
    assert.equal((await engine.start()).state, 'ready');
    const image = path.join(directory, '样本.png');
    await copyFile(path.join(process.cwd(), 'shared', 'assets', 'example-street.png'), image);
    const project = await engine.request('project.create', { name: '落点验证', taskType: 'detect', classes: [{ id: 'item', name: '物品', color: '#3b82f6' }] }) as { id: string };
    const imported = await engine.request('asset.import', { projectId: project.id, paths: [image], mode: 'copy' }) as { assetIds: string[]; imported: number };
    assert.equal(imported.imported, 1);
    const asset = await engine.request('asset.get', { assetId: imported.assetIds[0] }) as { metadata: { sourcePath: string; importMode: string } };
    assert.equal(asset.metadata.importMode, 'copy');
    assert.equal(path.dirname(asset.metadata.sourcePath), materials);
    assert.ok(path.resolve(asset.metadata.sourcePath).startsWith(path.resolve(materials) + path.sep));
    // 数据目录内不再产生受管原图副本，避免同一份上传被写两处。
    const legacy = path.join(dataDir, 'originals');
    assert.equal(await import('node:fs/promises').then(module => module.readdir(legacy).catch(() => [] as string[])).then(entries => entries.length), 0);
  } finally {
    await engine.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('未配置上传目录时受管原图仍落在数据目录内', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'autolabel-materials-default-'));
  const dataDir = path.join(directory, 'data');
  const engine = new EngineManager({ packaged: false, root: process.cwd(), resources: '', dataDir, credentials: async () => [] });
  try {
    assert.equal((await engine.start()).state, 'ready');
    const image = path.join(directory, '样本.png');
    await copyFile(path.join(process.cwd(), 'shared', 'assets', 'example-street.png'), image);
    const project = await engine.request('project.create', { name: '缺省落点', taskType: 'detect', classes: [{ id: 'item', name: '物品' }] }) as { id: string };
    const imported = await engine.request('asset.import', { projectId: project.id, paths: [image], mode: 'copy' }) as { assetIds: string[] };
    const asset = await engine.request('asset.get', { assetId: imported.assetIds[0] }) as { metadata: { sourcePath: string } };
    assert.equal(path.dirname(asset.metadata.sourcePath), path.join(dataDir, 'originals'));
  } finally {
    await engine.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
